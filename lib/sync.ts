import type Stripe from "stripe";
import { and, eq, lte, or, isNull, sql } from "drizzle-orm";
import { customers, db, subscriptions, users, type Subscription } from "@/db";
import { getStripe } from "@/lib/stripe";

type Deps = { stripe?: Stripe; now?: () => Date };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const toDate = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null);

function isMetered(item: Stripe.SubscriptionItem) {
  return item.price.recurring?.usage_type === "metered";
}

function isNotFound(err: unknown) {
  const e = err as { statusCode?: number; code?: string };
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

/**
 * Make sure the Stripe customer of a subscription maps to one of our users.
 * Mapping is by customer.metadata.userId (set when we create the customer), never by email.
 */
async function ensureCustomerRow(tx: Tx, stripeCustomerId: string, stripe: Stripe): Promise<boolean> {
  const [existing] = await tx
    .select({ id: customers.stripeCustomerId })
    .from(customers)
    .where(eq(customers.stripeCustomerId, stripeCustomerId));
  if (existing) return true;
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) return false;
  const userId = customer.metadata?.userId;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return false;
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) return false;
  await tx.insert(customers).values({ userId, stripeCustomerId }).onConflictDoNothing();
  const [row] = await tx
    .select({ id: customers.stripeCustomerId })
    .from(customers)
    .where(eq(customers.stripeCustomerId, stripeCustomerId));
  return Boolean(row);
}

export function subscriptionToRow(sub: Stripe.Subscription, snapshotAt: number) {
  const items = sub.items.data;
  const licensed = items.find((i) => !isMetered(i)) ?? items[0];
  const metered = items.find(isMetered);
  const invoice = sub.latest_invoice;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  return {
    id: sub.id,
    customerId,
    status: sub.status,
    priceId: licensed?.price.id ?? "",
    // Usage is billed on the metered item's period, so prefer it once the add-on is attached.
    currentPeriodStart: toDate((metered ?? licensed)?.current_period_start),
    currentPeriodEnd: toDate(licensed?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end || (sub.cancel_at != null && sub.status !== "canceled"),
    trialEnd: toDate(sub.trial_end),
    meteredItemId: metered?.id ?? null,
    latestInvoiceStatus: invoice && typeof invoice !== "string" ? (invoice.status ?? null) : null,
    stripeUpdatedAt: snapshotAt,
  };
}

/**
 * Fetch the subscription fresh from Stripe and upsert it. Event payloads are never trusted for state,
 * so out-of-order or replayed events always converge on Stripe's current view.
 * Syncs of one subscription are serialized with a transaction-scoped advisory lock: a later sync only
 * retrieves after an earlier one has written, so a slower, older retrieve can never land last.
 * stripeUpdatedAt (snapshot time, taken under the lock) additionally keeps older snapshots from overwriting.
 */
export async function syncSubscription(subscriptionId: string, deps: Deps = {}): Promise<Subscription | null> {
  const stripe = deps.stripe ?? getStripe();
  const now = deps.now ?? (() => new Date());
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inkwell-sync:${subscriptionId}`}))`);
    const snapshotAt = Math.floor(now().getTime() / 1000);
    let sub: Stripe.Subscription;
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const [row] = await tx
        .update(subscriptions)
        .set({ status: "canceled", cancelAtPeriodEnd: false, updatedAt: now() })
        .where(eq(subscriptions.id, subscriptionId))
        .returning();
      return row ?? null;
    }

    const row = subscriptionToRow(sub, snapshotAt);
    if (!(await ensureCustomerRow(tx, row.customerId, stripe))) return null;

    const { id, ...rest } = row;
    const [saved] = await tx
      .insert(subscriptions)
      .values({ ...row, updatedAt: now() })
      .onConflictDoUpdate({
        target: subscriptions.id,
        set: { ...rest, updatedAt: now() },
        setWhere: or(isNull(subscriptions.stripeUpdatedAt), lte(subscriptions.stripeUpdatedAt, snapshotAt)),
      })
      .returning();
    if (saved) return saved;
    const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
    return current ?? null;
  });
}

export async function syncCustomerSubscriptions(stripeCustomerId: string, deps: Deps = {}): Promise<Subscription[]> {
  const stripe = deps.stripe ?? getStripe();
  const out: Subscription[] = [];
  const seen = new Set<string>();
  for await (const sub of stripe.subscriptions.list({ customer: stripeCustomerId, status: "all", limit: 100 })) {
    seen.add(sub.id);
    const row = await syncSubscription(sub.id, deps);
    if (row) out.push(row);
  }
  const local = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.customerId, stripeCustomerId), sql`${subscriptions.status} <> 'canceled'`));
  for (const { id } of local) {
    if (seen.has(id)) continue;
    const row = await syncSubscription(id, deps);
    if (row) out.push(row);
  }
  return out;
}

export type CustomerUser = { id: string; name: string; email: string };

/**
 * Returns the user's Stripe customer id, creating the customer on first use.
 * The Stripe idempotency key makes concurrent first logins create one customer;
 * the unique constraint + re-read handles the DB side of the race.
 */
export async function ensureCustomer(
  user: CustomerUser,
  deps: { stripe?: Stripe; testClock?: string } = {},
): Promise<string> {
  const [existing] = await db.select().from(customers).where(eq(customers.userId, user.id));
  if (existing) return existing.stripeCustomerId;
  const stripe = deps.stripe ?? getStripe();
  const customer = await stripe.customers.create(
    {
      name: user.name,
      email: user.email,
      metadata: { userId: user.id, app: "inkwell" },
      ...(deps.testClock ? { test_clock: deps.testClock } : {}),
    },
    { idempotencyKey: `inkwell-customer-${user.id}${deps.testClock ? `-${deps.testClock}` : ""}` },
  );
  await db.insert(customers).values({ userId: user.id, stripeCustomerId: customer.id }).onConflictDoNothing();
  const [row] = await db.select().from(customers).where(eq(customers.userId, user.id));
  if (!row) throw new Error("Failed to persist Stripe customer");
  return row.stripeCustomerId;
}
