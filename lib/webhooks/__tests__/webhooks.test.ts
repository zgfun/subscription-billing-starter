import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { customers, db, prices, sideEffects, stripeEvents, subscriptions, users } from "@/db";
import { HANDLED_EVENTS } from "@/lib/webhooks/events";
import { handleEvent, retryFailedEvents } from "@/lib/webhooks/handle";
import { fakeStripe, fixture, makeSub, newWorld, prepareDb, uid, type World } from "./helpers";

const deferred: (() => Promise<void>)[] = [];
let world: World = newWorld();
let stripe = fakeStripe(world);

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => deferred.push(fn) }));

const dbReady = await prepareDb();
const SECRET = "whsec_test_fixture_secret";

const createdUsers: string[] = [];
const eventIds: string[] = [];
const sideEffectKeys: string[] = [];

beforeEach(() => {
  world = newWorld();
  stripe = fakeStripe(world);
  deferred.length = 0;
});

afterAll(async () => {
  if (!dbReady) return;
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  if (eventIds.length) await db.delete(stripeEvents).where(inArray(stripeEvents.id, eventIds));
  await db.delete(sideEffects).where(like(sideEffects.key, "%_test_%"));
  await db.delete(prices).where(like(prices.id, "price_test_%"));
});

/** A user with a linked Stripe customer, like ensureCustomer() leaves behind on demo login. */
async function seedUser(opts: { linkCustomer?: boolean } = {}) {
  const userId = randomUUID();
  const customerId = uid("cus");
  await db.insert(users).values({ id: userId, name: "Demo Writer 1234", email: `demo-${userId}@inkwell.test` });
  createdUsers.push(userId);
  if (opts.linkCustomer !== false) await db.insert(customers).values({ userId, stripeCustomerId: customerId });
  world.customers.set(customerId, { id: customerId, metadata: { userId } });
  return { userId, customerId, email: `demo-${userId}@inkwell.test` };
}

function track<T extends Stripe.Event>(event: T): T {
  eventIds.push(event.id);
  return event;
}

function subEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted" | "customer.subscription.trial_will_end",
  sub: Stripe.Subscription,
) {
  const event = track(fixture(type));
  event.data.object = structuredClone(sub);
  return event;
}

const ledger = (id: string) => db.select().from(stripeEvents).where(eq(stripeEvents.id, id));
const subRow = async (id: string) => (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0];

describe("HANDLED_EVENTS", () => {
  it("lists every handled type once, each with a recorded real fixture", () => {
    expect(new Set(HANDLED_EVENTS).size).toBe(HANDLED_EVENTS.length);
    expect(HANDLED_EVENTS.length).toBe(9);
    for (const type of HANDLED_EVENTS) {
      expect(existsSync(join(process.cwd(), "fixtures", "events", `${type}.json`)), type).toBe(true);
    }
  });
});

describe("POST /api/stripe/webhook", () => {
  const sign = (payload: string, secret = SECRET) => stripe.webhooks.generateTestHeaderString({ payload, secret });
  const request = (body: string, signature?: string) =>
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body,
      headers: signature ? { "stripe-signature": signature } : {},
    });

  it("rejects a bad signature with 400 and records nothing", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const event = fixture("customer.subscription.updated");
    const body = JSON.stringify(event);
    expect((await POST(request(body, sign(body, "whsec_wrong")))).status).toBe(400);
    expect((await POST(request(body))).status).toBe(400);
    const tampered = JSON.stringify({ ...event, type: "invoice.paid" });
    expect((await POST(request(tampered, sign(body)))).status).toBe(400);
    if (dbReady) expect(await ledger(event.id)).toHaveLength(0);
  });

  it.skipIf(!dbReady)("accepts a signed event, answers 200, and defers side effects to after()", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "trialing", trialEnd: 1_900_000_000 }));
    const event = subEvent("customer.subscription.trial_will_end", world.subs.get(subId)!);
    sideEffectKeys.push(`email:trial_will_end:${subId}:1900000000`);
    const body = JSON.stringify(event);

    const res = await POST(request(body, sign(body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "processed" });
    // [0] the trial email, [1] the retry sweep for previously failed events
    expect(deferred).toHaveLength(2);
    expect(await db.select().from(sideEffects).where(like(sideEffects.key, `%${subId}%`))).toHaveLength(0);
    await deferred[0]();
    expect(await db.select().from(sideEffects).where(like(sideEffects.key, `%${subId}%`))).toHaveLength(1);

    const replay = await POST(request(body, sign(body)));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "duplicate" });
  });
});

