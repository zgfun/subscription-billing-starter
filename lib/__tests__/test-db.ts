import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Migrates TEST_DATABASE_URL (billing_test). Returns false when it is not configured or unreachable. */
export async function prepareTestDb(): Promise<boolean> {
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

export const testDbAvailable = await prepareTestDb();

export async function resetTables() {
  const { db } = await import("@/db");
  await db.execute(
    sql`TRUNCATE users, customers, subscriptions, stripe_events, prices, usage_events, side_effects RESTART IDENTITY CASCADE`,
  );
}
