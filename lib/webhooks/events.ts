import type Stripe from "stripe";

/** Every Stripe event type the webhook acts on. */
export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "price.created",
  "price.updated",
] as const satisfies readonly Stripe.Event.Type[];

export type HandledEventType = (typeof HANDLED_EVENTS)[number];

export function isHandledEvent(type: string): type is HandledEventType {
  return (HANDLED_EVENTS as readonly string[]).includes(type);
}
