// cspell:ignore opensensor
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    css: false,
    mockReset: true,
    restoreMocks: true,
    workspace: [
      {
        extends: true,
        test: {
          sequence: {
            shuffle: true,
          },
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/__tests__/integration/**"],
          name: "unit",
          setupFiles: "./src/__tests__/setup.units.ts",
          environment: "jsdom",
        },
      },
      {
        extends: true,
        test: {
          /*
           * Integration suite (T40): boots `mongodb-memory-server` + an
           * `msw` mock for Fief OIDC + admin endpoints, exercises the four
           * auth-plane handlers (T18-T21) end-to-end through the central
           * composition root (`src/lib/composition-root.ts`).
           *
           * - Sequential: each test file owns its mongodb-memory-server, so
           *   running them in parallel would spawn N copies and OOM CI.
           * - 5-min testTimeout for the latency-benchmark cases that issue
           *   1000 sequential requests against the in-process Mongo.
           */
          include: ["src/__tests__/integration/**/*.test.ts"],
          exclude: [],
          name: "integration",
          setupFiles: "./src/__tests__/integration/setup.ts",
          environment: "node",
          /*
           * Run files sequentially in a single fork so each test file owns
           * its own `mongodb-memory-server` without parallel spawns OOM-ing
           * CI. `fileParallelism` belongs at the root config, not on a
           * workspace project — the equivalent inside a project is
           * `poolOptions.forks.singleFork`.
           */
          pool: "forks",
          poolOptions: {
            forks: { singleFork: true },
          },
          testTimeout: 300_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          /*
           * E2E suite (T42): mocked-mode round trip — boots
           * `mongodb-memory-server`, msw-mocked Fief OIDC + admin endpoints,
           * and an in-memory Saleor GraphQL fake. Exercises the full
           * SSO + bidirectional sync flow through the auth-plane HTTP
           * routes (T18/T19) plus the sync use cases (T23/T27). The
           * "live" run against staging Saleor + opensensor-fief is a
           * documented manual-run target — see `apps/fief/e2e/README.md`.
           */
          include: ["e2e/**/*.spec.ts"],
          exclude: [],
          name: "e2e",
          setupFiles: ["./e2e/setup.ts"],
          environment: "node",
          /*
           * Run files sequentially in a single fork so each file owns its
           * own `mongodb-memory-server` + msw server without parallel
           * spawns OOM-ing CI.
           */
          pool: "forks",
          poolOptions: {
            forks: { singleFork: true },
          },
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
