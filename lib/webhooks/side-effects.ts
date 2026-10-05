import { eq } from "drizzle-orm";
import { db, sideEffects } from "@/db";

/**
 * Run `fn` at most once per key. The key is claimed first (unique PK in side_effects), so a replayed
 * or concurrently delivered event can never send the same email twice. If `fn` throws, the claim is
 * released so a later attempt can try again. Returns true if `fn` ran.
 */
export async function once(key: string, fn: () => Promise<unknown>): Promise<boolean> {
  const claimed = await db.insert(sideEffects).values({ key }).onConflictDoNothing().returning({ key: sideEffects.key });
  if (claimed.length === 0) return false;
  try {
    await fn();
    return true;
  } catch (err) {
    await db.delete(sideEffects).where(eq(sideEffects.key, key));
    throw err;
  }
}
