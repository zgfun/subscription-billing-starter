import { and, eq, inArray, lt } from "drizzle-orm";
import { customers, db, users } from "@/db";
import { getStripe, type Stripe } from "@/lib/stripe";

export const DEMO_RETENTION_DAYS = 7;
const BATCH = 20;

/**
 * Deletes demo users older than DEMO_RETENTION_DAYS, at most BATCH per call. Their Stripe test customers are
 * deleted first (which also cancels their subscriptions); customers, subscriptions and usage_events rows go
 * with the user through ON DELETE CASCADE. The webhook ledger is not per user and is kept.
 * Returns the number of users deleted.
 */
export async function cleanupDemoUsers(
  deps: { stripe?: Stripe; now?: number; retentionDays?: number } = {},
): Promise<number> {
  const cutoff = new Date((deps.now ?? Date.now()) - (deps.retentionDays ?? DEMO_RETENTION_DAYS) * 86_400_000);
  const stale = await db
    .select({ id: users.id, stripeCustomerId: customers.stripeCustomerId })
    .from(users)
    .leftJoin(customers, eq(customers.userId, users.id))
    .where(and(eq(users.isDemo, true), lt(users.createdAt, cutoff)))
    .limit(BATCH);
  if (stale.length === 0) return 0;

  const stripe = deps.stripe ?? getStripe();
  for (const { stripeCustomerId } of stale) {
    if (!stripeCustomerId) continue;
    try {
      await stripe.customers.del(stripeCustomerId);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      // Already gone (e.g. a test clock deleted it). Anything else is logged; the DB row is removed regardless.
      if (err.code !== "resource_missing") console.warn(`[cleanup] could not delete ${stripeCustomerId}: ${err.message}`);
    }
  }
  const deleted = await db
    .delete(users)
    .where(inArray(users.id, stale.map((u) => u.id)))
    .returning({ id: users.id });
  return deleted.length;
}
