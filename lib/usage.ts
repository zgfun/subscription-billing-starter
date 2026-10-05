import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, prices, usageEvents } from "@/db";
import { LOOKUP_KEYS } from "@/lib/catalog";
import { getCurrentSubscription } from "@/lib/entitlement";

export type UsageSummary = {
  creditsThisPeriod: number;
  unitAmountCents: number;
  estimatedCostCents: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date | null;
};

const DEFAULT_UNIT_CENTS = 2;

function periodStartFrom(end: Date | null, interval: string | null): Date {
  const start = new Date(end ?? Date.now());
  if (interval === "year") start.setUTCFullYear(start.getUTCFullYear() - 1);
  else if (end) start.setUTCMonth(start.getUTCMonth() - 1);
  else start.setUTCDate(start.getUTCDate() - 30);
  return start;
}

/** Credits sent to Stripe in the current billing period, from our usage_events log (DB only). */
export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const sub = await getCurrentSubscription(userId);
  const [planPrice] = sub
    ? await db.select({ interval: prices.interval }).from(prices).where(eq(prices.id, sub.priceId)).limit(1)
    : [];
  const [creditPrice] = await db
    .select({ unitAmount: prices.unitAmount, currency: prices.currency })
    .from(prices)
    .where(eq(prices.lookupKey, LOOKUP_KEYS.credits))
    .limit(1);

  const periodEnd = sub?.currentPeriodEnd ?? null;
  // Rows synced before current_period_start existed fall back to "end minus one interval".
  const periodStart = sub?.currentPeriodStart ?? periodStartFrom(periodEnd, planPrice?.interval ?? null);
  const [row] = await db
    .select({ total: sql<string | null>`sum(${usageEvents.quantity})` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), isNotNull(usageEvents.sentAt), gte(usageEvents.createdAt, periodStart)));

  const credits = Number(row?.total ?? 0);
  const unit = creditPrice?.unitAmount ?? DEFAULT_UNIT_CENTS;
  return {
    creditsThisPeriod: credits,
    unitAmountCents: unit,
    estimatedCostCents: credits * unit,
    currency: creditPrice?.currency ?? "usd",
    periodStart,
    periodEnd,
  };
}
