// Idempotent Stripe catalog setup for Inkwell (test mode). Safe to re-run.
// Usage: pnpm tsx scripts/stripe-setup.ts
import { config } from "dotenv";
import { appendFileSync, readFileSync } from "node:fs";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { LOOKUP_KEYS, METER_EVENT_NAME, PRODUCT_NAME, TRIAL_DAYS, upsertPrice } from "@/lib/catalog";

config({ path: ".env.local", quiet: true });

const stripe = getStripe();
const PRO_PRODUCT_ID = "inkwell_pro";
const CREDITS_PRODUCT_ID = "inkwell_ai_credits";
const created: string[] = [];

function isMissing(err: unknown) {
  const e = err as { statusCode?: number; code?: string };
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

async function ensureProduct(id: string, name: string, description: string): Promise<Stripe.Product> {
  try {
    const product = await stripe.products.retrieve(id);
    if (!product.active || product.name !== name) {
      return stripe.products.update(id, { active: true, name, description, metadata: { app: "inkwell" } });
    }
    return product;
  } catch (err) {
    if (!isMissing(err)) throw err;
    created.push(`product ${id}`);
    return stripe.products.create({ id, name, description, metadata: { app: "inkwell" } });
  }
}

type PriceSpec = {
  lookupKey: string;
  product: string;
  unitAmount: number;
  interval: "month" | "year";
  meter?: string;
  nickname: string;
  metadata?: Record<string, string>;
};

function matches(price: Stripe.Price, spec: PriceSpec) {
  const product = typeof price.product === "string" ? price.product : price.product.id;
  return (
    price.active &&
    product === spec.product &&
    price.currency === "usd" &&
    price.unit_amount === spec.unitAmount &&
    price.recurring?.interval === spec.interval &&
    (price.recurring?.usage_type ?? "licensed") === (spec.meter ? "metered" : "licensed") &&
    (!spec.meter || price.recurring?.meter === spec.meter)
  );
}

async function ensurePrice(spec: PriceSpec): Promise<Stripe.Price> {
  const { data } = await stripe.prices.list({ lookup_keys: [spec.lookupKey], expand: ["data.product"], limit: 1 });
  const existing = data[0];
  if (existing && matches(existing, spec)) {
    const wanted = { app: "inkwell", ...(spec.metadata ?? {}) };
    const stale = Object.entries(wanted).some(([k, v]) => existing.metadata[k] !== v);
    return stale ? stripe.prices.update(existing.id, { metadata: wanted, expand: ["product"] }) : existing;
  }
  created.push(`price ${spec.lookupKey}`);
  const price = await stripe.prices.create({
    product: spec.product,
    currency: "usd",
    unit_amount: spec.unitAmount,
    nickname: spec.nickname,
    lookup_key: spec.lookupKey,
    transfer_lookup_key: true,
    recurring: {
      interval: spec.interval,
      ...(spec.meter ? { usage_type: "metered" as const, meter: spec.meter } : {}),
    },
    metadata: { app: "inkwell", ...(spec.metadata ?? {}) },
    expand: ["product"],
  });
  if (existing) await stripe.prices.update(existing.id, { active: false });
  return price;
}

async function ensureMeter(): Promise<Stripe.Billing.Meter> {
  for await (const meter of stripe.billing.meters.list({ limit: 100 })) {
    if (meter.event_name !== METER_EVENT_NAME) continue;
    if (meter.status === "inactive") return stripe.billing.meters.reactivate(meter.id);
    return meter;
  }
  created.push(`meter ${METER_EVENT_NAME}`);
  return stripe.billing.meters.create({
    display_name: "Inkwell AI credits",
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  });
}

async function ensurePortalConfiguration(monthlyId: string, yearlyId: string): Promise<Stripe.BillingPortal.Configuration> {
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const params = {
    name: "Inkwell customer portal",
    business_profile: { headline: "Inkwell — manage your Pro subscription" },
    default_return_url: `${appUrl}/dashboard`,
    metadata: { app: "inkwell" },
    features: {
      customer_update: { enabled: true, allowed_updates: ["email" as const, "name" as const] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" as const, proration_behavior: "none" as const },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price" as const],
        proration_behavior: "create_prorations" as const,
        products: [{ product: PRO_PRODUCT_ID, prices: [monthlyId, yearlyId] }],
      },
    },
  };
  let existingId = process.env.STRIPE_PORTAL_CONFIG_ID || null;
  if (existingId) {
    try {
      await stripe.billingPortal.configurations.retrieve(existingId);
    } catch (err) {
      if (!isMissing(err)) throw err;
      existingId = null;
    }
  }
  if (!existingId) {
    for await (const conf of stripe.billingPortal.configurations.list({ limit: 100 })) {
      if (conf.metadata?.app === "inkwell" && conf.active) {
        existingId = conf.id;
        break;
      }
    }
  }
  if (existingId) return stripe.billingPortal.configurations.update(existingId, { ...params, active: true });
  created.push("portal configuration");
  return stripe.billingPortal.configurations.create(params);
}

