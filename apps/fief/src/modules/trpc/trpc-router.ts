/**
 * Root tRPC router for `saleor-app-fief` (T33).
 *
 * Intentionally **empty** at this stage. Sub-routers land in:
 *   - T34 — `connections` + `channelConfig`
 *   - T36 — `claimsMapping`
 *   - T37 — `webhookLog`
 *   - T38 — `reconciliation`
 *
 * The browser guard mirrors `apps/stripe/src/modules/trpc/trpc-router.ts` —
 * this module transitively imports server-only deps (Mongo client lifetime
 * via `protected-client-procedure` -> APL -> Mongo) and must not be bundled
 * into the iframe. `trpc-client.ts` uses `import type` to stay browser-safe.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "trpc-router.ts must not be imported in the browser — use `import type` instead.",
  );
}

/* eslint-disable import/first */
import { router } from "./trpc-server";

export const trpcRouter = router({});

export type TrpcRouter = typeof trpcRouter;
