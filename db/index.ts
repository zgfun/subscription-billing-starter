import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as { db?: Db };

function create(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Neon's pooler does not support prepared statements.
  return drizzle(postgres(url, { prepare: false, max: 5 }), { schema });
}

function instance(): Db {
  globalForDb.db ??= create();
  return globalForDb.db;
}

// Connect on first use, not on import: `next build` evaluates route modules
// to collect page data, and the build environment has no DATABASE_URL.
export const db = new Proxy({} as Db, {
  get(_, prop) {
    const target = instance();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
export * from "./schema";
