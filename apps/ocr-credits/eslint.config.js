import { config } from "@saleor/eslint-config-apps/index.js";
import nodePlugin from "eslint-plugin-n";

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    name: "saleor-app-ocr-credits/custom-config",
    files: ["**/*.ts"],
    plugins: {
      n: nodePlugin,
    },
    rules: {
      "n/no-process-env": "error",
    },
  },
  {
    name: "saleor-app-ocr-credits/override-no-process-env",
    files: ["next.config.ts", "src/env.ts"],
    rules: {
      "n/no-process-env": "off",
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    name: "saleor-app-ocr-credits/override-recommended",
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-fallthrough": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-namespace": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
    },
  },
];