function saveEnvIfMissing(name: string, value: string) {
  const file = ".env.local";
  const content = readFileSync(file, "utf8");
  if (new RegExp(`^${name}=.+`, "m").test(content)) return false;
  appendFileSync(file, `${content.endsWith("\n") ? "" : "\n"}${name}=${value}\n`);
  return true;
}

async function main() {
  const pro = await ensureProduct(PRO_PRODUCT_ID, PRODUCT_NAME, "Unlimited documents, version history and export.");
  const credits = await ensureProduct(CREDITS_PRODUCT_ID, "Inkwell AI credits", "Metered AI writing credits, $0.02 each.");
  const meter = await ensureMeter();

  const monthly = await ensurePrice({
    lookupKey: LOOKUP_KEYS.monthly,
    product: pro.id,
    unitAmount: 1200,
    interval: "month",
    nickname: "Pro Monthly",
    metadata: { trial_days: String(TRIAL_DAYS) },
  });
  const yearly = await ensurePrice({
    lookupKey: LOOKUP_KEYS.yearly,
    product: pro.id,
    unitAmount: 12000,
    interval: "year",
    nickname: "Pro Yearly",
  });
  const creditsPrice = await ensurePrice({
    lookupKey: LOOKUP_KEYS.credits,
    product: credits.id,
    unitAmount: 2,
    interval: "month",
    meter: meter.id,
    nickname: "AI credits",
  });

  const portal = await ensurePortalConfiguration(monthly.id, yearly.id);
  const savedPortal = saveEnvIfMissing("STRIPE_PORTAL_CONFIG_ID", portal.id);

  let dbNote = "prices table: skipped (DATABASE_URL not set)";
  if (process.env.DATABASE_URL) {
    for (const price of [monthly, yearly, creditsPrice]) await upsertPrice(price, stripe);
    dbNote = "prices table: upserted 3 rows";
  }

  console.log("Inkwell Stripe setup (test mode)");
  console.log(`  product      ${pro.id}  (${pro.name})`);
  console.log(`  product      ${credits.id}  (${credits.name})`);
  console.log(`  meter        ${meter.id}  (event_name=${meter.event_name})`);
  console.log(`  price        ${monthly.id}  ${LOOKUP_KEYS.monthly}  $12.00/month, trial ${TRIAL_DAYS}d`);
  console.log(`  price        ${yearly.id}  ${LOOKUP_KEYS.yearly}  $120.00/year`);
  console.log(`  price        ${creditsPrice.id}  ${LOOKUP_KEYS.credits}  $0.02/credit (metered)`);
  console.log(`  portal       ${portal.id}${savedPortal ? "  (saved to .env.local as STRIPE_PORTAL_CONFIG_ID)" : ""}`);
  console.log(`  ${dbNote}`);
  console.log(created.length ? `  created: ${created.join(", ")}` : "  nothing created — everything already existed");
  process.exit(0);
}

main().catch((err) => {
  console.error("Stripe setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
