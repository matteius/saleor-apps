import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { defineConfig, devices } from "@playwright/test";

const envPath = ".env.test";

if (existsSync(envPath)) {
  // eslint-disable-next-line no-console
  console.log(`Loading environment variables from ${envPath}`);
  loadEnvFile(envPath);
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: ["**/subscriptions/**"],
    },
    {
      /*
       * T33 — subscription E2E (Stripe test clock + Saleor `owlbooks` channel).
       * Run focused with: pnpm test:e2e --project=subscriptions-e2e
       * Most scenarios are fixmed pending manual gates; see
       * ./e2e/subscriptions/README.md.
       */
      name: "subscriptions-e2e",
      testDir: "./e2e/subscriptions",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