describe.skipIf(!dbReady)("handleEvent", () => {
  it("REPLAY: the same event twice → one ledger row, one subscription fetch/upsert, one email", async () => {
    const { customerId, email } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "past_due", latestInvoiceStatus: "open" }));
    const event = track(fixture("invoice.payment_failed"));
    const invoiceId = uid("in");
    Object.assign(event.data.object, {
      id: invoiceId,
      customer: customerId,
      attempt_count: 1,
      parent: { type: "subscription_details", quote_details: null, subscription_details: { subscription: subId, metadata: {} } },
    });
    world.invoices.set(invoiceId, {
      status: "open",
      amount_due: 1200,
      currency: "usd",
      hosted_invoice_url: "https://invoice.stripe.com/i/test",
      next_payment_attempt: 1_900_000_000,
    });
    const sendEmail = vi.fn(async () => ({ sent: true }));

    const first = await handleEvent(event, { stripe, sendEmail });
    const second = await handleEvent(structuredClone(event), { stripe, sendEmail });

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(await ledger(event.id)).toHaveLength(1);
    expect((await ledger(event.id))[0].processedAt).toBeInstanceOf(Date);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dunning", to: email, amount: 1200, invoiceUrl: "https://invoice.stripe.com/i/test" }),
    );
    expect(await db.select().from(sideEffects).where(like(sideEffects.key, `%${invoiceId}%`))).toHaveLength(1);
    expect((await subRow(subId)).status).toBe("past_due");
  });

  it("REPLAY under concurrency: parallel deliveries of one event process it exactly once", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "active" }));
    const event = subEvent("customer.subscription.updated", world.subs.get(subId)!);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => handleEvent(structuredClone(event), { stripe })));
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    // Losers see either a finished row ("duplicate", 200) or an in-flight one ("busy", 409 → Stripe retries).
    expect(results.filter((r) => r.status === "duplicate" || r.status === "busy")).toHaveLength(4);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    expect((await handleEvent(structuredClone(event), { stripe })).status).toBe("duplicate");
  });

  it("a redelivery while the first attempt is still in flight is 'busy' (409), not acknowledged", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const event = track(fixture("customer.subscription.updated"));
    await db.insert(stripeEvents).values({ id: event.id, type: event.type }); // claimed, never finished
    expect((await handleEvent(structuredClone(event), { stripe })).status).toBe("busy");
    const body = JSON.stringify(event);
    const res = await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        body,
        headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET }) },
      }),
    );
    expect(res.status).toBe(409);
    expect((await ledger(event.id))[0].processedAt).toBeNull();
  });

  it("a failed side effect un-marks the event, and the retry sweep sends it exactly once", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "trialing", trialEnd: 1_860_000_000 }));
    const event = subEvent("customer.subscription.trial_will_end", world.subs.get(subId)!);
    world.events.set(event.id, structuredClone(event));
    sideEffectKeys.push(`email:trial_will_end:${subId}:1860000000`);
    const tasks: (() => Promise<void>)[] = [];
    const failing = vi.fn(async () => {
      throw new Error("Resend 503");
    });

    expect((await handleEvent(event, { stripe, sendEmail: failing, defer: (t) => tasks.push(t) })).status).toBe("processed");
    expect((await ledger(event.id))[0].processedAt).not.toBeNull();
    await tasks[0]();
    const [row] = await ledger(event.id);
    expect(row.processedAt).toBeNull();
    expect(row.error).toMatch(/side effect failed: Resend 503/);
    expect(await db.select().from(sideEffects).where(like(sideEffects.key, `%${subId}%`))).toHaveLength(0);

    const sendEmail = vi.fn(async () => ({ sent: true }));
    await db.update(stripeEvents).set({ receivedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(stripeEvents.id, event.id));
    const swept = await retryFailedEvents({ limit: 50, deps: { stripe, sendEmail } });
    expect(swept).toContainEqual({ id: event.id, status: "processed" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await ledger(event.id))[0]).toMatchObject({ error: null });
    expect((await ledger(event.id))[0].processedAt).not.toBeNull();
    expect(await db.select().from(sideEffects).where(like(sideEffects.key, `%${subId}%`))).toHaveLength(1);
    expect((await handleEvent(structuredClone(event), { stripe, sendEmail })).status).toBe("duplicate");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("OUT-OF-ORDER: 'updated' before 'created' converges on the fresh retrieve, not the payloads", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    const created = subEvent("customer.subscription.created", makeSub({ id: subId, customer: customerId, status: "trialing", trialEnd: 1_800_000_000 }));
    const updated = subEvent("customer.subscription.updated", makeSub({ id: subId, customer: customerId, status: "active", cancelAtPeriodEnd: false }));
    // What Stripe says right now (later than both payloads): active, set to cancel at period end, yearly price.
    const latest = makeSub({ id: subId, customer: customerId, status: "active", cancelAtPeriodEnd: true, priceId: "price_latest_yearly", periodEnd: 1_950_000_000 });
    world.subs.set(subId, latest);

    expect((await handleEvent(updated, { stripe })).status).toBe("processed");
    expect((await handleEvent(created, { stripe })).status).toBe("processed");

    const row = await subRow(subId);
    expect(row).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: true,
      priceId: "price_latest_yearly",
      customerId,
      trialEnd: null,
    });
    expect(row.currentPeriodEnd?.getTime()).toBe(1_950_000_000 * 1000);
  });

  it("a failing handler is ledgered with the error, and Stripe's redelivery reprocesses it", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "active" }));
    const event = subEvent("customer.subscription.updated", world.subs.get(subId)!);
    stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error("Stripe API timeout"));

    const failed = await handleEvent(event, { stripe });
    expect(failed).toMatchObject({ status: "failed", error: "Stripe API timeout" });
    const [afterFailure] = await ledger(event.id);
    expect(afterFailure.processedAt).toBeNull();
    expect(afterFailure.error).toBe("Stripe API timeout");
    expect(await subRow(subId)).toBeUndefined();

    const retried = await handleEvent(structuredClone(event), { stripe });
    expect(retried.status).toBe("processed");
    const [afterRetry] = await ledger(event.id);
    expect(afterRetry.processedAt).toBeInstanceOf(Date);
    expect(afterRetry.error).toBeNull();
    expect((await subRow(subId)).status).toBe("active");

    expect((await handleEvent(structuredClone(event), { stripe })).status).toBe("duplicate");
    expect(await ledger(event.id)).toHaveLength(1);
  });

  it("unhandled event types are ignored but still ledgered (and their replays are duplicates)", async () => {
    const event = track({ ...fixture("price.created"), type: "customer.created" } as unknown as Stripe.Event);
    expect((await handleEvent(event, { stripe })).status).toBe("ignored");
    const [row] = await ledger(event.id);
    expect(row).toMatchObject({ type: "customer.created", error: null });
    expect(row.processedAt).toBeInstanceOf(Date);
    expect((await handleEvent(event, { stripe })).status).toBe("duplicate");
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("events for customers that aren't ours are ignored (shared test account noise)", async () => {
    const subId = uid("sub");
    const strangerCustomer = uid("cus");
    world.customers.set(strangerCustomer, { id: strangerCustomer, metadata: {} });
    world.subs.set(subId, makeSub({ id: subId, customer: strangerCustomer, status: "active" }));
    const event = subEvent("customer.subscription.updated", world.subs.get(subId)!);
    expect((await handleEvent(event, { stripe })).status).toBe("ignored");
    expect(await subRow(subId)).toBeUndefined();
  });

  it("invoice.payment_failed → past_due reflected, one dunning email; no email if the invoice is already paid", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "active" }));
    await handleEvent(subEvent("customer.subscription.created", world.subs.get(subId)!), { stripe });
    expect((await subRow(subId)).status).toBe("active");

    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "past_due", latestInvoiceStatus: "open" }));
    const invoiceId = uid("in");
    world.invoices.set(invoiceId, { status: "open", amount_due: 1200, currency: "usd", next_payment_attempt: null });
    const event = track(fixture("invoice.payment_failed"));
    Object.assign(event.data.object, {
      id: invoiceId,
      customer: customerId,
      attempt_count: 2,
      parent: { type: "subscription_details", quote_details: null, subscription_details: { subscription: subId, metadata: {} } },
    });
    const sendEmail = vi.fn(async () => ({ sent: true }));
    expect((await handleEvent(event, { stripe, sendEmail })).status).toBe("processed");
    expect(await subRow(subId)).toMatchObject({ status: "past_due", latestInvoiceStatus: "open" });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const late = track(fixture("invoice.payment_failed"));
    const paidInvoice = uid("in");
    world.invoices.set(paidInvoice, { status: "paid", amount_due: 1200, currency: "usd", next_payment_attempt: null });
    Object.assign(late.data.object, { id: paidInvoice, customer: customerId, parent: event.data.object.parent });
    expect((await handleEvent(late, { stripe, sendEmail })).status).toBe("processed");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("invoice.paid resolves the subscription via invoice.parent.subscription_details and re-syncs it", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "active", latestInvoiceStatus: "paid" }));
    const event = track(fixture("invoice.paid"));
    expect(event.data.object.parent?.subscription_details?.subscription).toBeTruthy();
    event.data.object.parent!.subscription_details!.subscription = subId;
    expect((await handleEvent(event, { stripe })).status).toBe("processed");
    expect(await subRow(subId)).toMatchObject({ status: "active", latestInvoiceStatus: "paid" });
  });

  it("customer.subscription.deleted → canceled", async () => {
    const { customerId } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "active" }));
    await handleEvent(subEvent("customer.subscription.created", world.subs.get(subId)!), { stripe });
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "canceled" }));
    const deleted = subEvent("customer.subscription.deleted", world.subs.get(subId)!);
    expect((await handleEvent(deleted, { stripe })).status).toBe("processed");
    expect((await subRow(subId)).status).toBe("canceled");
  });

  it("trial_will_end sends one trial-ending email while trialing", async () => {
    const { customerId, email } = await seedUser();
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "trialing", trialEnd: 1_850_000_000 }));
    const event = subEvent("customer.subscription.trial_will_end", world.subs.get(subId)!);
    const sendEmail = vi.fn(async () => ({ sent: true }));
    expect((await handleEvent(event, { stripe, sendEmail })).status).toBe("processed");
    expect((await handleEvent(event, { stripe, sendEmail })).status).toBe("duplicate");
    // A second, distinct event about the same trial (e.g. resent) still sends only once.
    const again = subEvent("customer.subscription.trial_will_end", world.subs.get(subId)!);
    expect((await handleEvent(again, { stripe, sendEmail })).status).toBe("processed");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: "trial_ending", to: email }));
  });

  it("checkout.session.completed maps the user via metadata.userId and syncs the subscription", async () => {
    const { userId, customerId } = await seedUser({ linkCustomer: false });
    world.customers.set(customerId, { id: customerId, metadata: {} }); // mapping must come from the session
    const subId = uid("sub");
    world.subs.set(subId, makeSub({ id: subId, customer: customerId, status: "trialing", trialEnd: 1_850_000_000 }));
    const event = track(fixture("checkout.session.completed"));
    Object.assign(event.data.object, {
      mode: "subscription",
      customer: customerId,
      subscription: subId,
      client_reference_id: userId,
      metadata: { userId },
    });
    expect((await handleEvent(event, { stripe })).status).toBe("processed");
    const [link] = await db.select().from(customers).where(eq(customers.userId, userId));
    expect(link.stripeCustomerId).toBe(customerId);
    expect((await subRow(subId)).status).toBe("trialing");
  });

  it("checkout.session.completed for a second parallel checkout cancels and refunds the newer subscription", async () => {
    const { userId, customerId } = await seedUser();
    const older = uid("sub");
    const newer = uid("sub");
    world.subs.set(older, makeSub({ id: older, customer: customerId, status: "active", created: 1_800_000_000 }));
    world.subs.set(
      newer,
      makeSub({ id: newer, customer: customerId, status: "active", created: 1_800_000_100, latestInvoiceStatus: "paid" }),
    );
    world.payments.set(`in_${newer}`, ["pi_test_dup"]);
    const completed = (subscription: string) => {
      const event = track(fixture("checkout.session.completed"));
      Object.assign(event.data.object, { mode: "subscription", customer: customerId, subscription, client_reference_id: userId, metadata: { userId } });
      return event;
    };

    expect((await handleEvent(completed(older), { stripe })).status).toBe("processed");
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect((await handleEvent(completed(newer), { stripe })).status).toBe("processed");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      newer,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `inkwell-dup-cancel-${newer}` },
    );
    expect(world.refunds).toEqual(["pi_test_dup"]);
    expect((await subRow(newer)).status).toBe("canceled");
    expect((await subRow(older)).status).toBe("active");
  });

  it("checkout.session.completed in payment mode (the recorded `stripe trigger` fixture) is ignored", async () => {
    const event = track(fixture("checkout.session.completed"));
    expect(event.data.object.mode).toBe("payment");
    expect((await handleEvent(event, { stripe })).status).toBe("ignored");
  });

  it("price.created/updated upserts Inkwell prices from a fresh retrieve and ignores others", async () => {
    const recorded = fixture("price.updated").data.object;
    const inkwellId = uid("price");
    const otherId = uid("price");
    world.prices.set(inkwellId, {
      ...recorded,
      id: inkwellId,
      lookup_key: null,
      unit_amount: 1200,
      currency: "usd",
      product: { id: "prod_inkwell", object: "product", name: "Inkwell Pro", metadata: { app: "inkwell" } } as unknown as Stripe.Product,
    });
    world.prices.set(otherId, { ...recorded, id: otherId, lookup_key: null, product: { id: "prod_x", object: "product", name: "Other", metadata: {} } as unknown as Stripe.Product });

    const created = track(fixture("price.created"));
    created.data.object = { ...created.data.object, id: inkwellId, unit_amount: 999 };
    expect((await handleEvent(created, { stripe })).status).toBe("processed");
    const [row] = await db.select().from(prices).where(eq(prices.id, inkwellId));
    expect(row).toMatchObject({ unitAmount: 1200, currency: "usd", productName: "Inkwell Pro" });

    const other = track(fixture("price.updated"));
    other.data.object = { ...other.data.object, id: otherId };
    expect((await handleEvent(other, { stripe })).status).toBe("ignored");
    expect(await db.select().from(prices).where(eq(prices.id, otherId))).toHaveLength(0);
  });
});
