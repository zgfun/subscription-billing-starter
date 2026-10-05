import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import Stripe from "stripe";
import { vi } from "vitest";

export async function prepareDb(): Promise<boolean> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return false;
  const client = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 3 });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 });
  }
}

const FIXTURES = join(process.cwd(), "fixtures", "events");

/** A real recorded event (fixtures/events/<type>.json), deep-cloned, with a fresh event id. */
export function fixture<T extends Stripe.Event["type"]>(type: T): Extract<Stripe.Event, { type: T }> {
  const event = JSON.parse(readFileSync(join(FIXTURES, `${type}.json`), "utf8"));
  event.id = `evt_test_${randomUUID().replaceAll("-", "")}`;
  return event;
}

export const uid = (prefix: string) => `${prefix}_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class NotFound extends Error {
  statusCode = 404;
  code = "resource_missing";
}

/** Fresh Stripe state the fake client serves; tests mutate it to simulate "what Stripe says now". */
export type World = {
  subs: Map<string, Stripe.Subscription>;
  customers: Map<string, { id: string; metadata: Record<string, string>; deleted?: boolean }>;
  invoices: Map<string, Partial<Stripe.Invoice>>;
  prices: Map<string, Stripe.Price>;
  events: Map<string, Stripe.Event>;
  /** invoice id → payment intent ids paid on it */
  payments: Map<string, string[]>;
  refunds: string[];
};

export function newWorld(): World {
  return {
    subs: new Map(),
    customers: new Map(),
    invoices: new Map(),
    prices: new Map(),
    events: new Map(),
    payments: new Map(),
    refunds: [],
  };
}

/** Build a subscription in Stripe's current shape from the recorded created-event payload. */
export function makeSub(opts: {
  id: string;
  customer: string;
  status: Stripe.Subscription.Status;
  priceId?: string;
  cancelAtPeriodEnd?: boolean;
  trialEnd?: number | null;
  periodEnd?: number;
  latestInvoiceStatus?: Stripe.Invoice.Status | null;
  created?: number;
}): Stripe.Subscription {
  const base = fixture("customer.subscription.created").data.object;
  const item = base.items.data[0];
  return {
    ...base,
    id: opts.id,
    customer: opts.customer,
    status: opts.status,
    created: opts.created ?? base.created,
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    trial_end: opts.trialEnd ?? null,
    latest_invoice: opts.latestInvoiceStatus
      ? ({ id: `in_${opts.id}`, object: "invoice", status: opts.latestInvoiceStatus } as Stripe.Invoice)
      : null,
    items: {
      ...base.items,
      data: [
        {
          ...item,
          id: `si_${opts.id}`,
          current_period_end: opts.periodEnd ?? item.current_period_end,
          price: { ...item.price, id: opts.priceId ?? item.price.id },
        },
      ],
    },
  };
}

export function fakeStripe(world: World) {
  const real = new Stripe("sk_test_fake_for_signatures");
  const client = {
    webhooks: real.webhooks,
    subscriptions: {
      retrieve: vi.fn(async (id: string) => {
        const sub = world.subs.get(id);
        if (!sub) throw new NotFound(`No such subscription: ${id}`);
        return structuredClone(sub);
      }),
      list: vi.fn(({ customer }: { customer: string }) => {
        const data = [...world.subs.values()].filter((s) => s.customer === customer).map((s) => structuredClone(s));
        return {
          async *[Symbol.asyncIterator]() {
            yield* data;
          },
        };
      }),
      cancel: vi.fn(async (id: string) => {
        const sub = world.subs.get(id);
        if (!sub) throw new NotFound(`No such subscription: ${id}`);
        sub.status = "canceled";
        return structuredClone(sub);
      }),
    },
    invoicePayments: {
      list: vi.fn(({ invoice }: { invoice: string }) => {
        const data = (world.payments.get(invoice) ?? []).map((pi) => ({ object: "invoice_payment", payment: { type: "payment_intent", payment_intent: pi } }));
        return {
          async *[Symbol.asyncIterator]() {
            yield* data;
          },
        };
      }),
    },
    refunds: {
      create: vi.fn(async ({ payment_intent }: { payment_intent: string }) => {
        world.refunds.push(payment_intent);
        return { object: "refund", id: `re_${payment_intent}`, payment_intent };
      }),
    },
    events: {
      retrieve: vi.fn(async (id: string) => {
        const event = world.events.get(id);
        if (!event) throw new NotFound(`No such event: ${id}`);
        return structuredClone(event);
      }),
    },
    customers: {
      retrieve: vi.fn(async (id: string) => {
        const c = world.customers.get(id);
        if (!c) throw new NotFound(`No such customer: ${id}`);
        return { object: "customer", ...c };
      }),
    },
    invoices: {
      retrieve: vi.fn(async (id: string) => {
        const inv = world.invoices.get(id);
        if (!inv) throw new NotFound(`No such invoice: ${id}`);
        return { object: "invoice", id, ...inv };
      }),
    },
    prices: {
      retrieve: vi.fn(async (id: string) => {
        const p = world.prices.get(id);
        if (!p) throw new NotFound(`No such price: ${id}`);
        return structuredClone(p);
      }),
    },
    products: {
      retrieve: vi.fn(async (id: string) => ({ id, object: "product", name: "Inkwell Pro", metadata: { app: "inkwell" } })),
    },
  };
  return client as unknown as typeof client & Stripe;
}
