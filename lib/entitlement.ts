import { eq } from "drizzle-orm";
import { customers, db, prices, subscriptions, type Subscription } from "@/db";
import { planFromLookupKey, type Plan } from "@/lib/catalog";

export type Entitlement = {
  plan: Plan | null;
  active: boolean;
  trialing: boolean;
  pastDue: boolean;
  periodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  hasUsageAddon: boolean;
};

export const NO_ENTITLEMENT: Entitlement = {
  plan: null,
  active: false,
  trialing: false,
  pastDue: false,
  periodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  hasUsageAddon: false,
};

const RANK: Record<string, number> = {
  active: 0,
  trialing: 0,
  past_due: 1,
  unpaid: 2,
  paused: 2,
  incomplete: 3,
  canceled: 4,
  incomplete_expired: 5,
};

const ENDED = new Set(["canceled", "incomplete_expired"]);

type Row = Subscription & { lookupKey: string | null; interval: string | null };

export function pickBestSubscription<T extends Pick<Subscription, "status" | "currentPeriodEnd" | "updatedAt">>(
  rows: T[],
): T | null {
  const sorted = [...rows].sort((a, b) => {
    const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
    if (r !== 0) return r;
    const p = (b.currentPeriodEnd?.getTime() ?? 0) - (a.currentPeriodEnd?.getTime() ?? 0);
    if (p !== 0) return p;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  return sorted[0] ?? null;
}

export function entitlementFromRow(row: Row | null): Entitlement {
  if (!row || ENDED.has(row.status)) return { ...NO_ENTITLEMENT };
  const plan =
    planFromLookupKey(row.lookupKey) ?? (row.interval === "month" ? "monthly" : row.interval === "year" ? "yearly" : null);
  const active = row.status === "active" || row.status === "trialing";
  return {
    plan,
    active,
    trialing: row.status === "trialing",
    pastDue: row.status === "past_due" || row.status === "unpaid",
    periodEnd: row.currentPeriodEnd,
    trialEnd: row.status === "trialing" ? row.trialEnd : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    hasUsageAddon: active && row.meteredItemId != null,
  };
}

/** Access is decided from OUR database only. No Stripe call happens here, ever. */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const rows = await db
    .select({ sub: subscriptions, lookupKey: prices.lookupKey, interval: prices.interval })
    .from(subscriptions)
    .innerJoin(customers, eq(customers.stripeCustomerId, subscriptions.customerId))
    .leftJoin(prices, eq(prices.id, subscriptions.priceId))
    .where(eq(customers.userId, userId));
  const best = pickBestSubscription(rows.map((r) => ({ ...r.sub, lookupKey: r.lookupKey, interval: r.interval })));
  return entitlementFromRow(best);
}

/** The subscription row getEntitlement is based on (for routes that need its Stripe ids). */
export async function getCurrentSubscription(userId: string): Promise<Subscription | null> {
  const rows = await db
    .select({ sub: subscriptions })
    .from(subscriptions)
    .innerJoin(customers, eq(customers.stripeCustomerId, subscriptions.customerId))
    .where(eq(customers.userId, userId));
  return pickBestSubscription(rows.map((r) => r.sub));
}
