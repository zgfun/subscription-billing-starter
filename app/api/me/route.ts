import { eq } from "drizzle-orm";
import { customers, db } from "@/db";
import { withUser } from "@/lib/auth";
import { getEntitlement } from "@/lib/entitlement";
import { syncCustomerSubscriptions } from "@/lib/sync";
import { getUsageSummary } from "@/lib/usage";

export const runtime = "nodejs";

const SYNC_INTERVAL_MS = 2000;
const lastSync = new Map<string, number>();

/**
 * GET /api/me                 -> { user, entitlement, usage } from the DB only.
 * GET /api/me?sync=<session>  -> "the webhook may be late" fallback after Checkout: syncs the CURRENT user's
 *   own Stripe customer once (throttled per user), then still answers from the DB. This is the only Stripe
 *   read in a request path; webhooks remain the primary way state arrives.
 */
export async function GET(req: Request) {
  return withUser(req, async (user) => {
    let synced = false;
    if (new URL(req.url).searchParams.has("sync")) {
      const now = Date.now();
      if (now - (lastSync.get(user.id) ?? 0) >= SYNC_INTERVAL_MS) {
        lastSync.set(user.id, now);
        if (lastSync.size > 10_000) lastSync.clear();
        const [customer] = await db.select().from(customers).where(eq(customers.userId, user.id)).limit(1);
        if (customer) {
          try {
            await syncCustomerSubscriptions(customer.stripeCustomerId);
            synced = true;
          } catch (error) {
            console.error("[me] fallback sync failed:", (error as Error).message);
          }
        }
      }
    }
    const [entitlement, usage] = await Promise.all([getEntitlement(user.id), getUsageSummary(user.id)]);
    return Response.json({
      user: { id: user.id, name: user.name, email: user.email },
      entitlement,
      usage,
      synced,
    });
  });
}
