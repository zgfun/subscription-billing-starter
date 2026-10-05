import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Price } from "@/db";
import { stripeSubscription, type FakeSub } from "./fake-stripe";
import { testDbAvailable } from "./test-db";

const uid = () => crypto.randomUUID().slice(0, 8);
const PRICES = {
  monthly: `price_monthly_${uid()}`,
  yearly: `price_yearly_${uid()}`,
  credits: `price_credits_${uid()}`,
};

function priceRow(id: string, lookupKey: string, unitAmount: number, interval: string, usageType = "licensed"): Price {
  return {
    id,
    lookupKey,
    productId: "prod_test",
    productName: "Inkwell Pro",
    unitAmount,
    currency: "usd",
    interval,
    usageType,
    trialDays: null,
    active: true,
    metadata: {},
  };
}

type Call = { method: string; params: unknown; options?: unknown };

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  subs: new Map<string, unknown>(),
  meterFailuresLeft: 0,
  declineNextUpdate: false,
  openSessions: [] as string[],
  n: 0,
}));

function callsOf(method: string) {
  return fake.calls.filter((c) => c.method === method);
}

function asyncList<T>(data: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* data;
    },
  };
}

const fakeClient = {
  customers: {
    create: async (params: { metadata: Record<string, string> }, options?: unknown) => {
      fake.calls.push({ method: "customers.create", params, options });
      return { id: `cus_route_${++fake.n}_${uid()}`, object: "customer", metadata: params.metadata };
    },
  },
  checkout: {
    sessions: {
      create: async (params: unknown, options?: unknown) => {
        fake.calls.push({ method: "checkout.sessions.create", params, options });
        return { id: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" };
      },
      list: (params: { customer: string; status: string }) => {
        fake.calls.push({ method: "checkout.sessions.list", params });
        return asyncList(fake.openSessions.map((id) => ({ id, object: "checkout.session", status: "open" })));
      },
      expire: async (id: string) => {
        fake.calls.push({ method: "checkout.sessions.expire", params: id });
        fake.openSessions = fake.openSessions.filter((s) => s !== id);
        return { id, status: "expired" };
      },
    },
  },
  billingPortal: {
    sessions: {
      create: async (params: unknown) => {
        fake.calls.push({ method: "billingPortal.sessions.create", params });
        return { url: "https://billing.stripe.test/p/session" };
      },
    },
  },
  subscriptions: {
    retrieve: async (id: string) => {
      fake.calls.push({ method: "subscriptions.retrieve", params: id });
      const sub = fake.subs.get(id) as FakeSub | undefined;
      if (!sub) throw Object.assign(new Error("No such subscription"), { statusCode: 404, code: "resource_missing" });
      return stripeSubscription(sub);
    },
    list: (params: { customer: string }) => {
      fake.calls.push({ method: "subscriptions.list", params });
      const subs = [...fake.subs.values()] as FakeSub[];
      return asyncList(subs.filter((s) => s.customer === params.customer).map(stripeSubscription));
    },
    update: async (id: string, params: { items: { id: string; price: string }[] }, options?: unknown) => {
      fake.calls.push({ method: "subscriptions.update", params: { id, ...params }, options });
      const sub = fake.subs.get(id) as FakeSub;
      if (fake.declineNextUpdate) {
        // pending_if_incomplete + a declined proration charge: price unchanged, update parked as pending.
        fake.declineNextUpdate = false;
        return {
          ...stripeSubscription(sub),
          pending_update: { expires_at: Math.floor(Date.now() / 1000) + 82800 },
          latest_invoice: { id: "in_open", object: "invoice", status: "open", hosted_invoice_url: "https://invoice.stripe.test/i/open" },
        };
      }
      for (const change of params.items) {
        const item = sub.items.find((i) => i.id === change.id);
        if (item) item.priceId = change.price;
      }
      return stripeSubscription(sub);
    },
  },
  subscriptionItems: {
    create: async (params: { subscription: string; price: string }, options?: unknown) => {
      fake.calls.push({ method: "subscriptionItems.create", params, options });
      const sub = fake.subs.get(params.subscription) as FakeSub;
      const id = `si_metered_${uid()}`;
      sub.items.push({ id, priceId: params.price, metered: true, periodEnd: sub.items[0].periodEnd });
      return { id };
    },
  },
  invoices: {
    createPreview: async (params: unknown) => {
      fake.calls.push({ method: "invoices.createPreview", params });
      const now = Math.floor(Date.now() / 1000);
      return {
        amount_due: 10800,
        total: 10800,
        currency: "usd",
        next_payment_attempt: null,
        lines: {
          data: [
            { description: "Unused time on Pro Monthly", amount: -1200, period: { start: now, end: now + 86400 * 30 } },
            { description: "1 × Inkwell Pro (at $120.00 / year)", amount: 12000, period: { start: now, end: now + 86400 * 365 } },
          ],
        },
      };
    },
  },
  billing: {
    meterEvents: {
      create: async (params: unknown) => {
        fake.calls.push({ method: "billing.meterEvents.create", params });
        if (fake.meterFailuresLeft > 0) {
          fake.meterFailuresLeft--;
          throw Object.assign(new Error("Network error"), { type: "StripeConnectionError" });
        }
        return { object: "billing.meter_event" };
      },
    },
  },
};

vi.mock("@/lib/stripe", () => ({ getStripe: () => fakeClient }));
vi.mock("@/lib/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog")>();
  return {
    ...actual,
    getPlanPrices: async () => ({
      monthly: priceRow(PRICES.monthly, actual.LOOKUP_KEYS.monthly, 1200, "month"),
      yearly: priceRow(PRICES.yearly, actual.LOOKUP_KEYS.yearly, 12000, "year"),
      credits: priceRow(PRICES.credits, actual.LOOKUP_KEYS.credits, 2, "month", "metered"),
    }),
  };
});

