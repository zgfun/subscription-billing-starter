import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { customers, db, prices, subscriptions, users, type Subscription } from "@/db";
import { LOOKUP_KEYS } from "@/lib/catalog";
import { entitlementFromRow, getCurrentSubscription, getEntitlement, pickBestSubscription } from "@/lib/entitlement";
import { resetTables, testDbAvailable } from "./test-db";

const day = 86_400_000;
const base = (
  status: string,
  extra: Partial<Subscription & { lookupKey: string | null; interval: string | null }> = {},
) => ({
  id: `sub_${status}`,
  customerId: "cus_1",
  status,
  priceId: "price_m",
  currentPeriodStart: null,
  currentPeriodEnd: new Date(Date.now() + 10 * day),
  cancelAtPeriodEnd: false,
  trialEnd: null,
  meteredItemId: null,
  latestInvoiceStatus: null,
  stripeUpdatedAt: 1,
  updatedAt: new Date(),
  lookupKey: LOOKUP_KEYS.monthly as string | null,
  interval: "month" as string | null,
  ...extra,
});

describe("entitlement (pure)", () => {
  it("no subscription → no plan, no access", () => {
    expect(entitlementFromRow(null)).toMatchObject({ plan: null, active: false, pastDue: false });
  });

  it("trialing counts as active and exposes trialEnd", () => {
    const trialEnd = new Date(Date.now() + 12 * day);
    const e = entitlementFromRow(base("trialing", { trialEnd }));
    expect(e).toMatchObject({ plan: "monthly", active: true, trialing: true, pastDue: false, trialEnd });
  });

  it("past_due is flagged and not active", () => {
    expect(entitlementFromRow(base("past_due"))).toMatchObject({ plan: "monthly", active: false, pastDue: true });
  });

  it("canceled means no plan", () => {
    expect(entitlementFromRow(base("canceled"))).toMatchObject({ plan: null, active: false });
  });

  it("usage add-on only while active; yearly derived from lookup key or interval", () => {
    expect(entitlementFromRow(base("active", { meteredItemId: "si_1" })).hasUsageAddon).toBe(true);
    expect(entitlementFromRow(base("past_due", { meteredItemId: "si_1" })).hasUsageAddon).toBe(false);
    expect(entitlementFromRow(base("active", { lookupKey: LOOKUP_KEYS.yearly })).plan).toBe("yearly");
    expect(entitlementFromRow(base("active", { lookupKey: null, interval: "year" })).plan).toBe("yearly");
  });

  it("picks active/trialing over past_due over canceled", () => {
    expect(pickBestSubscription([base("canceled"), base("past_due"), base("active")])?.status).toBe("active");
    expect(pickBestSubscription([base("canceled"), base("past_due")])?.status).toBe("past_due");
    expect(pickBestSubscription([])).toBeNull();
  });
});

describe.skipIf(!testDbAvailable)("getEntitlement (test DB)", () => {
  beforeEach(resetTables);

  it("reads only the DB and picks the best subscription", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, name: "Demo Writer 1", email: `demo-${userId}@inkwell.test` });
    await db.insert(customers).values({ userId, stripeCustomerId: "cus_1" });
    await db.insert(prices).values({
      id: "price_y",
      lookupKey: LOOKUP_KEYS.yearly,
      productId: "inkwell_pro",
      productName: "Inkwell Pro",
      unitAmount: 12000,
      currency: "usd",
      interval: "year",
      usageType: "licensed",
    });
    const periodEnd = new Date("2027-01-01T00:00:00Z");
    await db.insert(subscriptions).values([
      { id: "sub_old", customerId: "cus_1", status: "canceled", priceId: "price_m" },
      {
        id: "sub_new",
        customerId: "cus_1",
        status: "active",
        priceId: "price_y",
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
      },
    ]);
    expect(await getEntitlement(userId)).toEqual({
      plan: "yearly",
      active: true,
      trialing: false,
      pastDue: false,
      periodEnd,
      trialEnd: null,
      cancelAtPeriodEnd: true,
      hasUsageAddon: false,
    });
    expect((await getCurrentSubscription(userId))?.id).toBe("sub_new");
  });

  it("a user without a customer has no entitlement", async () => {
    expect((await getEntitlement(randomUUID())).active).toBe(false);
  });
});
