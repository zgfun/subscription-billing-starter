import { and, eq, isNull, lt, ne } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { customers, db, usageEvents } from "@/db";
import { readJson, withUser } from "@/lib/auth";
import { getPlanPrices, METER_EVENT_NAME } from "@/lib/catalog";
import { getCurrentSubscription, getEntitlement } from "@/lib/entitlement";
import { getStripe } from "@/lib/stripe";
import { syncSubscription } from "@/lib/sync";
import { getUsageSummary } from "@/lib/usage";

export const runtime = "nodejs";

const Body = z.object({
  credits: z.number().int().min(1).max(100),
  // Client-generated per action and reused on retry: retrying the same request never double-counts.
  idempotencyKey: z.string().uuid(),
});

// A public demo: bounds the usage_events rows and meter events one demo user can create per billing period.
const CREDITS_PER_PERIOD_CAP = 10_000;

const isDuplicateIdentifier = (message: string | undefined) =>
  /identifier/i.test(message ?? "") && /already|duplicate|exists/i.test(message ?? "");

/** Send one usage row's meter event. A "already exists" answer means an earlier attempt reached Stripe. */
async function sendMeterEvent(stripe: Stripe, stripeCustomerId: string, row: { identifier: string; quantity: number; createdAt: Date }) {
  try {
    await stripe.billing.meterEvents.create({
      event_name: METER_EVENT_NAME,
      payload: { stripe_customer_id: stripeCustomerId, value: String(row.quantity) },
      identifier: row.identifier,
      // The original usage time, so a late re-send still lands in the period the credits were used in.
      timestamp: Math.floor(row.createdAt.getTime() / 1000),
    });
  } catch (error) {
    const e = error as { message?: string };
    if (!isDuplicateIdentifier(e.message)) {
      console.error("[usage] meter event failed:", e.message);
      return false;
    }
  }
  await db.update(usageEvents).set({ sentAt: new Date() }).where(eq(usageEvents.identifier, row.identifier));
  return true;
}

export async function GET(req: Request) {
  return withUser(req, async (user) => Response.json({ usage: await getUsageSummary(user.id) }));
}

/**
 * Records AI credit usage. The usage_events row (with its unique identifier) is written BEFORE
 * calling Stripe; the same identifier is sent as the meter event identifier, so a retry after a
 * crash or timeout re-sends the same event and Stripe de-duplicates it.
 */
export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) return Response.json(
        { error: "Expected { credits: 1..100, idempotencyKey: uuid }" },
        { status: 400 },
      );
    const { credits, idempotencyKey } = parsed.data;

    const entitlement = await getEntitlement(user.id);
    if (!entitlement.active) {
      return Response.json({ error: "AI credits need an active or trialing subscription" }, { status: 403 });
    }
    const sub = await getCurrentSubscription(user.id);
    if (!sub) return Response.json({ error: "No subscription" }, { status: 403 });

    const stripe = getStripe();
    if (!sub.meteredItemId) {
      const { credits: creditPrice } = await getPlanPrices();
      if (!creditPrice) return Response.json({ error: "AI credits are not configured" }, { status: 503 });
      try {
        await stripe.subscriptionItems.create(
          { subscription: sub.id, price: creditPrice.id, proration_behavior: "none" },
          { idempotencyKey: `inkwell-credits-item-${sub.id}` },
        );
      } catch (error) {
        // Most likely already attached (another tab, or our mirror is behind): the sync below decides.
        console.warn("[usage] attaching metered item:", (error as Error).message);
      }
      const synced = await syncSubscription(sub.id);
      if (!synced?.meteredItemId) {
        return Response.json({ error: "Could not add AI credits to this subscription" }, { status: 409 });
      }
    }

    const [customer] = await db.select().from(customers).where(eq(customers.userId, user.id)).limit(1);
    if (!customer) return Response.json({ error: "No Stripe customer" }, { status: 409 });

    const identifier = `inkwell-usage-${idempotencyKey}`;
    const [known] = await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.identifier, identifier)).limit(1);
    if (!known) {
      const { creditsThisPeriod } = await getUsageSummary(user.id);
      if (creditsThisPeriod + credits > CREDITS_PER_PERIOD_CAP) {
        return Response.json(
          { error: `The demo allows ${CREDITS_PER_PERIOD_CAP.toLocaleString("en-US")} AI credits per billing period.` },
          { status: 429 },
        );
      }
    }
    await db.insert(usageEvents).values({ userId: user.id, quantity: credits, identifier }).onConflictDoNothing();
    const [event] = await db.select().from(usageEvents).where(eq(usageEvents.identifier, identifier)).limit(1);
    if (!event || event.userId !== user.id) {
      return Response.json({ error: "Idempotency key already used" }, { status: 409 });
    }

    const duplicate = event.sentAt != null;
    if (!duplicate && !(await sendMeterEvent(stripe, customer.stripeCustomerId, event))) {
      return Response.json(
        { error: "Could not record usage with Stripe. Retry to resend it.", identifier },
        { status: 502 },
      );
    }

    // Rows whose earlier request died between our insert and Stripe's answer (tab closed, timeout) are
    // re-sent with their original identifier: Stripe either records them now or reports them as existing.
    const stranded = await db
      .select()
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, user.id),
          isNull(usageEvents.sentAt),
          ne(usageEvents.identifier, identifier),
          lt(usageEvents.createdAt, new Date(Date.now() - 60_000)),
        ),
      )
      .limit(5);
    for (const row of stranded) await sendMeterEvent(stripe, customer.stripeCustomerId, row);

    return Response.json({
      identifier,
      duplicate,
      credits: event.quantity,
      usage: await getUsageSummary(user.id),
    });
  }, { rateLimit: { name: "usage", perMinute: 30 } });
}
