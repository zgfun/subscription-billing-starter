import type Stripe from "stripe";

export type FakeSub = {
  id: string;
  customer: string;
  status: string;
  items: { id: string; priceId: string; metered?: boolean; periodEnd: number }[];
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  trial_end?: number | null;
  latestInvoiceStatus?: string | null;
};

export function stripeSubscription(s: FakeSub): Stripe.Subscription {
  return {
    id: s.id,
    object: "subscription",
    customer: s.customer,
    status: s.status,
    cancel_at_period_end: s.cancel_at_period_end ?? false,
    cancel_at: s.cancel_at ?? null,
    trial_end: s.trial_end ?? null,
    latest_invoice: s.latestInvoiceStatus ? { id: `in_${s.id}`, object: "invoice", status: s.latestInvoiceStatus } : null,
    items: {
      object: "list",
      data: s.items.map((i) => ({
        id: i.id,
        object: "subscription_item",
        current_period_end: i.periodEnd,
        price: {
          id: i.priceId,
          object: "price",
          recurring: { interval: "month", usage_type: i.metered ? "metered" : "licensed" },
        },
      })),
    },
  } as unknown as Stripe.Subscription;
}

export class NotFound extends Error {
  statusCode = 404;
  code = "resource_missing";
}

/** Minimal fake Stripe client: only what lib/sync.ts and lib/catalog.ts call. */
export function fakeStripe(opts: {
  subs?: Map<string, FakeSub>;
  customers?: Map<string, { metadata: Record<string, string> }>;
  prices?: Stripe.Price[];
}) {
  const subs = opts.subs ?? new Map<string, FakeSub>();
  const customers = opts.customers ?? new Map();
  const calls = { retrieve: 0, customersCreate: 0, pricesList: 0 };
  let n = 0;
  const client = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.retrieve++;
        const s = subs.get(id);
        if (!s) throw new NotFound(`No such subscription: ${id}`);
        return stripeSubscription(s);
      },
      list: ({ customer }: { customer: string }) => {
        const data = [...subs.values()].filter((s) => s.customer === customer).map(stripeSubscription);
        return {
          async *[Symbol.asyncIterator]() {
            yield* data;
          },
        };
      },
    },
    customers: {
      retrieve: async (id: string) => {
        const c = customers.get(id);
        if (!c) throw new NotFound(`No such customer: ${id}`);
        return { id, object: "customer", metadata: c.metadata };
      },
      create: async (params: { metadata: Record<string, string> }) => {
        calls.customersCreate++;
        await new Promise((r) => setTimeout(r, 5));
        const id = `cus_fake_${++n}_${params.metadata.userId.slice(0, 8)}`;
        customers.set(id, { metadata: params.metadata });
        return { id, object: "customer", metadata: params.metadata };
      },
    },
    products: {
      retrieve: async (id: string) => ({ id, object: "product", name: "Inkwell Pro" }),
    },
    prices: {
      list: async () => {
        calls.pricesList++;
        return { object: "list", data: opts.prices ?? [], has_more: false };
      },
    },
  };
  return { stripe: client as unknown as Stripe, calls, subs, customers };
}
