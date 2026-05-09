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

/**
 * T50 — Fief-specific redaction.
 *
 * `MASK_PLACEHOLDER` matches tslog's default so tests and existing Stripe-app
 * call sites see the same `[***]` token regardless of which redaction path
 * fires (built-in `maskValuesOfKeys` baseline keys vs the custom Fief keys
 * walked by `redactFiefSecrets`).
 */
export const MASK_PLACEHOLDER = "[***]";

/**
 * Keys whose values are full-redacted at any nesting depth. These are the
 * Fief-specific tokens/secrets enumerated in T50 plus the Stripe-app baseline
 * (`token`, `secretKey`, `Authorization`) preserved from T47. Comparison is
 * case-sensitive — the surfaces that emit these keys (Fief OIDC payloads,
 * webhook signatures, manifest configs) all use `snake_case` already.
 */
const FULL_REDACT_KEYS = new Set([
  // T47 baseline (was `maskValuesOfKeys`)
  "token",
  "secretKey",
  "Authorization",
  "authorization",
  // T50 — Fief integration secrets
  "access_token",
  "id_token",
  "refresh_token",
  "code",
  "signing_key",
  "client_secret",
  "webhook_secret",
]);

/**
 * Keys whose values are partial-redacted: the four-segment branding-origin
 * parameter `"{origin}.{nonce}.{expiry}.{sig}"` keeps the first three segments
 * visible for diagnostics and replaces only the signature with the placeholder.
 * Malformed values (anything other than exactly four `.`-separated segments)
 * are full-redacted to fail safe.
 */
const PARTIAL_REDACT_KEYS = new Set(["branding_origin"]);

function redactBrandingOrigin(value: unknown): unknown {
  if (typeof value !== "string") {
    return MASK_PLACEHOLDER;
  }

  const segments = value.split(".");

  if (segments.length !== 4) {
    /*
     * Conservative fallback — if the shape doesn't match the documented
     * `{origin}.{nonce}.{expiry}.{sig}` parameter, redact wholesale.
     */
    return MASK_PLACEHOLDER;
  }

  return `${segments[0]}.${segments[1]}.${segments[2]}.${MASK_PLACEHOLDER}`;
}

/**
 * Recursively clone `source` and redact any matching keys. Mirrors tslog's
 * own `_recursiveCloneAndMaskValuesOfKeys` semantics for `Map` / `Set` /
 * `Date` / `URL` / `Error` / `Buffer` / circular-reference handling so we
 * don't regress on non-plain-object payloads. The reason we replace the
 * built-in `_mask` (via `overwrite.mask`) rather than extending
 * `maskValuesOfKeys` is the partial-redact for `branding_origin` — the
 * built-in only supports full-value replacement.
 */
function redactFiefSecrets(source: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (source === null || typeof source !== "object") {
    return source;
  }

  if (seen.has(source)) {
    // Cycle: return a shallow copy so downstream serializers don't recurse.
    return Array.isArray(source) ? [...source] : { ...(source as Record<string, unknown>) };
  }

  seen.add(source);

  if (source instanceof Error || source instanceof Map || source instanceof Set) {
    return source;
  }

  if (source instanceof Date) {
    return new Date(source.getTime());
  }

  if (source instanceof URL) {
    return source;
  }

  if (Array.isArray(source)) {
    return source.map((item) => redactFiefSecrets(item, seen));
  }

  const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(source));
  const record = source as Record<string, unknown>;

  for (const key of Object.getOwnPropertyNames(record)) {
    if (FULL_REDACT_KEYS.has(key)) {
      out[key] = MASK_PLACEHOLDER;
      continue;
    }

    if (PARTIAL_REDACT_KEYS.has(key)) {
      out[key] = redactBrandingOrigin(record[key]);
      continue;
    }

    out[key] = redactFiefSecrets(record[key], seen);
  }

  return out;
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
   * Placeholder declared to keep tslog's internal default and our explicit
   * `MASK_PLACEHOLDER` constant in sync. The actual redaction list lives in
   * `overwrite.mask` below — that hook short-circuits the built-in
   * `maskValuesOfKeys` walker (see `BaseLogger#log`), which is necessary because
   * the built-in only supports full-value replacement and `branding_origin`
   * needs to keep its first three segments visible.
   */
  maskPlaceholder: MASK_PLACEHOLDER,
  overwrite: {
    /**
     * T50 — replace tslog's `_mask` with the Fief-aware walker so we can
     * partial-redact `branding_origin` while still full-redacting every other
     * sensitive key (Fief tokens + the T47 baseline `token` / `secretKey` /
     * `Authorization`). Runs BEFORE `toLogObj`, so the masked payload is what
     * `attributes` ultimately carries.
     */
    mask(args) {
      return args.map((arg) => redactFiefSecrets(arg));
    },
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
