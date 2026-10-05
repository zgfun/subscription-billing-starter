// Saves the most recent real event of each given type from the Stripe test account
// into fixtures/events/<type>.json, with every email address replaced by demo@inkwell.test.
//
//   KEY=$(grep '^STRIPE_SECRET_KEY=' .env.local | cut -d= -f2-)
//   /Users/panczapeter/.local/bin/stripe trigger invoice.payment_failed --api-key "$KEY"
//   pnpm tsx scripts/record-fixtures.ts invoice.payment_failed customer.subscription.updated
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

async function main() {
  const types = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (types.length === 0) {
    console.error("usage: pnpm tsx scripts/record-fixtures.ts <event.type> [...]");
    process.exit(1);
  }
  const { getStripe } = await import("../lib/stripe");
  const stripe = getStripe();
  const dir = join("fixtures", "events");
  mkdirSync(dir, { recursive: true });
  for (const type of types) {
    const { data } = await stripe.events.list({ type, limit: 1 });
    const event = data[0];
    if (!event) {
      console.log(`- ${type}: no event found (trigger one first)`);
      continue;
    }
    const json = JSON.stringify(event, null, 2).replace(EMAIL, "demo@inkwell.test");
    const file = join(dir, `${type}.json`);
    writeFileSync(file, json + "\n");
    console.log(`- ${type}: ${event.id} -> ${file}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
