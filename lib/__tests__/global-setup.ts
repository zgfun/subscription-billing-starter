import { prepareTestDb } from "./test-db";

/** Runs once before the suites: a missing test database is reported loudly, and fails the run in CI. */
export default async function setup() {
  if (await prepareTestDb()) return;
  const message =
    "TEST_DATABASE_URL is not set or unreachable, so the DB-backed tests are skipped. " +
    "Run `pnpm db:local` and set TEST_DATABASE_URL (see .env.example).";
  if (process.env.CI || process.env.REQUIRE_DB === "1") throw new Error(message);
  console.warn(`\n[test-db] ${message}\n`);
}
