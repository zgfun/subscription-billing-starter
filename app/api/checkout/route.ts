import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, subscriptions } from "@/db";
import { readJson, withUser } from "@/lib/auth";
import { getPlanPrices, TRIAL_DAYS } from "@/lib/catalog";
import { getCurrentSubscription } from "@/lib/entitlement";
import { getStripe } from "@/lib/stripe";
import { ensureCustomer, syncSubscription } from "@/lib/sync";

export const runtime = "nodejs";

const Body = z.object({ plan: z.enum(["monthly", "yearly"]) });

// A subscription in any of these states means the user should manage it in the portal, not buy another.
const BLOCKING = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

function appUrl(req: Request) {
  return (process.env.APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
}

/**
 * Duplicate-subscription guards, outermost first:
 * 1. our DB (fast path, the usual answer);
 * 2. Stripe's list of the customer's subscriptions: a Checkout completed seconds ago may not have reached us
 *    via webhook yet (back button from the success page). This is a money decision, so asking Stripe is
 *    right here; access is still never computed from it. Anything found is synced into the DB.
 * 3. older open Checkout Sessions of the customer are expired, so at most one can still be completed
 *    (two tabs). No idempotency key on create: it would hand back a session that step 3 just expired.
 * 4. if two sessions still complete (truly simultaneous requests), checkout.session.completed cancels and
 *    refunds the newer subscription (lib/webhooks/handle.ts cancelIfDuplicate).
 */
export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) return Response.json({ error: "plan must be \"monthly\" or \"yearly\"" }, { status: 400 });
    const { plan } = parsed.data;

    const current = await getCurrentSubscription(user.id);
    if (current && BLOCKING.has(current.status)) {
      return Response.json(
        { error: "You already have a subscription. Manage it in the billing portal.", portal: true },
        { status: 409 },
      );
    }

    const customer = await ensureCustomer(user);
    const stripe = getStripe();
    let live = false;
    for await (const sub of stripe.subscriptions.list({ customer, status: "all", limit: 20 })) {
      if (!BLOCKING.has(sub.status)) continue;
      live = true;
      await syncSubscription(sub.id, { stripe });
    }
    if (live) {
      return Response.json(
        { error: "You already have a subscription. Manage it in the billing portal.", portal: true },
        { status: 409 },
      );
    }
    for await (const open of stripe.checkout.sessions.list({ customer, status: "open", limit: 20 })) {
      await stripe.checkout.sessions.expire(open.id).catch((err: Error) => {
        console.warn(`[checkout] could not expire ${open.id}: ${err.message}`);
      });
    }
    // One trial per customer, decided from our DB: any past subscription that had a trial_end counts.
    const [previousTrial] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.customerId, customer), isNotNull(subscriptions.trialEnd)))
      .limit(1);
    const trial = plan === "monthly" && !previousTrial;

    const prices = await getPlanPrices();
    const base = appUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: prices[plan].id, quantity: 1 }],
      subscription_data: {
        ...(trial ? { trial_period_days: TRIAL_DAYS } : {}),
        metadata: { userId: user.id },
      },
      metadata: { userId: user.id },
      success_url: `${base}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/pricing?canceled=1`,
      allow_promotion_codes: false,
    });
    if (!session.url) return Response.json({ error: "Stripe did not return a Checkout URL" }, { status: 502 });
    return Response.json({ url: session.url, trial });
  }, { rateLimit: { name: "checkout", perMinute: 10 } });
}
