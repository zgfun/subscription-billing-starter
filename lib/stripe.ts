import Stripe from "stripe";

const globalForStripe = globalThis as unknown as { stripe?: Stripe };

export function getStripe(): Stripe {
  if (globalForStripe.stripe) return globalForStripe.stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_...). This demo refuses live keys.");
  }
  globalForStripe.stripe = new Stripe(key, {
    maxNetworkRetries: 2,
    appInfo: { name: "inkwell-subscription-billing-starter" },
  });
  return globalForStripe.stripe;
}

export type { Stripe };
