import { randomUUID } from "node:crypto";

import { type NextAppRouterHandler } from "@saleor/app-sdk/handlers/next-app-router";
import { SALEOR_API_URL_HEADER, SALEOR_EVENT_HEADER } from "@saleor/app-sdk/headers";

import { loggerContextStore } from "@/lib/logger";

/**
 * Per-request logger context for `saleor-app-fief`.
 *
 * `withLoggerContext` is the App Router middleware that runs the wrapped
 * handler inside an `AsyncLocalStorage` scope, then any `createLogger(...)`
 * call from anywhere in the call tree picks up the bound attributes
 * (`saleorApiUrl`, `correlationId`, `path`, `saleorEvent`) automatically — see
 * the `toLogObj` merge in `./logger.ts`.
 *
 * Intentionally lighter than Stripe's port:
 *   - no `@saleor/apps-otel` (we'd pull observability deps the team has not
 *     adopted) — we hand-pick the two headers we need from `@saleor/app-sdk`
 *   - no Sentry tag mirror
 *
 * Public surface mirrors Stripe's `loggerContext` so call sites stay
 * drop-in compatible if/when the team migrates back to the shared package:
 *   - `loggerContext.set(key, value)` to stash an attribute on the active scope
 *   - `loggerContext.getRawContext()` for inspection (mostly for tests)
 *   - `withLoggerContext(handler)` as the route-level wrapper
 */

class LoggerContext {
  set(key: string, value: unknown): void {
    const store = loggerContextStore.getStore();

    if (!store) {
      /*
       * Outside a wrapped scope — silently no-op rather than throw.
       * Calling code (e.g. a webhook handler invoked under test without the
       * wrapper) should not break, but the value is lost on purpose so it does
       * not leak into a future scope.
       */
      return;
    }
    store[key] = value;
  }

  getRawContext(): Record<string, unknown> {
    return loggerContextStore.getStore() ?? {};
  }

  getSaleorApiUrl(): string | undefined {
    const ctx = this.getRawContext();

    return typeof ctx.saleorApiUrl === "string" ? ctx.saleorApiUrl : undefined;
  }

  getCorrelationId(): string | undefined {
    const ctx = this.getRawContext();

    return typeof ctx.correlationId === "string" ? ctx.correlationId : undefined;
  }
}

export const loggerContext = new LoggerContext();

/**
 * App Router middleware. Composes left-to-right with `compose` from
 * `@saleor/apps-shared/compose`:
 *
 *   export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
 *
 * Each request gets a fresh ALS frame seeded with:
 *   - `correlationId`: a fresh UUID, so DLQ/replay tooling (T11/T51) can trace
 *     a single inbound request across all log lines it produced
 *   - `saleorApiUrl`: from the `saleor-api-url` header (set by Saleor's webhook
 *     dispatcher and by the dashboard for tRPC calls); absent for unauth'd
 *     pings — that's fine, the field is just omitted
 *   - `saleorEvent`: from the `saleor-event` header
 *   - `path`: from the request URL pathname
 */
export const withLoggerContext =
  (handler: NextAppRouterHandler): NextAppRouterHandler =>
  (req) => {
    const initial: Record<string, unknown> = {
      correlationId: randomUUID(),
    };

    const saleorApiUrl = req.headers.get(SALEOR_API_URL_HEADER);

    if (saleorApiUrl) {
      initial.saleorApiUrl = saleorApiUrl;
    }

    const saleorEvent = req.headers.get(SALEOR_EVENT_HEADER);

    if (saleorEvent) {
      initial.saleorEvent = saleorEvent;
    }

    initial.path = req.nextUrl.pathname;

    return loggerContextStore.run(initial, () => handler(req));
  };
