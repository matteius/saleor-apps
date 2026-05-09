import { BaseError } from "@/lib/errors";

/*
 * Error hierarchy for the Fief admin REST API client (T5).
 *
 * The wrapper returns `Result<T, FiefAdminApiError>` so callers can switch on
 * the concrete subclass and decide whether to retry / surface to the operator.
 *
 * Naming follows `BaseError.subclass(...)` with a `_internalName` prop so the
 * structured logger (T47) can flatten error chains without leaking stack
 * frames. Every subclass also stamps `_brand` for nominal identification when
 * inspected via `instanceof` is awkward (e.g. across worker boundaries).
 */

export const FiefAdminApiErrorPublicCode = "FiefAdminApiError" as const;

export const FiefAdminApiError = BaseError.subclass("FiefAdminApiError", {
  props: {
    _internalName: "FiefAdminApiClient.FiefAdminApiError" as const,
    _brand: "FiefAdminApiClient.FiefAdminApiError" as const,
    publicCode: FiefAdminApiErrorPublicCode,
  },
});

export const FiefAdminApiNetworkError = FiefAdminApiError.subclass("FiefAdminApiNetworkError", {
  props: {
    _internalName: "FiefAdminApiClient.NetworkError" as const,
    _brand: "FiefAdminApiClient.NetworkError" as const,
  },
});

export const FiefAdminApiTimeoutError = FiefAdminApiError.subclass("FiefAdminApiTimeoutError", {
  props: {
    _internalName: "FiefAdminApiClient.TimeoutError" as const,
    _brand: "FiefAdminApiClient.TimeoutError" as const,
  },
});

/*
 * 4xx — caller-attributable. Carries the HTTP status + parsed Fief error body
 * (Fief returns `{ detail: string }` or `{ detail: string, reason: string[] }`
 * depending on the endpoint). Auth failures (401/403) are folded in here too,
 * because the wrapper is config-agnostic and cannot decide rotation policy.
 */
export const FiefAdminApiClientError = FiefAdminApiError.subclass("FiefAdminApiClientError", {
  props: {
    _internalName: "FiefAdminApiClient.ClientError" as const,
    _brand: "FiefAdminApiClient.ClientError" as const,
    statusCode: 0,
    detail: "" as string | null,
  },
});

/* 401 / 403 — separate so the rotation use-case (T17) can pattern-match. */
export const FiefAdminApiUnauthorizedError = FiefAdminApiClientError.subclass(
  "FiefAdminApiUnauthorizedError",
  {
    props: {
      _internalName: "FiefAdminApiClient.UnauthorizedError" as const,
      _brand: "FiefAdminApiClient.UnauthorizedError" as const,
    },
  },
);

export const FiefAdminApiNotFoundError = FiefAdminApiClientError.subclass(
  "FiefAdminApiNotFoundError",
  {
    props: {
      _internalName: "FiefAdminApiClient.NotFoundError" as const,
      _brand: "FiefAdminApiClient.NotFoundError" as const,
    },
  },
);

/*
 * 5xx — server-side / retryable upstream. Surfaced after the bounded retry
 * budget is exhausted.
 */
export const FiefAdminApiServerError = FiefAdminApiError.subclass("FiefAdminApiServerError", {
  props: {
    _internalName: "FiefAdminApiClient.ServerError" as const,
    _brand: "FiefAdminApiClient.ServerError" as const,
    statusCode: 0,
    detail: "" as string | null,
  },
});

/*
 * 429 — explicit rate-limit. Same retry semantics as 5xx but kept separate
 * so observability can graph quota pressure.
 */
export const FiefAdminApiRateLimitError = FiefAdminApiError.subclass("FiefAdminApiRateLimitError", {
  props: {
    _internalName: "FiefAdminApiClient.RateLimitError" as const,
    _brand: "FiefAdminApiClient.RateLimitError" as const,
    statusCode: 429,
    detail: "" as string | null,
  },
});

/*
 * Response payload didn't match the expected Zod schema. Most likely a Fief
 * version drift — flagged in PRD risk R6.
 */
export const FiefAdminApiSchemaError = FiefAdminApiError.subclass("FiefAdminApiSchemaError", {
  props: {
    _internalName: "FiefAdminApiClient.SchemaError" as const,
    _brand: "FiefAdminApiClient.SchemaError" as const,
  },
});

export type AnyFiefAdminApiError = InstanceType<
  | typeof FiefAdminApiError
  | typeof FiefAdminApiNetworkError
  | typeof FiefAdminApiTimeoutError
  | typeof FiefAdminApiClientError
  | typeof FiefAdminApiUnauthorizedError
  | typeof FiefAdminApiNotFoundError
  | typeof FiefAdminApiServerError
  | typeof FiefAdminApiRateLimitError
  | typeof FiefAdminApiSchemaError
>;