const { SESSION_COOKIE, signSession, verifySession, readSessionFromRequest } = await import("@/lib/session");
const { proxy } = await import("@/proxy");

async function cookieFor(userId: string) {
  return `${SESSION_COOKIE}=${await signSession(userId)}`;
}

function post(path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string) {
  return new Request(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.meterFailuresLeft = 0;
  fake.declineNextUpdate = false;
  fake.openSessions = [];
});

describe("session cookie", () => {
  it("round-trips a signed session", async () => {
    const token = await signSession("user-1");
    expect(await verifySession(token)).toEqual({ userId: "user-1" });
  });

  it("rejects tampered and expired tokens", async () => {
    const token = await signSession("user-1");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "user-2", e: 9999999999 })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`)).toBeNull();
    expect(await verifySession(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(await verifySession("garbage")).toBeNull();
    const old = await signSession("user-1", Date.now() - 8 * 24 * 3600 * 1000);
    expect(await verifySession(old)).toBeNull();
  });

  it("reads the session from a request cookie header", async () => {
    const req = get("/api/me", `other=1; ${await cookieFor("user-9")}`);
    expect(await readSessionFromRequest(req)).toEqual({ userId: "user-9" });
  });
});

describe("proxy", () => {
  it("redirects anonymous page requests to /", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/dashboard"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("returns 401 JSON for anonymous API requests", async () => {
    for (const path of ["/api/me", "/api/checkout", "/api/plan/preview", "/api/usage", "/api/portal"]) {
      const res = await proxy(new NextRequest(`http://localhost:3000${path}`, { method: "POST" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Not signed in" });
    }
  });

  it("rejects a forged cookie and lets a valid one through", async () => {
    const bad = await proxy(
      new NextRequest("http://localhost:3000/api/me", { headers: { cookie: `${SESSION_COOKIE}=abc.def` } }),
    );
    expect(bad.status).toBe(401);
    const ok = await proxy(new NextRequest("http://localhost:3000/dashboard", { headers: { cookie: await cookieFor("u") } }));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
  });
});

