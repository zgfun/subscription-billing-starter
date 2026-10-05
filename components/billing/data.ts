import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { customers, db, stripeEvents, subscriptions, users } from "@/db";

export async function getUser(userId: string) {
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

export async function hasUsedTrial(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(subscriptions)
    .innerJoin(customers, eq(customers.stripeCustomerId, subscriptions.customerId))
    .where(and(eq(customers.userId, userId), isNotNull(subscriptions.trialEnd)));
  return (row?.n ?? 0) > 0;
}

export type LedgerRow = {
  id: string;
  type: string;
  receivedAt: string;
  processedAt: string | null;
  /** Public page: only whether the last attempt failed. The error text stays in the DB and server logs. */
  failed: boolean;
};

export type LedgerStats = { received: number; processed: number; failed: number; pending: number };

export async function getLedger(limit = 50): Promise<{ rows: LedgerRow[]; stats: LedgerStats }> {
  const [rows, [totals]] = await Promise.all([
    db.select().from(stripeEvents).orderBy(desc(stripeEvents.receivedAt)).limit(limit),
    db
      .select({
        received: count(),
        processed: count(stripeEvents.processedAt),
        failed: count(stripeEvents.error),
      })
      .from(stripeEvents),
  ]);
  const [pendingRow] = await db
    .select({ n: count() })
    .from(stripeEvents)
    .where(and(isNull(stripeEvents.processedAt), isNull(stripeEvents.error)));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      type: r.type,
      receivedAt: r.receivedAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
      failed: r.error != null,
    })),
    stats: {
      received: totals?.received ?? 0,
      processed: totals?.processed ?? 0,
      failed: totals?.failed ?? 0,
      pending: pendingRow?.n ?? 0,
    },
  };
}
