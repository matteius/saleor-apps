import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/*
 * pnpm can install several peer-resolved copies of the SDK. App Bridge's
 * provider, hooks and Next.js helpers must all use the same React context.
 */
const sdkDirectory = path.dirname(require.resolve("@saleor/app-sdk/package.json"));

export const appBridgePaths = {
  appBridge: path.join(sdkDirectory, "app-bridge/index.mjs"),
  appBridgeNext: path.join(sdkDirectory, "app-bridge/next/index.mjs"),
};