describe.skipIf(!testDbAvailable)("route handlers (test DB)", async () => {
  const { db, users, customers, subscriptions, usageEvents } = await import("@/db");
  const demo = await import("@/app/api/demo/route");
  const checkout = await import("@/app/api/checkout/route");
  const portal = await import("@/app/api/portal/route");
  const me = await import("@/app/api/me/route");
  const usage = await import("@/app/api/usage/route");
  const preview = await import("@/app/api/plan/preview/route");
  const change = await import("@/app/api/plan/change/route");

  async function makeUser() {
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, name: "Route Tester", email: `demo-${id}@inkwell.test` });
    return { id, cookie: await cookieFor(id) };
  }

  async function makeCustomer(userId: string) {
    const stripeCustomerId = `cus_route_${uid()}`;
    await db.insert(customers).values({ userId, stripeCustomerId });
    return stripeCustomerId;
  }

  async function makeSub(customer: string, opts: Partial<FakeSub> & { status: string; priceId?: string }) {
    const id = `sub_route_${uid()}`;
    const periodEnd = Math.floor(Date.now() / 1000) + 86400 * 20;
    const sub: FakeSub = {
      id,
      customer,
      status: opts.status,
      items: opts.items ?? [{ id: `si_${uid()}`, priceId: opts.priceId ?? PRICES.monthly, periodEnd }],
      trial_end: opts.trial_end ?? null,
    };
    fake.subs.set(id, sub);
    const metered = sub.items.find((i) => i.metered);
    await db.insert(subscriptions).values({
      id,
      customerId: customer,
      status: opts.status,
      priceId: sub.items[0].priceId,
      currentPeriodEnd: new Date(periodEnd * 1000),
      trialEnd: opts.trial_end ? new Date(opts.trial_end * 1000) : null,
      meteredItemId: metered?.id ?? null,
    });
    return sub;
  }

  describe("POST /api/demo", () => {
    beforeEach(() => {
      process.env.TRUST_PROXY = "1";
      // The test DB keeps users across runs; the global cap has its own test below.
      process.env.DEMO_HOURLY_CAP = "1000000";
    });

    it("creates a demo user + Stripe customer and sets the session cookie", async () => {
      const res = await demo.POST(post("/api/demo", {}, undefined, { "x-forwarded-for": `10.0.0.${uid()}` }));
      expect(res.status).toBe(200);
      const { user } = await res.json();
      expect(user.name).toMatch(/^Demo Writer \d{4}$/);
      expect(user.email).toBe(`demo-${user.id}@inkwell.test`);
      const create = callsOf("customers.create")[0].params as { metadata: Record<string, string> };
      expect(create.metadata.userId).toBe(user.id);
      const [row] = await db.select().from(customers).where(eq(customers.userId, user.id));
      expect(row.stripeCustomerId).toMatch(/^cus_route_/);
      const setCookie = res.headers.get("set-cookie")!;
      expect(setCookie).toContain(`${SESSION_COOKIE}=`);
      expect(setCookie.toLowerCase()).toContain("httponly");
      expect(setCookie.toLowerCase()).toContain("samesite=lax");
      const token = decodeURIComponent(setCookie.split(";")[0].split("=").slice(1).join("="));
      expect(await verifySession(token)).toEqual({ userId: user.id });
    });

    it("redirects browsers to /pricing with 303", async () => {
      const req = new Request("http://localhost:3000/api/demo", {
        method: "POST",
        headers: { "x-forwarded-for": `10.1.0.${uid()}` },
      });
      const res = await demo.POST(req);
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/pricing");
    });

    it("rate-limits to 10 demo users per IP per hour", async () => {
      const ip = `10.2.0.${uid()}`;
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await demo.POST(post("/api/demo", {}, undefined, { "x-forwarded-for": ip }))).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it("without a trusted proxy, rotating X-Forwarded-For doesn't escape the limit", async () => {
      delete process.env.TRUST_PROXY;
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const res = await demo.POST(post("/api/demo", {}, undefined, { "x-forwarded-for": `10.9.${i}.${uid()}` }));
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 200)).toHaveLength(30);
      expect(statuses[30]).toBe(429);
    });

    it("enforces a global hourly cap from the users table", async () => {
      process.env.DEMO_HOURLY_CAP = "0";
      const res = await demo.POST(post("/api/demo", {}, undefined, { "x-forwarded-for": `10.3.0.${uid()}` }));
      expect(res.status).toBe(429);
      expect(callsOf("customers.create")).toHaveLength(0);
    });

    it("refuses cross-site posts (login CSRF) on /api/demo and /api/logout", async () => {
      const logout = await import("@/app/api/logout/route");
      const crossSite: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
      for (const headers of crossSite) {
        expect((await demo.POST(post("/api/demo", {}, undefined, { ...headers, "x-forwarded-for": `10.4.0.${uid()}` }))).status).toBe(403);
        expect((await logout.POST(post("/api/logout", {}, undefined, headers))).status).toBe(403);
      }
      const sameOrigin = await demo.POST(
        post("/api/demo", {}, undefined, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "x-forwarded-for": `10.4.1.${uid()}` }),
      );
      expect(sameOrigin.status).toBe(200);
    });

    it("keeps an existing signed-in demo user instead of minting a new one", async () => {
      const { id, cookie } = await makeUser();
      const res = await demo.POST(post("/api/demo", {}, cookie, { "x-forwarded-for": `10.5.0.${uid()}` }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ user: { id }, existing: true });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(callsOf("customers.create")).toHaveLength(0);
    });
  });

  describe("POST /api/checkout", () => {
    it("requires a session", async () => {
      expect((await checkout.POST(post("/api/checkout", { plan: "monthly" }))).status).toBe(401);
    });

    it("rejects a session for a user that no longer exists", async () => {
      const res = await checkout.POST(post("/api/checkout", { plan: "monthly" }, await cookieFor(crypto.randomUUID())));
      expect(res.status).toBe(401);
    });

    it("validates the plan", async () => {
      const { cookie } = await makeUser();
      expect((await checkout.POST(post("/api/checkout", { plan: "weekly" }, cookie))).status).toBe(400);
    });

    it("monthly for a first-time customer gets the 14-day trial and full metadata", async () => {
      const { id, cookie } = await makeUser();
      const res = await checkout.POST(post("/api/checkout", { plan: "monthly" }, cookie));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/c/cs_test_1", trial: true });
      const params = callsOf("checkout.sessions.create")[0].params as Record<string, unknown>;
      const [row] = await db.select().from(customers).where(eq(customers.userId, id));
      expect(params).toMatchObject({
        mode: "subscription",
        customer: row.stripeCustomerId,
        client_reference_id: id,
        line_items: [{ price: PRICES.monthly, quantity: 1 }],
        subscription_data: { trial_period_days: 14, metadata: { userId: id } },
        metadata: { userId: id },
        allow_promotion_codes: false,
      });
      expect(params.success_url).toMatch(/\/dashboard\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
      expect(params.cancel_url).toMatch(/\/pricing\?canceled=1$/);
    });

    it("yearly never gets a trial", async () => {
      const { cookie } = await makeUser();
      await checkout.POST(post("/api/checkout", { plan: "yearly" }, cookie));
      const params = callsOf("checkout.sessions.create")[0].params as { subscription_data: Record<string, unknown>; line_items: unknown };
      expect(params.subscription_data.trial_period_days).toBeUndefined();
      expect(params.line_items).toEqual([{ price: PRICES.yearly, quantity: 1 }]);
    });

    it("no second trial for a customer who already had one", async () => {
      const { id, cookie } = await makeUser();
      const customer = await makeCustomer(id);
      await makeSub(customer, { status: "canceled", trial_end: Math.floor(Date.now() / 1000) - 86400 * 40 });
      const res = await checkout.POST(post("/api/checkout", { plan: "monthly" }, cookie));
      expect((await res.json()).trial).toBe(false);
      const params = callsOf("checkout.sessions.create")[0].params as { subscription_data: Record<string, unknown> };
      expect(params.subscription_data.trial_period_days).toBeUndefined();
    });

    it("refuses a duplicate subscription and points to the portal", async () => {
      for (const status of ["active", "trialing", "past_due"]) {
        const { id, cookie } = await makeUser();
        await makeSub(await makeCustomer(id), { status });
        const res = await checkout.POST(post("/api/checkout", { plan: "yearly" }, cookie));
        expect(res.status).toBe(409);
        expect((await res.json()).portal).toBe(true);
      }
      expect(callsOf("checkout.sessions.create")).toHaveLength(0);
    });

    it("refuses when Stripe already has a live subscription the webhook hasn't delivered yet, and syncs it", async () => {
      const { id, cookie } = await makeUser();
      const customer = await makeCustomer(id);
      const late: FakeSub = {
        id: `sub_late_${uid()}`,
        customer,
        status: "trialing",
        trial_end: Math.floor(Date.now() / 1000) + 86400 * 14,
        items: [{ id: `si_${uid()}`, priceId: PRICES.monthly, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 14 }],
      };
      fake.subs.set(late.id, late);
      const res = await checkout.POST(post("/api/checkout", { plan: "yearly" }, cookie));
      expect(res.status).toBe(409);
      expect(callsOf("checkout.sessions.create")).toHaveLength(0);
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, late.id));
      expect(row.status).toBe("trialing");
    });

    it("expires the customer's older open Checkout Sessions before creating a new one", async () => {
      const { cookie } = await makeUser();
      fake.openSessions = ["cs_old_tab_1", "cs_old_tab_2"];
      const res = await checkout.POST(post("/api/checkout", { plan: "monthly" }, cookie));
      expect(res.status).toBe(200);
      expect(callsOf("checkout.sessions.expire").map((c) => c.params)).toEqual(["cs_old_tab_1", "cs_old_tab_2"]);
      expect(callsOf("checkout.sessions.list")[0].params).toMatchObject({ status: "open" });
    });
  });

  describe("POST /api/portal", () => {
    it("creates a portal session for the user's own customer", async () => {
      const { id, cookie } = await makeUser();
      const customer = await makeCustomer(id);
      const res = await portal.POST(post("/api/portal", {}, cookie));
      expect(await res.json()).toEqual({ url: "https://billing.stripe.test/p/session" });
      const params = callsOf("billingPortal.sessions.create")[0].params as Record<string, string>;
      expect(params.customer).toBe(customer);
      expect(params.return_url).toMatch(/\/dashboard$/);
    });
  });

  describe("GET /api/me", () => {
    it("answers from the DB without calling Stripe", async () => {
      const { id, cookie } = await makeUser();
      await makeSub(await makeCustomer(id), { status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 86400 * 10 });
      const res = await me.GET(get("/api/me", cookie));
      const body = await res.json();
      expect(body.user.id).toBe(id);
      expect(body.entitlement).toMatchObject({ active: true, trialing: true });
      expect(body.usage.creditsThisPeriod).toBe(0);
      expect(fake.calls).toHaveLength(0);
    });

    it("?sync= syncs only the user's own customer (webhook-late fallback), throttled", async () => {
      const { id, cookie } = await makeUser();
      const customer = await makeCustomer(id);
      const sub: FakeSub = {
        id: `sub_late_${uid()}`,
        customer,
        status: "active",
        items: [{ id: `si_${uid()}`, priceId: PRICES.yearly, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 365 }],
      };
      fake.subs.set(sub.id, sub);
      const before = await (await me.GET(get("/api/me", cookie))).json();
      expect(before.entitlement.active).toBe(false);

      const after = await (await me.GET(get("/api/me?sync=cs_test_1", cookie))).json();
      expect(after.synced).toBe(true);
      expect(after.entitlement.active).toBe(true);
      const lists = callsOf("subscriptions.list");
      expect(lists).toHaveLength(1);
      expect(lists[0].params).toMatchObject({ customer });

      const again = await (await me.GET(get("/api/me?sync=cs_test_1", cookie))).json();
      expect(again.synced).toBe(false);
      expect(callsOf("subscriptions.list")).toHaveLength(1);
    });
  });

  describe("plan preview / change", () => {
    it("previews a switch with the licensed item and a proration date", async () => {
      const { id, cookie } = await makeUser();
      const sub = await makeSub(await makeCustomer(id), { status: "active" });
      const res = await preview.POST(post("/api/plan/preview", { to: "yearly" }, cookie));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.amountDue).toBe(10800);
      expect(body.lines).toHaveLength(2);
      expect(body.chargedNow).toBe(true);
      const params = callsOf("invoices.createPreview")[0].params as {
        subscription: string;
        subscription_details: { items: unknown; proration_date: number; proration_behavior: string };
      };
      expect(params.subscription).toBe(sub.id);
      expect(params.subscription_details.items).toEqual([{ id: sub.items[0].id, price: PRICES.yearly }]);
      expect(params.subscription_details.proration_date).toBe(body.prorationDate);
      expect(params.subscription_details.proration_behavior).toBe("always_invoice");
      expect(body.creditToBalance).toBe(0);
    });

    it("refuses switching to the current plan", async () => {
      const { id, cookie } = await makeUser();
      await makeSub(await makeCustomer(id), { status: "active" });
      expect((await preview.POST(post("/api/plan/preview", { to: "monthly" }, cookie))).status).toBe(409);
    });

    it("changes the plan with the previewed proration date, then syncs", async () => {
      const { id, cookie } = await makeUser();
      const sub = await makeSub(await makeCustomer(id), { status: "active" });
      const prorationDate = Math.floor(Date.now() / 1000) - 30;
      const res = await change.POST(post("/api/plan/change", { to: "yearly", prorationDate }, cookie));
      expect(res.status).toBe(200);
      const update = callsOf("subscriptions.update")[0].params as Record<string, unknown>;
      expect(update).toMatchObject({
        id: sub.id,
        items: [{ id: sub.items[0].id, price: PRICES.yearly }],
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
        payment_behavior: "pending_if_incomplete",
      });
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
      expect(row.priceId).toBe(PRICES.yearly);
    });

    it("a declined proration charge leaves the plan and access unchanged (pending update → 402)", async () => {
      const { id, cookie } = await makeUser();
      const sub = await makeSub(await makeCustomer(id), { status: "active" });
      fake.declineNextUpdate = true;
      const prorationDate = Math.floor(Date.now() / 1000) - 30;
      const res = await change.POST(post("/api/plan/change", { to: "yearly", prorationDate }, cookie));
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.invoiceUrl).toBe("https://invoice.stripe.test/i/open");
      expect(body.entitlement).toMatchObject({ active: true, pastDue: false });
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
      expect(row.priceId).toBe(PRICES.monthly);
    });

    it("refuses to preview or switch while past due", async () => {
      const { id, cookie } = await makeUser();
      await makeSub(await makeCustomer(id), { status: "past_due" });
      expect((await preview.POST(post("/api/plan/preview", { to: "yearly" }, cookie))).status).toBe(409);
      const prorationDate = Math.floor(Date.now() / 1000) - 30;
      const res = await change.POST(post("/api/plan/change", { to: "yearly", prorationDate }, cookie));
      expect(res.status).toBe(409);
      expect((await res.json()).portal).toBe(true);
      expect(callsOf("subscriptions.update")).toHaveLength(0);
    });

    it("rejects an expired preview", async () => {
      const { id, cookie } = await makeUser();
      await makeSub(await makeCustomer(id), { status: "active" });
      const prorationDate = Math.floor(Date.now() / 1000) - 3600 * 2;
      const res = await change.POST(post("/api/plan/change", { to: "yearly", prorationDate }, cookie));
      expect(res.status).toBe(409);
      expect(callsOf("subscriptions.update")).toHaveLength(0);
    });
  });

  describe("POST /api/usage", () => {
    it("requires an active or trialing subscription", async () => {
      const { id, cookie } = await makeUser();
      await makeSub(await makeCustomer(id), { status: "past_due" });
      expect((await usage.POST(post("/api/usage", { credits: 1, idempotencyKey: crypto.randomUUID() }, cookie))).status).toBe(403);
      expect(callsOf("billing.meterEvents.create")).toHaveLength(0);
    });

    it("validates credits 1..100", async () => {
      const { cookie } = await makeUser();
      expect((await usage.POST(post("/api/usage", { credits: 0 }, cookie))).status).toBe(400);
      expect((await usage.POST(post("/api/usage", { credits: 101 }, cookie))).status).toBe(400);
      // No key, no metering: every request must be retryable without double-counting.
      expect((await usage.POST(post("/api/usage", { credits: 1 }, cookie))).status).toBe(400);
    });

    it("attaches the metered item once, then sends a meter event", async () => {
      const { id, cookie } = await makeUser();
      const customer = await makeCustomer(id);
      const sub = await makeSub(customer, { status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 86400 * 5 });
      const first = await usage.POST(post("/api/usage", { credits: 10, idempotencyKey: crypto.randomUUID() }, cookie));
      expect(first.status).toBe(200);
      expect(callsOf("subscriptionItems.create")).toHaveLength(1);
      expect(callsOf("subscriptionItems.create")[0].params).toMatchObject({ subscription: sub.id, price: PRICES.credits });
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
      expect(row.meteredItemId).toMatch(/^si_metered_/);

      const second = await usage.POST(post("/api/usage", { credits: 1, idempotencyKey: crypto.randomUUID() }, cookie));
      expect(callsOf("subscriptionItems.create")).toHaveLength(1);
      const meter = callsOf("billing.meterEvents.create").map((c) => c.params as { identifier: string });
      expect(meter).toHaveLength(2);
      expect(meter[0]).toMatchObject({ event_name: "inkwell_ai_credits", payload: { stripe_customer_id: customer, value: "10" } });
      expect(meter[0].identifier).not.toBe(meter[1].identifier);
      const body = await second.json();
      expect(body.usage.creditsThisPeriod).toBe(11);
      expect(body.usage.estimatedCostCents).toBe(22);
    });

    it("is idempotent: a retry with the same key never double-counts, even after a Stripe failure", async () => {
      const { id, cookie } = await makeUser();
      const customer = await makeCustomer(id);
      await makeSub(customer, {
        status: "active",
        items: [
          { id: `si_${uid()}`, priceId: PRICES.monthly, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 20 },
          { id: `si_m_${uid()}`, priceId: PRICES.credits, metered: true, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 20 },
        ],
      });
      const key = crypto.randomUUID();
      fake.meterFailuresLeft = 1;

      const failed = await usage.POST(post("/api/usage", { credits: 5, idempotencyKey: key }, cookie));
      expect(failed.status).toBe(502);
      const retry = await usage.POST(post("/api/usage", { credits: 5, idempotencyKey: key }, cookie));
      expect(retry.status).toBe(200);
      expect((await retry.json()).duplicate).toBe(false);
      const replay = await usage.POST(post("/api/usage", { credits: 5, idempotencyKey: key }, cookie));
      const replayBody = await replay.json();
      expect(replayBody.duplicate).toBe(true);
      expect(replayBody.usage.creditsThisPeriod).toBe(5);

      const meter = callsOf("billing.meterEvents.create").map((c) => (c.params as { identifier: string }).identifier);
      expect(meter).toHaveLength(2);
      expect(new Set(meter).size).toBe(1);
      const rows = await db.select().from(usageEvents).where(eq(usageEvents.userId, id));
      expect(rows).toHaveLength(1);
      expect(rows[0].sentAt).not.toBeNull();
      expect(callsOf("subscriptionItems.create")).toHaveLength(0);
    });

    it("re-sends a stranded unsent usage row with its original identifier on the next request", async () => {
      const { id, cookie } = await makeUser();
      await makeSub(await makeCustomer(id), {
        status: "active",
        items: [
          { id: `si_${uid()}`, priceId: PRICES.monthly, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 20 },
          { id: `si_m_${uid()}`, priceId: PRICES.credits, metered: true, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 20 },
        ],
      });
      const stranded = `inkwell-usage-${crypto.randomUUID()}`;
      await db.insert(usageEvents).values({ userId: id, quantity: 3, identifier: stranded, createdAt: new Date(Date.now() - 5 * 60_000) });
      const res = await usage.POST(post("/api/usage", { credits: 1, idempotencyKey: crypto.randomUUID() }, cookie));
      expect(res.status).toBe(200);
      const sent = callsOf("billing.meterEvents.create").map((c) => (c.params as { identifier: string }).identifier);
      expect(sent).toContain(stranded);
      const [row] = await db.select().from(usageEvents).where(eq(usageEvents.identifier, stranded));
      expect(row.sentAt).not.toBeNull();
    });

    it("refuses another user's idempotency key", async () => {
      const a = await makeUser();
      const b = await makeUser();
      for (const u of [a, b]) {
        await makeSub(await makeCustomer(u.id), {
          status: "active",
          items: [
            { id: `si_${uid()}`, priceId: PRICES.monthly, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 20 },
            { id: `si_m_${uid()}`, priceId: PRICES.credits, metered: true, periodEnd: Math.floor(Date.now() / 1000) + 86400 * 20 },
          ],
        });
      }
      const key = crypto.randomUUID();
      expect((await usage.POST(post("/api/usage", { credits: 1, idempotencyKey: key }, a.cookie))).status).toBe(200);
      expect((await usage.POST(post("/api/usage", { credits: 1, idempotencyKey: key }, b.cookie))).status).toBe(409);
    });
  });
});
