// End-to-end billing test against REAL Stripe test mode, driven by test clocks.
// No web server needed: events are pulled from the Stripe API and fed through
// handleEvent, the same function the webhook route calls (each one twice, to prove replay safety).
//
//   pnpm tsx scripts/test-clock.ts                 # both scenarios
//   pnpm tsx scripts/test-clock.ts --only=happy    # or --only=dunning
//   pnpm tsx scripts/test-clock.ts --keep-clock    # don't delete the clocks (inspect in the dashboard)
//   pnpm tsx scripts/test-clock.ts --send-emails   # really send emails via Resend (default: recorded, not sent)
//
// Uses DATABASE_URL from .env.local. Takes a few minutes: test clocks advance asynchronously.
import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type Stripe from "stripe";
import type { EmailMessage } from "../lib/email";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const DAY = 24 * 60 * 60;
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice("--only=".length);
const keepClock = args.has("--keep-clock");
const sendEmails = args.has("--send-emails");

type Check = { name: string; ok: boolean; detail?: string };
type ScenarioResult = { name: string; checks: Check[]; error?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`  ${msg}`);

async function main() {
  const [{ getStripe }, { getPlanPrices }, { syncSubscription, ensureCustomer }, { getEntitlement }, { handleEvent }, dbMod, orm] =
    await Promise.all([
      import("../lib/stripe"),
      import("../lib/catalog"),
      import("../lib/sync"),
      import("../lib/entitlement"),
      import("../lib/webhooks/handle"),
      import("../db"),
      import("drizzle-orm"),
    ]);
  const { db, users, subscriptions, stripeEvents, sideEffects } = dbMod;
  const { eq, inArray, sql } = orm;
  const stripe = getStripe();

  const { monthly } = await getPlanPrices();
  if (monthly.unitAmount !== 1200 || monthly.currency !== "usd") {
    throw new Error(`Unexpected monthly price ${monthly.id}: ${monthly.unitAmount} ${monthly.currency}`);
  }

  async function waitForClock(clockId: string, label: string) {
    const started = Date.now();
    for (;;) {
      const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
      if (clock.status === "ready") return clock;
      if (clock.status === "internal_failure") throw new Error(`Test clock ${clockId} failed`);
      if (Date.now() - started > 10 * 60_000) throw new Error(`Test clock ${clockId} still ${clock.status} after 10 min`);
      process.stdout.write(`\r  ${label}: clock ${clock.status} (${Math.round((Date.now() - started) / 1000)}s)   `);
      await sleep(3000);
    }
  }

  function belongsTo(event: Stripe.Event, customerId: string) {
    const obj = event.data.object as { id?: string; customer?: string | { id: string } | null };
    if (obj.id === customerId) return true;
    const c = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
    return c === customerId;
  }

  async function customerEvents(customerId: string, since: number) {
    const out: Stripe.Event[] = [];
    for await (const event of stripe.events.list({ created: { gte: since }, limit: 100 })) {
      if (belongsTo(event, customerId)) out.push(event);
    }
    return out.sort((a, b) => a.created - b.created);
  }

  async function waitForEvents(customerId: string, since: number, mustInclude: string) {
    const started = Date.now();
    for (;;) {
      const events = await customerEvents(customerId, since);
      if (events.some((e) => e.type === mustInclude)) {
        await sleep(5000);
        return customerEvents(customerId, since);
      }
      if (Date.now() - started > 3 * 60_000) {
        throw new Error(`No ${mustInclude} event for ${customerId} after 3 min (saw: ${events.map((e) => e.type).join(", ")})`);
      }
      await sleep(4000);
    }
  }

  async function runScenario(
    name: string,
    paymentMethod: string,
    assertAfter: (ctx: {
      checks: Check[];
      subscriptionId: string;
      userId: string;
      emails: EmailMessage[];
      events: Stripe.Event[];
    }) => Promise<void>,
  ): Promise<ScenarioResult> {
    const checks: Check[] = [];
    const check = (n: string, ok: boolean, detail?: string) => {
      checks.push({ name: n, ok, detail });
      log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? ` (${detail})` : ""}`);
    };
    let clockId: string | null = null;
    console.log(`\n== Scenario: ${name}`);
    try {
      const start = Math.floor(Date.now() / 1000);
      const clock = await stripe.testHelpers.testClocks.create({
        frozen_time: start,
        name: `inkwell-${name}-${randomUUID().slice(0, 8)}`,
      });
      clockId = clock.id;
      log(`test clock ${clock.id}`);

      const tag = randomUUID();
      const [user] = await db
        .insert(users)
        .values({ name: `Clock Writer ${randomInt(1000, 9999)}`, email: `demo-${tag}@inkwell.test` })
        .returning();
      const customerId = await ensureCustomer(user, { testClock: clock.id });
      log(`user ${user.id} -> customer ${customerId}`);

      const pm = await stripe.paymentMethods.attach(paymentMethod, { customer: customerId });
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });

      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: monthly.id }],
        trial_period_days: 14,
        metadata: { userId: user.id },
      });
      log(`subscription ${sub.id} (${sub.status})`);

      const row = await syncSubscription(sub.id);
      check("after create: DB subscription is trialing", row?.status === "trialing", row?.status);
      const ent0 = await getEntitlement(user.id);
      check(
        "after create: entitlement trialing + active, plan monthly",
        ent0.trialing && ent0.active && ent0.plan === "monthly",
        JSON.stringify({ plan: ent0.plan, active: ent0.active, trialing: ent0.trialing }),
      );
      check(
        "after create: trial ends in 14 days",
        !!ent0.trialEnd && Math.round((ent0.trialEnd.getTime() / 1000 - start) / DAY) === 14,
        ent0.trialEnd?.toISOString(),
      );

      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: start + 15 * DAY });
      await waitForClock(clock.id, "advancing 15 days");
      process.stdout.write("\n");

      const expected = name === "happy" ? "invoice.paid" : "invoice.payment_failed";
      const events = await waitForEvents(customerId, start - 5, expected);
      log(`${events.length} events for this customer: ${[...new Set(events.map((e) => e.type))].join(", ")}`);

      const emails: EmailMessage[] = [];
      const sendEmail = sendEmails
        ? undefined
        : async (msg: EmailMessage) => {
            emails.push(msg);
          };

      const firstPass: Record<string, number> = {};
      let replayDuplicates = 0;
      let firstPassFailures = 0;
      for (const event of events) {
        const first = await handleEvent(event, { sendEmail });
        firstPass[first.status] = (firstPass[first.status] ?? 0) + 1;
        if (first.status === "failed") firstPassFailures++;
        const second = await handleEvent(event, { sendEmail });
        if (second.status === "duplicate") replayDuplicates++;
      }
      log(`first pass: ${JSON.stringify(firstPass)}; replays answered "duplicate": ${replayDuplicates}/${events.length}`);
      check("no event failed processing", firstPassFailures === 0, `${firstPassFailures} failed`);
      check("every replay was answered as duplicate", replayDuplicates === events.length);

      const ids = events.map((e) => e.id);
      const ledger = await db
        .select({ id: stripeEvents.id, n: sql<number>`count(*)::int`, processed: sql<number>`count(${stripeEvents.processedAt})::int` })
        .from(stripeEvents)
        .where(inArray(stripeEvents.id, ids))
        .groupBy(stripeEvents.id);
      check(
        "exactly one ledger row per event id",
        ledger.length === ids.length && ledger.every((r) => r.n === 1),
        `${ledger.length} rows for ${ids.length} events`,
      );
      check("every ledger row is marked processed", ledger.every((r) => r.processed === 1));

      await assertAfter({ checks, subscriptionId: sub.id, userId: user.id, emails, events });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check("scenario ran to completion", false, message);
      return { name, checks, error: message };
    } finally {
      if (clockId && !keepClock) {
        await stripe.testHelpers.testClocks.del(clockId).then(
          () => log(`deleted test clock ${clockId} (and its customer)`),
          (e: unknown) => log(`could not delete test clock ${clockId}: ${e instanceof Error ? e.message : e}`),
        );
      }
    }
    return { name, checks };
  }

  const results: ScenarioResult[] = [];

  if (!only || only === "happy") {
    results.push(
      await runScenario("happy", "pm_card_visa", async ({ checks, subscriptionId, userId }) => {
        const check = (n: string, ok: boolean, detail?: string) => {
          checks.push({ name: n, ok, detail });
          log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? ` (${detail})` : ""}`);
        };
        const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
        check("after trial: DB subscription is active", row?.status === "active", row?.status);
        check("after trial: latest invoice paid (DB)", row?.latestInvoiceStatus === "paid", row?.latestInvoiceStatus ?? "null");
        const ent = await getEntitlement(userId);
        check(
          "after trial: entitlement active, not trialing, not past due",
          ent.active && !ent.trialing && !ent.pastDue,
          JSON.stringify({ active: ent.active, trialing: ent.trialing, pastDue: ent.pastDue }),
        );
        const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
        const clockNow = sub.test_clock
          ? (await stripe.testHelpers.testClocks.retrieve(typeof sub.test_clock === "string" ? sub.test_clock : sub.test_clock.id)).frozen_time
          : Math.floor(Date.now() / 1000);
        check("trial ended", !!sub.trial_end && sub.trial_end <= clockNow);
        const inv = sub.latest_invoice as Stripe.Invoice;
        check(
          "latest invoice paid 1200 usd",
          inv.status === "paid" && inv.amount_paid === 1200 && inv.currency === "usd",
          `${inv.status} ${inv.amount_paid} ${inv.currency}`,
        );
      }),
    );
  }

  if (!only || only === "dunning") {
    results.push(
      await runScenario("dunning", "pm_card_chargeCustomerFail", async ({ checks, subscriptionId, userId, emails, events }) => {
        const check = (n: string, ok: boolean, detail?: string) => {
          checks.push({ name: n, ok, detail });
          log(`${ok ? "ok  " : "FAIL"} ${n}${detail ? ` (${detail})` : ""}`);
        };
        const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
        check("after trial: DB subscription is past_due", row?.status === "past_due", row?.status);
        const ent = await getEntitlement(userId);
        check("after trial: entitlement pastDue", ent.pastDue, JSON.stringify({ active: ent.active, pastDue: ent.pastDue }));
        const failed = events.filter((e) => e.type === "invoice.payment_failed");
        const invoiceIds = [...new Set(failed.map((e) => (e.data.object as Stripe.Invoice).id))];
        const effects = await db
          .select()
          .from(sideEffects)
          .where(sql`${sideEffects.key} like ${`email:payment_failed:${invoiceIds[0] ?? "none"}:%`}`);
        check("exactly one dunning side effect recorded", effects.length === 1, effects.map((e) => e.key).join(", ") || "none");
        if (!sendEmails) {
          const dunning = emails.filter((e) => e.kind === "dunning");
          check("exactly one dunning email sent across both deliveries", dunning.length === 1, `${dunning.length}`);
        }
      }),
    );
  }

  const all = results.flatMap((r) => r.checks);
  const failed = all.filter((c) => !c.ok);
  console.log("\n==== TEST CLOCK REPORT ====");
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok).length;
    console.log(`${bad === 0 ? "PASS" : "FAIL"}  ${r.name}: ${r.checks.length - bad}/${r.checks.length} checks`);
    for (const c of r.checks.filter((c) => !c.ok)) console.log(`      - ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  console.log(failed.length === 0 ? `\nPASS (${all.length} checks)` : `\nFAIL (${failed.length} of ${all.length} checks failed)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
