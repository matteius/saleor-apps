import { BaseError } from "@/lib/errors";

/*
 * Typed error tree for the Fief OIDC client (`oidc-client.ts`).
 *
 * Rationale: every public method on the client returns
 * `Result<T, FiefOidcError>` (neverthrow) — call sites in the auth-plane hot
 * path (T18-T21) need to discriminate cleanly between transport failures
 * (retryable), upstream-rejected requests (e.g. expired auth code, all client
 * secrets failed), and internal bugs (malformed discovery doc, JWKS lookup for
 * unknown `kid`, etc.) without leaking provider-specific exception shapes.
 *
 * The shape mirrors the conventions in `src/modules/crypto/encryptor.ts` —
 * `BaseError.subclass(...)` with a unique `_brand` prop so `match`-style call
 * sites can branch on the brand string.
 *
 * Public surface: callers should use the union alias `FiefOidcError` (below).
 * Specific subclasses are exported for `instanceof` narrowing in tests and
 * structured logging.
 */

/**
 * Base error for the OIDC client. Not thrown directly — every leaf subclass
 * below extends this so handlers can do `err instanceof FiefOidcClientError`
 * to scope OIDC failures.
 */
export const FiefOidcClientError = BaseError.subclass("FiefOidcClientError", {
  props: {
    _brand: "FiefApp.FiefOidcClientError" as const,
  },
});

/**
 * Discovery / well-known endpoint failures.
 *
 * Raised when `/.well-known/openid-configuration` cannot be fetched, returns a
 * non-2xx response, or yields a payload that does not satisfy the metadata
 * schema (missing required endpoints, etc.). Pre-warm + background refresh
 * use this so a transient discovery outage does not cascade into the auth
 * plane (the cache keeps serving the last good document).
 */
export const FiefOidcDiscoveryError = FiefOidcClientError.subclass("FiefOidcDiscoveryError", {
  props: {
    _brand: "FiefApp.FiefOidcDiscoveryError" as const,
  },
});

/**
 * JWKS / signing-key lookup failures.
 *
 * Raised when the JWKS endpoint cannot be fetched, or when an ID token's
 * `kid` is not present in the cached set even after a forced refresh. The
 * stale-while-revalidate strategy in the client minimizes the chance of this
 * during normal operation; when it surfaces, it usually indicates a key
 * rollover the client missed, or a token signed by a different tenant.
 */
export const FiefOidcJwksError = FiefOidcClientError.subclass("FiefOidcJwksError", {
  props: {
    _brand: "FiefApp.FiefOidcJwksError" as const,
  },
});

/**
 * `/token` endpoint failures.
 *
 * Raised when both the current and the optional pending client secret have
 * been tried and neither succeeded — i.e. the upstream consistently rejected
 * the credentials. Also raised on transport failures or a malformed
 * `TokenResponse`. `cause` carries the raw upstream error payload so the
 * connection-rotation use-case (T17) can distinguish "secret rejected" from
 * "network blip".
 */
export const FiefOidcTokenError = FiefOidcClientError.subclass("FiefOidcTokenError", {
  props: {
    _brand: "FiefApp.FiefOidcTokenError" as const,
  },
});

/**
 * `/revoke` endpoint failures (best-effort path).
 *
 * Per RFC 7009, revocation is best-effort and should not block sign-out. This
 * error class exists so the Saleor-side logout handler (T21) can log + move
 * on rather than 500 the user-facing flow when Fief is down. Also raised when
 * the discovery document does not advertise a `revocation_endpoint` and the
 * caller asked for a strict revoke.
 */
export const FiefOidcRevokeError = FiefOidcClientError.subclass("FiefOidcRevokeError", {
  props: {
    _brand: "FiefApp.FiefOidcRevokeError" as const,
  },
});

/**
 * ID-token verification failures.
 *
 * Raised on signature mismatch, invalid `iss`, expired `exp`, malformed JWT
 * structure — any condition that means we cannot trust the token's claims.
 * Distinct from `FiefOidcTokenError` so handlers can fail closed on token
 * verification while degrading more gracefully on transient `/token` issues.
 */
export const FiefOidcVerifyError = FiefOidcClientError.subclass("FiefOidcVerifyError", {
  props: {
    _brand: "FiefApp.FiefOidcVerifyError" as const,
  },
});

/**
 * Discriminated union for `Result<T, FiefOidcError>` return types. All errors
 * raised by the OIDC client narrow to one of the five subclasses above.
 */
export type FiefOidcError =
  | InstanceType<typeof FiefOidcDiscoveryError>
  | InstanceType<typeof FiefOidcJwksError>
  | InstanceType<typeof FiefOidcTokenError>
  | InstanceType<typeof FiefOidcRevokeError>
  | InstanceType<typeof FiefOidcVerifyError>;
