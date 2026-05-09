/**
 * App Router tRPC route handler for `saleor-app-fief` (T33).
 *
 * Wired exactly like Stripe's port, with the slim-observability swap from
 * T47: instead of `withSpanAttributesAppRouter` (OTel) we compose
 * `withSaleorApiUrlAttributes` so the per-request logger picks up the
 * `saleorApiUrl` + `saleorVersion` headers automatically. `withLoggerContext`
 * still seeds the `correlationId` and runs the rest of the handler inside an
 * `AsyncLocalStorage` scope.
 *
 * Endpoint path matches the dashboard iframe's expectations
 * (`@saleor/apps-trpc/http-batch-link` posts to `/api/trpc`).
 */
import { compose } from "@saleor/apps-shared/compose";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { createTrpcContextAppRouter } from "@/modules/trpc/context-app-router";
import { trpcRouter } from "@/modules/trpc/trpc-router";

const logger = createLogger("trpcHandler");

const handler = (request: Request) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: trpcRouter,
    createContext: createTrpcContextAppRouter,
    onError: ({ path, error }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        logger.error(`${path} returned INTERNAL_SERVER_ERROR`, {
          trpcErrorMessage: error.message,
          trpcErrorCode: error.code,
          trpcErrorName: error.name,
        });

        return;
      }

      logger.debug(`${path} returned ${error.code}`, {
        trpcErrorMessage: error.message,
        trpcErrorCode: error.code,
      });
    },
  });
};

const wrappedHandler = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);

export { wrappedHandler as GET, wrappedHandler as POST };
