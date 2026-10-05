import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import { customers, db, prices, subscriptions, users } from "@/db";
import { getPlanPrices, LOOKUP_KEYS, planForPriceId, resolvePlan } from "@/lib/catalog";
import { ensureCustomer, syncCustomerSubscriptions, syncSubscription } from "@/lib/sync";
import { fakeStripe, type FakeSub } from "./fake-stripe";
import { resetTables, testDbAvailable } from "./test-db";

const T0 = 1_800_000_000;

async function makeUser() {
  const id = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ id, name: "Demo Writer 1234", email: `demo-${id}@inkwell.test` })
    .returning();
  return user;
}

function sub(overrides: Partial<FakeSub> = {}): FakeSub {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "trialing",
    items: [{ id: "si_lic", priceId: "price_monthly", periodEnd: T0 + 14 * 86400 }],
    trial_end: T0 + 14 * 86400,
    latestInvoiceStatus: "paid",
    ...overrides,
  };
}

describe.skipIf(!testDbAvailable)("lib/sync (test DB)", () => {
  beforeEach(resetTables);

  it("upserts from a fresh retrieve: licensed price, item-level period end, metered item, invoice status", async () => {
    const user = await makeUser();
    await db.insert(customers).values({ userId: user.id, stripeCustomerId: "cus_1" });
    const { stripe } = fakeStripe({
      subs: new Map([
        [
          "sub_1",
          sub({
            status: "active",
            items: [
              { id: "si_meter", priceId: "price_credits", metered: true, periodEnd: T0 + 999 },
              { id: "si_lic", priceId: "price_monthly", periodEnd: T0 + 30 * 86400 },
            ],
          }),
        ],
      ]),
    });
    const row = await syncSubscription("sub_1", { stripe });
    expect(row).toMatchObject({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      priceId: "price_monthly",
      meteredItemId: "si_meter",
      latestInvoiceStatus: "paid",
    });
    expect(row?.currentPeriodEnd?.getTime()).toBe((T0 + 30 * 86400) * 1000);
    expect(row?.trialEnd?.getTime()).toBe((T0 + 14 * 86400) * 1000);
  });

  it("is idempotent: syncing twice leaves exactly one row", async () => {
    const user = await makeUser();
    await db.insert(customers).values({ userId: user.id, stripeCustomerId: "cus_1" });
    const { stripe } = fakeStripe({ subs: new Map([["sub_1", sub()]]) });
    await syncSubscription("sub_1", { stripe });
    await syncSubscription("sub_1", { stripe });
    expect(await db.select().from(subscriptions)).toHaveLength(1);
  });

  it("an older snapshot never overwrites a newer one", async () => {
    const user = await makeUser();
    await db.insert(customers).values({ userId: user.id, stripeCustomerId: "cus_1" });
    const subs = new Map([["sub_1", sub({ status: "active" })]]);
    const { stripe } = fakeStripe({ subs });
    await syncSubscription("sub_1", { stripe, now: () => new Date((T0 + 100) * 1000) });
    subs.set("sub_1", sub({ status: "trialing" }));
    const row = await syncSubscription("sub_1", { stripe, now: () => new Date((T0 + 50) * 1000) });
    expect(row?.status).toBe("active");
  });

  it("serializes concurrent syncs: a slow, older retrieve cannot land after a newer one (same second)", async () => {
    const user = await makeUser();
    await db.insert(customers).values({ userId: user.id, stripeCustomerId: "cus_1" });
    const subs = new Map([["sub_1", sub({ status: "trialing" })]]);
    const { stripe } = fakeStripe({ subs });
    const retrieve = stripe.subscriptions.retrieve.bind(stripe.subscriptions);
    let first = true;
    stripe.subscriptions.retrieve = (async (id: string) => {
      const snapshot = await retrieve(id);
      if (first) {
        first = false;
        subs.set("sub_1", sub({ status: "active" })); // Stripe moves on while the first response is in flight
        await new Promise((r) => setTimeout(r, 50));
      }
      return snapshot;
    }) as typeof stripe.subscriptions.retrieve;
    const now = () => new Date(T0 * 1000);
    const slow = syncSubscription("sub_1", { stripe, now });
    await new Promise((r) => setTimeout(r, 10));
    const fast = syncSubscription("sub_1", { stripe, now });
    await Promise.all([slow, fast]);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, "sub_1"));
    expect(row.status).toBe("active");
  });

  it("maps an unknown customer back to the user via customer.metadata.userId", async () => {
    const user = await makeUser();
    const { stripe } = fakeStripe({
      subs: new Map([["sub_1", sub({ customer: "cus_new" })]]),
      customers: new Map([["cus_new", { metadata: { userId: user.id } }]]),
    });
    const row = await syncSubscription("sub_1", { stripe });
    expect(row?.customerId).toBe("cus_new");
    const [c] = await db.select().from(customers).where(eq(customers.userId, user.id));
    expect(c.stripeCustomerId).toBe("cus_new");
  });

  it("ignores subscriptions of customers that are not ours", async () => {
    const { stripe } = fakeStripe({
      subs: new Map([["sub_x", sub({ id: "sub_x", customer: "cus_other" })]]),
      customers: new Map([["cus_other", { metadata: {} }]]),
    });
    expect(await syncSubscription("sub_x", { stripe })).toBeNull();
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("marks the subscription canceled when Stripe returns 404", async () => {
    const user = await makeUser();
    await db.insert(customers).values({ userId: user.id, stripeCustomerId: "cus_1" });
    const subs = new Map([["sub_1", sub({ status: "active" })]]);
    const { stripe } = fakeStripe({ subs });
    await syncSubscription("sub_1", { stripe });
    subs.delete("sub_1");
    const row = await syncSubscription("sub_1", { stripe });
    expect(row?.status).toBe("canceled");
  });

  it("syncCustomerSubscriptions syncs every subscription of the customer", async () => {
    const user = await makeUser();
    await db.insert(customers).values({ userId: user.id, stripeCustomerId: "cus_1" });
    const { stripe } = fakeStripe({
      subs: new Map([
        ["sub_a", sub({ id: "sub_a", status: "canceled" })],
        ["sub_b", sub({ id: "sub_b", status: "active" })],
        ["sub_z", sub({ id: "sub_z", customer: "cus_2" })],
      ]),
    });
    const rows = await syncCustomerSubscriptions("cus_1", { stripe });
    expect(rows.map((r) => r.id).sort()).toEqual(["sub_a", "sub_b"]);
  });

  it("ensureCustomer creates the Stripe customer once with metadata.userId and survives a race", async () => {
    const user = await makeUser();
    const fake = fakeStripe({});
    const [a, b] = await Promise.all([
      ensureCustomer(user, { stripe: fake.stripe }),
      ensureCustomer(user, { stripe: fake.stripe }),
    ]);
    expect(a).toBe(b);
    expect(fake.customers.get(a)?.metadata.userId).toBe(user.id);
    const again = await ensureCustomer(user, { stripe: fake.stripe });
    expect(again).toBe(a);
    expect(await db.select().from(customers)).toHaveLength(1);
  });

  it("getPlanPrices self-heals an empty prices table from Stripe lookup keys", async () => {
    const mk = (id: string, lookup: string, amount: number, interval: "month" | "year", usage = "licensed") =>
      ({
        id,
        object: "price",
        active: true,
        currency: "usd",
        lookup_key: lookup,
        unit_amount: amount,
        product: { id: "inkwell_pro", name: "Inkwell Pro" },
        recurring: { interval, usage_type: usage },
        metadata: lookup === LOOKUP_KEYS.monthly ? { trial_days: "14" } : {},
      }) as unknown as Stripe.Price;
    const fake = fakeStripe({
      prices: [
        mk("price_m", LOOKUP_KEYS.monthly, 1200, "month"),
        mk("price_y", LOOKUP_KEYS.yearly, 12000, "year"),
        mk("price_c", LOOKUP_KEYS.credits, 2, "month", "metered"),
      ],
    });
    const plans = await getPlanPrices(fake.stripe);
    expect(plans.monthly).toMatchObject({ id: "price_m", unitAmount: 1200, trialDays: 14, interval: "month" });
    expect(plans.yearly.id).toBe("price_y");
    expect(plans.credits?.usageType).toBe("metered");
    expect(planForPriceId("price_y")).toBe("yearly");
    expect(await resolvePlan("price_m")).toBe("monthly");
    await getPlanPrices(fake.stripe);
    expect(fake.calls.pricesList).toBe(1);
    expect(await db.select().from(prices)).toHaveLength(3);
  });
});
