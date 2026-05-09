import { AsyncLocalStorage } from "node:async_hooks";

import { type ILogObj, Logger } from "tslog";

import { env } from "./env";

/**
 * Per-app structured logger for `saleor-app-fief`.
 *
 * Hand-rolled around `tslog` to keep the dep surface minimal — we deliberately
 * do **not** consume `@saleor/apps-logger` because that package's transitive
 * deps pull in `@saleor/apps-otel` (and via the Node entry, the Sentry transport).
 * Per the slim-observability decision in T47 the team has not adopted Sentry or
 * OTel yet; this file mirrors the public surface (`createLogger(name, params?)`)
 * so call sites stay drop-in compatible if/when the team migrates back to the
 * shared package.
 *
 * Shape parity with the Stripe app's `src/lib/logger.ts`:
 *   - `rootLogger` is the singleton tslog `Logger`
 *   - `createLogger(name, params?)` returns a sub-logger with bound attributes
 *   - level is read from `env.APP_LOG_LEVEL`
 *   - log records carry `{ message, attributes }` so transports can serialize uniformly
 *
 * The `loggerContextStore` AsyncLocalStorage instance is exported so
 * `logger-context.ts` (the App Router middleware) can attach per-request
 * bindings (saleorApiUrl, correlationId, path) without a circular import.
 * `toLogObj` below merges the active store contents into `attributes` on every
 * record — that's how a `createLogger(...)` call deep inside a webhook
 * handler picks up `saleorApiUrl` automatically.
 */

export const loggerContextStore = new AsyncLocalStorage<Record<string, unknown>>();

function getMinLevel(level: typeof env.APP_LOG_LEVEL): number {
  switch (level) {
    case "fatal":
      return 6;
    case "error":
      return 5;
    case "warn":
      return 4;
    case "info":
      return 3;
    case "debug":
      return 2;
    case "trace":
      return 1;
    default:
      return 3;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const rootLogger = new Logger<ILogObj>({
  minLevel: getMinLevel(env.APP_LOG_LEVEL),
  hideLogPositionForProduction: true,
  /**
   * Use `hidden` so tslog does not auto-emit pretty-printed lines; transports
   * (console / future Sentry / future OTel-logs exporter) consume the structured
   * record produced by `overwrite.toLogObj` below.
   */
  type: "hidden",
  /**
   * Mirror Stripe's redaction baseline. T50 extends this with Fief-specific keys
   * (`access_token`, `id_token`, `refresh_token`, `code`, `signing_key`, `client_secret`,
   * `webhook_secret`) once it lands.
   */
  maskValuesOfKeys: ["token", "secretKey", "Authorization", "authorization"],
  overwrite: {
    /**
     * Normalize the log object so every record looks like `{ message, attributes }`,
     * regardless of how the caller invoked the logger (string, object, mixed).
     * `attributes` merges (in precedence order, lowest first):
     *   - the current AsyncLocalStorage scope (`loggerContextStore`) — per-request
     *     bindings from `withLoggerContext` (saleorApiUrl, correlationId, path,
     *     plus anything the route handler `loggerContext.set`s)
     *   - the parent (sub-logger) bindings captured at `getSubLogger(...)` time
     *   - the per-call attributes argument
     *
     * This is how a `createLogger("foo")` call deep inside a wrapped handler
     * picks up the request's saleorApiUrl without anyone having to thread it
     * through the call stack.
     */
    toLogObj(args, log) {
      const message = args.find((arg) => typeof arg === "string");
      const attributesFromCall = (args.find(isPlainObject) as Record<string, unknown>) ?? {};
      const parentAttributes = (log ?? {}) as Record<string, unknown>;
      const requestScope = loggerContextStore.getStore() ?? {};

      return {
        ...log,
        message,
        attributes: {
          ...requestScope,
          ...parentAttributes,
          ...attributesFromCall,
        },
      };
    },
  },
});

/**
 * Create a named child logger. `name` lands on the bound payload so transports
 * can render `[fief.webhook.customer-created]`-style prefixes; `params` is an
 * optional bag of stable attributes to attach to every record from this child.
 */
export const createLogger = (name: string, params?: Record<string, unknown>) =>
  rootLogger.getSubLogger(
    {
      name,
    },
    { name, ...(params ?? {}) },
  );
