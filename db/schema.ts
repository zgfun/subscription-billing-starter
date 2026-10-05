import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  isDemo: boolean("is_demo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable("customers", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mirror of Stripe subscriptions. Always upserted from a fresh `subscriptions.retrieve`, never from event payloads. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(), // Stripe subscription id
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.stripeCustomerId, { onDelete: "cascade" }),
    status: text("status").notNull(), // trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired | paused
    priceId: text("price_id").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    meteredItemId: text("metered_item_id"), // subscription item for the usage add-on, if attached
    latestInvoiceStatus: text("latest_invoice_status"),
    stripeUpdatedAt: bigint("stripe_updated_at", { mode: "number" }), // seconds; guards against older snapshots
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_customer_idx").on(t.customerId)],
);

/** Idempotency ledger: the unique primary key on the event id is what makes webhooks replay-safe. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
});

/** Synced from Stripe (scripts/stripe-setup.ts and price.* webhooks). */
export const prices = pgTable("prices", {
  id: text("id").primaryKey(),
  lookupKey: text("lookup_key").unique(),
  productId: text("product_id").notNull(),
  productName: text("product_name").notNull(),
  unitAmount: integer("unit_amount"),
  currency: text("currency").notNull(),
  interval: text("interval"), // month | year | null
  usageType: text("usage_type"), // licensed | metered
  trialDays: integer("trial_days"),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
});

/** Local log of metered usage sent to Stripe (meter events), for display and idempotent retries. */
export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull(),
  identifier: text("identifier").notNull().unique(), // sent to Stripe as the meter event identifier
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Side effects (emails) recorded once per event, so a replayed webhook never sends twice. */
export const sideEffects = pgTable("side_effects", {
  key: text("key").primaryKey(), // e.g. "email:payment_failed:in_123"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Price = typeof prices.$inferSelect;
