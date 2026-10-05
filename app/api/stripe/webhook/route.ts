import { after } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { handleEvent, retryFailedEvents } from "@/lib/webhooks/handle";

// Signature verification needs the exact raw bytes and Node crypto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "Webhook secret not configured" }, { status: 500 });
  if (!signature) return Response.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, secret);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const result = await handleEvent(event, { defer: (task) => after(task) });
  if (result.status === "failed") {
    console.error(`[webhook] ${event.type} ${event.id} failed: ${result.error}`);
    return Response.json({ received: true, status: "failed" }, { status: 500 });
  }
  if (result.status === "busy") {
    // Another attempt is mid-flight: don't acknowledge, so Stripe redelivers and the ledger decides then.
    return Response.json({ received: true, status: "busy" }, { status: 409 });
  }
  // Opportunistic sweep: re-runs events whose handler or deferred side effect (email) failed earlier.
  after(async () => {
    try {
      await retryFailedEvents();
    } catch (err) {
      console.error("[webhook] retry sweep failed:", err instanceof Error ? err.message : err);
    }
  });
  return Response.json({ received: true, status: result.status });
}
