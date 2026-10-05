import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { customers, db, stripeEvents, users, type Subscription } from "@/db";
import { upsertPrice } from "@/lib/catalog";
import { sendEmail as defaultSendEmail, type EmailMessage } from "@/lib/email";
import { getStripe } from "@/lib/stripe";
import { syncSubscription } from "@/lib/sync";
import { isHandledEvent } from "./events";
import { once } from "./side-effects";

/**
 * "busy": another attempt holds a fresh claim on this event and has not finished. The route answers 409 so
 * Stripe keeps retrying; the ledger decides on the next delivery (processed → duplicate, failed/stale → reprocess).
 */
export type HandleStatus = "processed" | "duplicate" | "busy" | "ignored" | "failed";
export type HandleResult = { status: HandleStatus; error?: string };

type Task = () => Promise<void>;

export type HandleDeps = {
  stripe?: Stripe;
  sync?: (subscriptionId: string) => Promise<Subscription | null>;
  sendEmail?: (msg: EmailMessage) => Promise<unknown>;
  now?: () => Date;
  /**
   * Schedules slow side effects. The webhook route passes Next's after() so they run once the 200 is sent.
   * Default: run them inline before handleEvent resolves (scripts, tests).
   */
  defer?: (task: Task) => void;
};

type Ctx = {
  stripe: () => Stripe;
  sync: (subscriptionId: string) => Promise<Subscription | null>;
  sendEmail: (msg: EmailMessage) => Promise<unknown>;
  tasks: Task[];
};

/** An in-flight claim older than this is treated as a crashed worker and may be taken over by a redelivery. */
const STALE_CLAIM = "2 minutes";

const idOf = (ref: string | { id: string } | null | undefined) => (ref == null ? null : typeof ref === "string" ? ref : ref.id);

/**
 * Insert-first idempotency. Inserting the event id is the lock: exactly one delivery wins.
 * A row is re-claimable only if its previous attempt failed (error set, never processed) or
 * its claim went stale, so Stripe's retry of a failed event reprocesses it, while a replay
 * of a processed event is a no-op. A replay that loses to an unfinished attempt is "busy".
 */
async function claim(event: Stripe.Event): Promise<"claimed" | "duplicate" | "busy"> {
  const rows = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoUpdate({
      target: stripeEvents.id,
      set: { error: null, receivedAt: sql`now()` },
      setWhere: sql`${stripeEvents.processedAt} is null and (${stripeEvents.error} is not null or ${stripeEvents.receivedAt} < now() - interval '${sql.raw(STALE_CLAIM)}')`,
    })
    .returning({ id: stripeEvents.id });
  if (rows.length > 0) return "claimed";
  const [existing] = await db
    .select({ processedAt: stripeEvents.processedAt })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, event.id));
  return existing?.processedAt ? "duplicate" : "busy";
}

/** Un-mark an event so the next delivery (or retryFailedEvents) runs it again. */
async function markFailed(eventId: string, message: string) {
  await db
    .update(stripeEvents)
    .set({ processedAt: null, error: message.slice(0, 1000) })
    .where(eq(stripeEvents.id, eventId));
}

async function userForCustomer(stripeCustomerId: string) {
  const [row] = await db
    .select({ userId: users.id, email: users.email })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(customers.stripeCustomerId, stripeCustomerId));
  return row ?? null;
}

/** Map a Checkout customer to our user by metadata.userId / client_reference_id (set by us), never by email. */
async function linkCustomer(userId: string | null | undefined, stripeCustomerId: string | null) {
  if (!userId || !stripeCustomerId || !/^[0-9a-f-]{36}$/i.test(userId)) return;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) return;
  await db.insert(customers).values({ userId, stripeCustomerId }).onConflictDoNothing();
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription);
}

function isInkwellPrice(price: Stripe.Price) {
  const product = typeof price.product === "string" ? null : price.product;
  const productApp = product && !product.deleted ? product.metadata?.app : undefined;
  return productApp === "inkwell" || price.lookup_key?.startsWith("inkwell_") === true;
}

const LIVE = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due", "unpaid", "paused"]);

