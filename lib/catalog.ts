import type Stripe from "stripe";
import { inArray } from "drizzle-orm";
import { db, prices, type Price } from "@/db";
import { getStripe } from "@/lib/stripe";

export const LOOKUP_KEYS = {
  monthly: "inkwell_pro_monthly",
  yearly: "inkwell_pro_yearly",
  credits: "inkwell_ai_credits",
} as const;

export const METER_EVENT_NAME = "inkwell_ai_credits";
export const TRIAL_DAYS = 14;
export const PRODUCT_NAME = "Inkwell Pro";

export type Plan = "monthly" | "yearly";
export type PlanPrices = { monthly: Price; yearly: Price; credits: Price | null };

const priceCache = new Map<string, Plan>();

export function planFromLookupKey(lookupKey: string | null | undefined): Plan | null {
  if (lookupKey === LOOKUP_KEYS.monthly) return "monthly";
  if (lookupKey === LOOKUP_KEYS.yearly) return "yearly";
  return null;
}

function remember(rows: Price[]) {
  for (const row of rows) {
    const plan = planFromLookupKey(row.lookupKey);
    if (plan) priceCache.set(row.id, plan);
  }
}

/**
 * Synchronous lookup backed by a cache that getPlanPrices()/upsertPrice() fill.
 * Call `await getPlanPrices()` first in a request (you need it for price ids anyway),
 * or use resolvePlan() which reads the DB.
 */
export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  return priceCache.get(priceId) ?? null;
}

export async function resolvePlan(priceId: string | null | undefined): Promise<Plan | null> {
  if (!priceId) return null;
  const cached = planForPriceId(priceId);
  if (cached) return cached;
  await getPlanPrices();
  return planForPriceId(priceId);
}

export async function priceToRow(price: Stripe.Price, stripe: Stripe = getStripe()): Promise<Price> {
  let productName: string;
  let productId: string;
  if (typeof price.product === "string") {
    productId = price.product;
    const product = await stripe.products.retrieve(price.product);
    productName = product.name;
  } else {
    productId = price.product.id;
    productName = "name" in price.product && price.product.name ? price.product.name : PRODUCT_NAME;
  }
  const trialDays = price.metadata?.trial_days ? Number(price.metadata.trial_days) : null;
  return {
    id: price.id,
    lookupKey: price.lookup_key ?? null,
    productId,
    productName,
    unitAmount: price.unit_amount ?? null,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
    usageType: price.recurring?.usage_type ?? null,
    trialDays: Number.isFinite(trialDays) ? trialDays : null,
    active: price.active,
    metadata: { ...(price.metadata ?? {}) },
  };
}

/** Upsert a Stripe price into the prices table (used by the setup script and price.* webhooks). */
export async function upsertPrice(price: Stripe.Price, stripe: Stripe = getStripe()): Promise<Price> {
  const row = await priceToRow(price, stripe);
  const { id: _id, ...rest } = row;
  void _id;
  // A lookup key moves to the newest price when created with transfer_lookup_key; free it on the old row first.
  if (row.lookupKey) {
    await db.update(prices).set({ lookupKey: null }).where(inArray(prices.lookupKey, [row.lookupKey]));
  }
  await db.insert(prices).values(row).onConflictDoUpdate({ target: prices.id, set: rest });
  remember([row]);
  return row;
}

async function readPlanPrices(): Promise<Partial<Record<keyof typeof LOOKUP_KEYS, Price>>> {
  const keys = Object.values(LOOKUP_KEYS);
  const rows = await db.select().from(prices).where(inArray(prices.lookupKey, keys));
  remember(rows);
  const out: Partial<Record<keyof typeof LOOKUP_KEYS, Price>> = {};
  for (const [name, key] of Object.entries(LOOKUP_KEYS) as [keyof typeof LOOKUP_KEYS, string][]) {
    const row = rows.find((r) => r.lookupKey === key && r.active);
    if (row) out[name] = row;
  }
  return out;
}

/** Reads the prices table; if a plan price is missing (fresh DB), fetches by lookup key from Stripe and upserts. */
export async function getPlanPrices(stripe?: Stripe): Promise<PlanPrices> {
  let found = await readPlanPrices();
  if (!found.monthly || !found.yearly || !found.credits) {
    const client = stripe ?? getStripe();
    const list = await client.prices.list({
      lookup_keys: Object.values(LOOKUP_KEYS),
      active: true,
      expand: ["data.product"],
      limit: 10,
    });
    for (const price of list.data) await upsertPrice(price, client);
    found = await readPlanPrices();
  }
  if (!found.monthly || !found.yearly) {
    throw new Error("Inkwell plan prices not found. Run `pnpm tsx scripts/stripe-setup.ts` first.");
  }
  return { monthly: found.monthly, yearly: found.yearly, credits: found.credits ?? null };
}
