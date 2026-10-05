import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

config({ path: ".env.local", quiet: true });

// Tests never touch the dev database: db/index.ts reads DATABASE_URL, so point it at billing_test.
const testEnv: Record<string, string> = {};
if (process.env.TEST_DATABASE_URL) testEnv.DATABASE_URL = process.env.TEST_DATABASE_URL;

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["**/__tests__/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    env: testEnv,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
