// Runs a real Postgres locally without Docker (data in .pgdata/).
// DATABASE_URL=postgres://billing:billing@localhost:5435/billing
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const pg = new EmbeddedPostgres({
  databaseDir: ".pgdata",
  user: "billing",
  password: "billing",
  port: 5435,
  persistent: true,
});

const fresh = !existsSync(".pgdata/PG_VERSION");
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("billing");
console.log("Postgres ready on postgres://billing:billing@localhost:5435/billing (Ctrl+C to stop)");

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
