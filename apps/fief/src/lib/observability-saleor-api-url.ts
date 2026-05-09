import { type NextAppRouterHandler } from "@saleor/app-sdk/handlers/next-app-router";
import { SALEOR_API_URL_HEADER, SALEOR_SCHEMA_VERSION_HEADER } from "@saleor/app-sdk/headers";

import { loggerContext } from "./logger-context";

/**
 * `withSaleorApiUrlAttributes` — App Router middleware that mirrors Stripe's
 * `withSpanAttributesAppRouter` but **only** feeds the logger context.
 *
 * Slim variant per T47:
 *   - no OTel span attributes (no OTel installed)
 *   - no Sentry user mirroring (no Sentry installed)
 *
 * Public surface:
 *   - signature `(handler) => handler` so it composes with `withLoggerContext`
 *     via `@saleor/apps-shared/compose`:
 *
 *       export const POST = compose(
 *         withLoggerContext,
 *         withSaleorApiUrlAttributes,
 *       )(handler);
 *
 * The middleware reads two Saleor headers and stashes them on the active
 * logger-context scope. Any subsequent `createLogger(...)` call inside the
 * handler picks them up automatically (see `toLogObj` merge in `./logger.ts`).
 *
 * `withLoggerContext` already extracts `saleorApiUrl` from the same header
 * — we re-set it here so the middleware is order-independent (composing in
 * either order produces the same observable bindings) and so it can be
 * adopted on tRPC/non-webhook routes that opt out of the full webhook wrapper.
 */
export const withSaleorApiUrlAttributes =
  (handler: NextAppRouterHandler): NextAppRouterHandler =>
  (req) => {
    const saleorApiUrl = req.headers.get(SALEOR_API_URL_HEADER);
    const saleorVersion = req.headers.get(SALEOR_SCHEMA_VERSION_HEADER);

    if (saleorApiUrl) {
      loggerContext.set("saleorApiUrl", saleorApiUrl);
    }

    if (saleorVersion) {
      loggerContext.set("saleorVersion", saleorVersion);
    }

    return handler(req);
  };
