import { z } from "zod";
import { readJson, withUser } from "@/lib/auth";
import { getPlanPrices } from "@/lib/catalog";
import { getCurrentSubscription } from "@/lib/entitlement";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

const Body = z.object({ to: z.enum(["monthly", "yearly"]) });
const CHANGEABLE = new Set(["active", "trialing"]);

const iso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) return Response.json({ error: "to must be \"monthly\" or \"yearly\"" }, { status: 400 });

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
    const target = prices[parsed.data.to];
    if (current.priceId === target.id) {
      return Response.json({ error: `You are already on the ${parsed.data.to} plan` }, { status: 409 });
    }

    // Money questions go to Stripe: the licensed item id is not mirrored in our DB, and the preview is Stripe's math.
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(current.id);
    const item = sub.items.data.find((i) => i.price.recurring?.usage_type !== "metered");
    if (!item) return Response.json({ error: "Subscription has no plan item" }, { status: 409 });

    // Preview with the SAME proration_behavior the change uses ("always_invoice"). Verified against test mode:
    // a "create_prorations" preview returns the NEXT renewal invoice (prorations + a full new period), which
    // overstates what is charged today; an "always_invoice" preview is exactly the invoice the change creates.
    const prorationDate = Math.floor(Date.now() / 1000);
    const preview = await stripe.invoices.createPreview({
      customer: current.customerId,
      subscription: current.id,
      subscription_details: {
        items: [{ id: item.id, price: target.id }],
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });

    const lines = preview.lines.data.map((line) => ({
      description: line.description ?? "",
      amount: line.amount,
      periodStart: iso(line.period?.start),
      periodEnd: iso(line.period?.end),
    }));
    const trialing = sub.status === "trialing";
    // During a trial the switch keeps the trial: nothing is due now, the new price is billed at trial end.
    const newPeriodEnd = preview.lines.data
      .filter((line) => line.amount >= 0)
      .reduce<number | null>((max, line) => Math.max(max ?? 0, line.period?.end ?? 0), null);

    return Response.json({
      amountDue: preview.amount_due,
      total: preview.total,
      // Downgrades (yearly -> monthly) produce a negative total: Stripe credits the customer balance.
      creditToBalance: preview.total < 0 ? -preview.total : 0,
      currency: preview.currency,
      lines,
      prorationDate,
      chargedNow: !trialing && preview.amount_due > 0,
      dueAt: trialing ? iso(sub.trial_end) : iso(prorationDate),
      nextPaymentAt: trialing ? iso(sub.trial_end) : iso(newPeriodEnd),
      trialing,
    });
  }, { rateLimit: { name: "plan-preview", perMinute: 20 } });
}