/**
 * Safety net for two Checkout Sessions completed in parallel (two tabs, back button): the customer must end
 * up with one subscription. Stripe is asked (it is the source of truth for money), the earliest live
 * subscription is kept, and this one is canceled immediately and its payment refunded. Deterministic, so
 * the other session's event agrees; idempotency keys make retries and replays harmless.
 */
async function cancelIfDuplicate(subscriptionId: string, customerId: string, ctx: Ctx) {
  const stripe = ctx.stripe();
  const live: Stripe.Subscription[] = [];
  for await (const sub of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
    if (LIVE.has(sub.status)) live.push(sub);
  }
  const mine = live.find((s) => s.id === subscriptionId);
  if (!mine || live.length < 2) return;
  const keep = [...live].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))[0];
  if (keep.id === subscriptionId) return;

  console.warn(`[webhook] duplicate subscription ${subscriptionId} for ${customerId}; keeping ${keep.id}`);
  await stripe.subscriptions.cancel(
    subscriptionId,
    { invoice_now: false, prorate: false },
    { idempotencyKey: `inkwell-dup-cancel-${subscriptionId}` },
  );
  const invoiceId = idOf(mine.latest_invoice);
  if (!invoiceId) return;
  for await (const payment of stripe.invoicePayments.list({ invoice: invoiceId, status: "paid", limit: 10 })) {
    const paymentIntent = idOf(payment.payment.payment_intent);
    if (!paymentIntent) continue;
    try {
      await stripe.refunds.create({ payment_intent: paymentIntent }, { idempotencyKey: `inkwell-dup-refund-${paymentIntent}` });
    } catch (err) {
      if ((err as { code?: string }).code !== "charge_already_refunded") throw err;
    }
  }
}

async function dispatch(event: Stripe.Event, ctx: Ctx): Promise<"processed" | "ignored"> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription") return "ignored";
      const subscriptionId = idOf(session.subscription);
      if (!subscriptionId) return "ignored";
      const customerId = idOf(session.customer);
      await linkCustomer(session.metadata?.userId ?? session.client_reference_id, customerId);
      if (customerId) await cancelIfDuplicate(subscriptionId, customerId, ctx);
      return (await ctx.sync(subscriptionId)) ? "processed" : "ignored";
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      // The payload is only a pointer: state comes from a fresh retrieve inside sync.
      return (await ctx.sync(event.data.object.id)) ? "processed" : "ignored";

    case "customer.subscription.trial_will_end": {
      const row = await ctx.sync(event.data.object.id);
      if (!row) return "ignored";
      if (row.status !== "trialing") return "processed";
      const user = await userForCustomer(row.customerId);
      const trialKey = row.trialEnd ? Math.floor(row.trialEnd.getTime() / 1000) : "none";
      const key = `email:trial_will_end:${row.id}:${trialKey}`;
      ctx.tasks.push(async () => {
        await once(key, () =>
          ctx.sendEmail({ kind: "trial_ending", to: user?.email ?? "", trialEnd: row.trialEnd, idempotencyKey: key }),
        );
      });
      return "processed";
    }

    case "invoice.paid": {
      const subscriptionId = invoiceSubscriptionId(event.data.object);
      if (!subscriptionId) return "ignored";
      return (await ctx.sync(subscriptionId)) ? "processed" : "ignored";
    }

    case "invoice.payment_failed": {
      const payload = event.data.object;
      if (!payload.id) return "ignored";
      const subscriptionId = invoiceSubscriptionId(payload);
      const row = subscriptionId ? await ctx.sync(subscriptionId) : null;
      const customerId = row?.customerId ?? idOf(payload.customer);
      const user = customerId ? await userForCustomer(customerId) : null;
      if (!user) return "ignored";
      // Fresh read: if the invoice was paid or voided by the time we process this, no dunning email.
      const invoice = await ctx.stripe().invoices.retrieve(payload.id);
      if (invoice.status !== "open") return "processed";
      const key = `email:payment_failed:${invoice.id}:${payload.attempt_count}`;
      ctx.tasks.push(async () => {
        await once(key, () =>
          ctx.sendEmail({
            kind: "dunning",
            to: user.email,
            invoiceUrl: invoice.hosted_invoice_url ?? null,
            amount: invoice.amount_due,
            currency: invoice.currency,
            nextAttempt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
            idempotencyKey: key,
          }),
        );
      });
      return "processed";
    }

    case "price.created":
    case "price.updated": {
      const stripe = ctx.stripe();
      const price = await stripe.prices.retrieve(event.data.object.id, { expand: ["product"] });
      if (!isInkwellPrice(price)) return "ignored";
      await upsertPrice(price, stripe);
      return "processed";
    }

    default:
      return "ignored";
  }
}

