// Runs a real Postgres locally without Docker (data in .pgdata/).
// DATABASE_URL=postgres://billing:billing@localhost:5435/billing
// TEST_DATABASE_URL=postgres://billing:billing@localhost:5435/billing_test
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const pg = new EmbeddedPostgres({
  databaseDir: ".pgdata",
  user: "billing",
  password: "billing",
  port: 5435,
  persistent: true,
});

if (!existsSync(".pgdata/PG_VERSION")) await pg.initialise();
await pg.start();
// The app database and a separate one for the DB-backed tests. Created when missing, also on an existing .pgdata.
for (const name of ["billing", "billing_test"]) {
  try {
    await pg.createDatabase(name);
  } catch (error) {
    if (!/already exists/i.test(String((error as Error).message))) throw error;
  }
}
console.log("Postgres ready on postgres://billing:billing@localhost:5435/billing (tests: /billing_test). Ctrl+C to stop.");

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
