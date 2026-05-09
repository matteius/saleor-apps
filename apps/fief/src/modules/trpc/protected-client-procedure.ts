/**
 * `protectedClientProcedure` (T33).
 *
 * Three-layer middleware that runs on every dashboard tRPC call:
 *
 *   1. `attachAppToken` — pulls the saleorApiUrl from the request context,
 *      hits the APL (whatever backend is configured by `src/lib/saleor-app.ts`,
 *      Mongo in production), and attaches the per-installation `appToken` +
 *      `appId` to the next-middleware ctx. Rejects with `BAD_REQUEST` if the
 *      saleorApiUrl header is missing and `UNAUTHORIZED` if the APL has no
 *      record for it (the app isn't installed against this Saleor instance).
 *
 *   2. `validateClientToken` — verifies the **frontend** JWT (the dashboard
 *      iframe's user-scoped token, distinct from the long-lived `appToken`)
 *      against Saleor's JWKS via `@saleor/app-sdk/auth#verifyJWT`. The SDK
 *      checks signature, expiration, the `app` claim, and the
 *      `requiredClientPermissions` meta supplied by the procedure (defaults to
 *      `REQUIRED_SALEOR_PERMISSIONS` from `@saleor/apps-shared/permissions`).
 *      Rejects with `FORBIDDEN` on any verification failure.
 *
 *   3. _(Stripe also adds an `attachSharedServices` middleware that builds an
 *      instrumented urql client. We deliberately skip that here — the only
 *      tRPC procedures that hit Saleor's GraphQL API in the Fief app
 *      (testConnection in T34) build their own client at the use-case
 *      boundary, so making every procedure pay the cost is wasteful.)_
 *
 * Slim-observability per T47: no Sentry user mirroring, no OTel span tags.
 * The per-request logger context is already populated by
 * `withLoggerContext` at the route handler, so any `createLogger(...)` call
 * inside this file (or from an inner resolver) automatically picks up
 * `saleorApiUrl` + `correlationId`.
 */
import { verifyJWT } from "@saleor/app-sdk/auth";
import { TRPCError } from "@trpc/server";

import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";

import { middleware, procedure } from "./trpc-server";

const logger = createLogger("trpc.protectedClientProcedure");

const attachAppToken = middleware(async ({ ctx, next }) => {
  if (!ctx.saleorApiUrl) {
    logger.debug("ctx.saleorApiUrl not found, throwing BAD_REQUEST");

    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing saleorApiUrl in request",
    });
  }

  const authData = await saleorApp.apl.get(ctx.saleorApiUrl);

  if (!authData) {
    logger.debug("authData not found in APL, throwing UNAUTHORIZED");

    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing auth data",
    });
  }

  return next({
    ctx: {
      appToken: authData.token,
      saleorApiUrl: authData.saleorApiUrl,
      appId: authData.appId,
    },
  });
});

const validateClientToken = middleware(async ({ ctx, next, meta }) => {
  logger.debug("Calling validateClientToken middleware with permissions required", {
    permissions: meta?.requiredClientPermissions,
  });

  if (!ctx.token) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Missing token in request. This middleware can be used only in frontend",
    });
  }

  if (!ctx.appId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Missing appId in request. This middleware can be used after auth is attached",
    });
  }

  if (!ctx.saleorApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Missing saleorApiUrl in request. This middleware can be used after auth is attached",
    });
  }

  try {
    logger.debug("trying to verify JWT token from frontend", {
      tokenPrefix: ctx.token ? `${ctx.token[0]}...` : undefined,
    });

    await verifyJWT({
      appId: ctx.appId,
      token: ctx.token,
      saleorApiUrl: ctx.saleorApiUrl,
      requiredPermissions: meta?.requiredClientPermissions,
    });
  } catch (e) {
    logger.warn("JWT verification failed, throwing FORBIDDEN", { error: e });
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "JWT verification failed",
    });
  }

  return next({
    ctx: {
      saleorApiUrl: ctx.saleorApiUrl,
    },
  });
});

/**
 * Compose the auth + JWT-validation chain. Order matters:
 *
 *   - `attachAppToken` runs first so `validateClientToken` has the appId from
 *     the APL to feed into `verifyJWT` (Saleor's JWT carries the appId in
 *     the `app` claim and the SDK rejects mismatches).
 *
 * Sub-routers added by T34/T36/T37/T38 build on top of this — e.g.
 * `protectedClientProcedure.input(...).query(...)`.
 */
export const protectedClientProcedure = procedure.use(attachAppToken).use(validateClientToken);