/**
 * The webhook pipeline: claim (ledger insert) → dispatch (fresh reads, DB upserts) → mark processed → side effects.
 * Failure policy: the ledger row is KEPT with `error` set and processed_at null (visible on /admin), and the
 * route answers 500; Stripe's retry then re-claims that row (see claim()) and processes it again.
 * Side effects run after processed_at is set (after the 200). If one fails, the row is un-marked the same way
 * (processed_at null, error set), so a redelivery, `stripe events resend` or retryFailedEvents() re-runs the
 * event; once() keys guarantee whatever already went out is not sent again.
 */
export async function handleEvent(event: Stripe.Event, deps: HandleDeps = {}): Promise<HandleResult> {
  const now = deps.now ?? (() => new Date());
  const claimed = await claim(event);
  if (claimed !== "claimed") return { status: claimed };

  let client: Stripe | undefined = deps.stripe;
  const stripe = () => (client ??= getStripe());
  const ctx: Ctx = {
    stripe,
    sync: deps.sync ?? ((id) => syncSubscription(id, { stripe: stripe(), now })),
    sendEmail: deps.sendEmail ?? defaultSendEmail,
    tasks: [],
  };

  let outcome: "processed" | "ignored";
  try {
    outcome = isHandledEvent(event.type) ? await dispatch(event, ctx) : "ignored";
    await db.update(stripeEvents).set({ processedAt: now(), error: null }).where(eq(stripeEvents.id, event.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If even this write fails, the row stays "in flight" and becomes re-claimable once the claim goes stale.
    await markFailed(event.id, message).catch(() => undefined);
    return { status: "failed", error: message };
  }

  const run = async (task: Task): Promise<string | null> => {
    try {
      await task();
      return null;
    } catch (err) {
      const message = `side effect failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[webhook] ${event.id} ${message}`);
      await markFailed(event.id, message).catch(() => undefined);
      return message;
    }
  };
  for (const task of ctx.tasks) {
    if (deps.defer) {
      deps.defer(async () => void (await run(task)));
      continue;
    }
    const error = await run(task);
    if (error) return { status: "failed", error };
  }
  return { status: outcome };
}

/**
 * Re-runs ledger rows that failed (handler or side effect) or whose claim went stale, by re-fetching the
 * event from Stripe (events are kept 30 days). Webhook deliveries call it after responding, so a failed
 * email is retried without waiting for Stripe; claim() keeps concurrent sweeps from double-processing.
 */
export async function retryFailedEvents(
  opts: { limit?: number; olderThanSeconds?: number; deps?: HandleDeps } = {},
): Promise<{ id: string; status: HandleStatus }[]> {
  const { limit = 5, olderThanSeconds = 60, deps = {} } = opts;
  const rows = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(
      sql`${stripeEvents.processedAt} is null and ${stripeEvents.receivedAt} < now() - make_interval(secs => ${olderThanSeconds}) and (${stripeEvents.error} is not null or ${stripeEvents.receivedAt} < now() - interval '${sql.raw(STALE_CLAIM)}')`,
    )
    .orderBy(stripeEvents.receivedAt)
    .limit(limit);
  const out: { id: string; status: HandleStatus }[] = [];
  for (const { id } of rows) {
    const stripe = deps.stripe ?? getStripe();
    const event = await stripe.events.retrieve(id).catch(() => null);
    if (!event) continue;
    const result = await handleEvent(event, { ...deps, stripe });
    out.push({ id, status: result.status });
  }
  return out;
}
