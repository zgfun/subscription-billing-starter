// Forwards test-mode webhooks to the local app without exposing secrets:
// the API key goes to the CLI through its environment (never argv, so `ps` can't see it), and the CLI's
// output is piped through a redactor, so the "webhook signing secret is whsec_..." line never reaches a
// terminal or log in clear. Put the signing secret in .env.local yourself: `stripe listen --print-secret`.
//   pnpm stripe:listen            # forwards to localhost:3000
//   PORT=3400 pnpm stripe:listen
// STRIPE_CLI overrides the CLI binary (default: "stripe" on PATH).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { HANDLED_EVENTS } from "../lib/webhooks/events";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const key = process.env.STRIPE_SECRET_KEY;
if (!key?.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_...).");
  process.exit(1);
}

const SECRET_PATTERN = /\b(whsec|sk|rk)_(test_|live_)?[A-Za-z0-9]+/g;
const redact = (text: string) => text.replace(SECRET_PATTERN, (_m, prefix: string, mode = "") => `${prefix}_${mode}[redacted]`);

const port = process.env.PORT ?? "3000";
const cli = process.env.STRIPE_CLI ?? "stripe";
const events = HANDLED_EVENTS.join(",");
const child = spawn(cli, ["listen", "--events", events, "--forward-to", `localhost:${port}/api/stripe/webhook`], {
  env: { ...process.env, STRIPE_API_KEY: key },
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8").on("data", (chunk: string) => process.stdout.write(redact(chunk)));
child.stderr.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(redact(chunk)));
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
