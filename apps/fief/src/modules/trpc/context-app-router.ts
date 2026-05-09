/**
 * tRPC App Router context for `saleor-app-fief` (T33).
 *
 * Mirrors the Stripe app's context surface so the procedures + middleware
 * port cleanly. Two notable Fief-specific deviations from Stripe:
 *
 *   1. **No `configRepo` slot** — the dashboard tRPC router uses repositories
 *      directly through use-cases (T34/T36/T37/T38). The repo dependency is
 *      injected at the use-case boundary, not the context, so we don't have
 *      to widen this interface every time a new repo lands.
 *
 *   2. **No `apiClient` slot** — Stripe builds an instrumented urql client
 *      inside one of the protected-procedure middlewares; the Fief app does
 *      not yet need a Saleor GraphQL client from tRPC handlers, and when it
 *      does (T34's `testConnection` etc.) it will build one explicitly via
 *      `@saleor/apps-shared/create-graphql-client`. Adding it here unused
 *      would force a URQL dep on every procedure for no reason.
 *
 * The auth-data lookup (APL) and JWT validation happen in
 * `protected-client-procedure.ts`, not here — the context only carries
 * the **inbound** request shape (token + saleorApiUrl from headers). The
 * protected procedure is what trades those for the authenticated `appToken`
 * + `appId` extracted from the APL.
 */
import { SALEOR_API_URL_HEADER, SALEOR_AUTHORIZATION_BEARER_HEADER } from "@saleor/app-sdk/headers";
import { type inferAsyncReturnType } from "@trpc/server";
import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

import { createLogger } from "@/lib/logger";

/**
 * Per-request logger for the tRPC layer. Fresh on every request so the
 * `withLoggerContext` middleware (composed at the route handler) supplies
 * `correlationId` / `saleorApiUrl` bindings via `AsyncLocalStorage`.
 */
const buildRequestLogger = () => createLogger("trpc.context");

export const createTrpcContextAppRouter = async ({ req }: FetchCreateContextFnOptions) => {
  return {
    /**
     * The frontend dashboard's Saleor JWT, lifted from the
     * `Authorization-Bearer` header set by `@saleor/apps-trpc/http-batch-link`.
     * Verified by `protectedClientProcedure`. Absent on requests that
     * have not been wired through the iframe app bridge.
     */
    token: req.headers.get(SALEOR_AUTHORIZATION_BEARER_HEADER) as string | undefined,

    /**
     * The Saleor instance the dashboard is browsing. Used to look up the APL
     * row holding the app's long-lived auth token.
     */
    saleorApiUrl: req.headers.get(SALEOR_API_URL_HEADER) as string | undefined,

    /**
     * Filled in by `protectedClientProcedure` after APL lookup; consumers of
     * unauthenticated procedures get `undefined` here and that's fine — they
     * shouldn't be reading it.
     */
    appId: undefined as undefined | string,

    /**
     * Origin from the request — used by procedures that need to mint
     * absolute URLs back to the iframe (e.g. for redirect targets in T34).
     */
    appUrl: req.headers.get("origin"),

    /**
     * Per-request structured logger. Already context-aware via the
     * `loggerContextStore` in `src/lib/logger.ts`, but we surface it on the
     * context so procedures can drop `ctx.logger.info(...)` without a
     * second `createLogger(...)` call.
     */
    logger: buildRequestLogger(),
  };
};

export type TrpcContextAppRouter = inferAsyncReturnType<typeof createTrpcContextAppRouter>;
