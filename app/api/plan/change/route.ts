import { z } from "zod";
import { readJson, withUser } from "@/lib/auth";
import { getPlanPrices } from "@/lib/catalog";
import { getCurrentSubscription, getEntitlement } from "@/lib/entitlement";
import { getStripe } from "@/lib/stripe";
import { syncSubscription } from "@/lib/sync";

export const runtime = "nodejs";

const Body = z.object({
  to: z.enum(["monthly", "yearly"]),
  prorationDate: z.number().int().positive(),
});
// Not past_due: a switch would put a new proration charge on the card that just failed. Fix the card first.
const CHANGEABLE = new Set(["active", "trialing"]);
// A preview is honoured for 30 minutes; after that the client must preview again.
const PREVIEW_TTL = 30 * 60;

/**
 * Switch monthly <-> yearly with the exact proration_date the user previewed.
 * proration_behavior "always_invoice" (the preview uses the same): the proration (credit for unused time +
 * remaining time on the new price) is invoiced and charged right away instead of sitting as pending items
 * until the next renewal, so the user pays exactly what the preview showed. Verified in test mode: an
 * upgrade charges the previewed amount; a downgrade's negative total lands as customer credit balance.
 * During a trial the subscription stays in trial (trial_end is untouched) and nothing is charged now;
 * the new price is billed when the trial ends.
 * payment_behavior "pending_if_incomplete": the switch is applied only if the proration invoice is paid.
 * If the charge fails (verified in test mode with a declining card), Stripe keeps the subscription active on
 * the old price with a pending_update; we answer 402 with the open invoice, whose payment applies the switch.
 * The default (allow_incomplete) would switch the price anyway and leave the subscription past_due.
 */
export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) return Response.json({ error: "Expected { to, prorationDate }" }, { status: 400 });
    const { to, prorationDate } = parsed.data;

    const now = Math.floor(Date.now() / 1000);
    if (prorationDate > now + 60 || prorationDate < now - PREVIEW_TTL) {
      return Response.json({ error: "This preview has expired. Preview the change again." }, { status: 409 });
    }

    const current = await getCurrentSubscription(user.id);
    if (current?.status === "past_due") {
      return Response.json(
        { error: "Your last payment failed. Update your card before switching plans.", portal: true },
        { status: 409 },
      );
    }
    if (!current || !CHANGEABLE.has(current.status)) {
      return Response.json({ error: "No subscription to change" }, { status: 409 });
    }
    const prices = await getPlanPrices();
    const target = prices[to];
    if (current.priceId === target.id) {
      return Response.json({ error: `You are already on the ${to} plan` }, { status: 409 });
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(current.id);
    const item = sub.items.data.find((i) => i.price.recurring?.usage_type !== "metered");
    if (!item) return Response.json({ error: "Subscription has no plan item" }, { status: 409 });

    const updated = await stripe.subscriptions.update(
      current.id,
      {
        items: [{ id: item.id, price: target.id }],
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
        payment_behavior: "pending_if_incomplete",
        expand: ["latest_invoice"],
      },
      { idempotencyKey: `inkwell-plan-change-v2-${current.id}-${target.id}-${prorationDate}` },
    );
    await syncSubscription(current.id);
    if (updated.pending_update) {
      const invoice = typeof updated.latest_invoice === "object" ? updated.latest_invoice : null;
      return Response.json(
        {
          error: "Your card was declined, so your plan was not changed. Pay the invoice or update your card to switch.",
          invoiceUrl: invoice?.hosted_invoice_url ?? null,
          portal: true,
          entitlement: await getEntitlement(user.id),
        },
        { status: 402 },
      );
    }
    return Response.json({ entitlement: await getEntitlement(user.id) });
  });
}
