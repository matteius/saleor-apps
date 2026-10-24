import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    css: false,
    mockReset: true,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          sequence: {
            shuffle: true,
          },
          include: ["src/**/*.test.ts"],
          exclude: ["src/__tests__/integration/**"], // exclude integration tests so vitest doesn't run them twice
          name: "unit",
          setupFiles: "./src/__tests__/setup.units.ts",
          environment: "jsdom",
        },
      },
      {
        extends: true,
        test: {
          sequence: {
            concurrent: false,
          },
          globalSetup: "./src/__tests__/integration/global-setup.integration.ts",
          include: ["src/__tests__/integration/**/*.test.{ts,ts}"],
          name: "integration",
          setupFiles: "./src/__tests__/integration/setup.integration.ts",
          env: loadEnv("test", process.cwd(), ""),
          pool: "threads",
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
