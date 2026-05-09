/**
 * Browser-side tRPC client for `saleor-app-fief` (T33).
 *
 * Mirrors Stripe's port. The `import type` for `TrpcRouter` is mandatory —
 * `trpc-router.ts` transitively pulls in Mongo / `node:async_hooks` and will
 * crash module loading in the browser if imported as a value (it actually
 * throws on purpose at the top of that file as a guard).
 *
 * `appBridgeInstance` is owned by `src/pages/_app.tsx` once T35 lands the
 * dashboard shell. Until then this file is the canonical builder; once
 * `_app.tsx` exists it should re-export `appBridgeInstance` and this module
 * (and `createHttpBatchLink` callers downstream) keep working unchanged.
 */
import { AppBridge } from "@saleor/app-sdk/app-bridge";
import { createHttpBatchLink } from "@saleor/apps-trpc/http-batch-link";
import { createTRPCNext } from "@trpc/next";

import type { TrpcRouter } from "./trpc-router";

/**
 * Singleton `AppBridge`. The `typeof window` guard avoids constructing one
 * during SSR (the SDK's constructor reads `window.location` and similar),
 * matching the workaround in `apps/stripe/src/pages/_app.tsx`.
 */
export const appBridgeInstance = typeof window !== "undefined" ? new AppBridge() : undefined;

export const trpcClient = createTRPCNext<TrpcRouter>({
  config() {
    return {
      links: [createHttpBatchLink(appBridgeInstance)],
      queryClientConfig: {
        defaultOptions: {
          queries: {
            refetchOnMount: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
      },
    };
  },
  ssr: false,
});
