import { z } from "zod";

/*
 * Schemas + types for the Fief OIDC client surface.
 *
 * Two design goals govern this file:
 *
 *   1. **Latency** — OIDC discovery + JWKS payloads are parsed once per
 *      cache-fill (well-known: every 60 min; JWKS: stale-while-revalidate on
 *      `kid` miss). The schemas below keep parsing minimal: only the fields
 *      the auth-plane actually consumes are validated; everything else is
 *      passed through under `passthrough()` so future Fief schema additions
 *      don't break the cache-fill path.
 *
 *   2. **Branded nominal types** — `AccessToken`, `IdToken`, `RefreshToken`
 *      are branded `string` aliases so call sites cannot swap them. This is
 *      the same pattern as `SaleorApiUrl` in the rest of the monorepo (ADR
 *      0002 in apps/CLAUDE.md).
 *
 * The schemas mirror Fief's `OpenIDProviderMetadata` and `TokenResponse`
 * (defined upstream in `fief/schemas/well_known.py` and `fief/schemas/auth.py`).
 */

// -- Branded primitives --------------------------------------------------------

const accessTokenSchema = z.string().min(1).brand("FiefAccessToken");
const idTokenSchema = z.string().min(1).brand("FiefIdToken");
const refreshTokenSchema = z.string().min(1).brand("FiefRefreshToken");

export type AccessToken = z.infer<typeof accessTokenSchema>;
export type IdToken = z.infer<typeof idTokenSchema>;
export type RefreshToken = z.infer<typeof refreshTokenSchema>;

export const createAccessToken = (raw: string): AccessToken => accessTokenSchema.parse(raw);
export const createIdToken = (raw: string): IdToken => idTokenSchema.parse(raw);
export const createRefreshToken = (raw: string): RefreshToken => refreshTokenSchema.parse(raw);

// -- OIDC discovery -----------------------------------------------------------

/**
 * Subset of `OpenIDProviderMetadata` (RFC 8414 + Fief tenant metadata) that
 * the auth-plane actually reads. Everything else passes through unverified —
 * we don't gate on optional fields the client doesn't act on.
 *
 * `revocation_endpoint` is optional because Fief does not currently expose
 * one (see upstream `fief/apps/auth/routers/well_known.py`); when absent,
 * the client surfaces a `FiefOidcRevokeError` from `revokeToken` rather
 * than guessing a path.
 */
export const oidcDiscoverySchema = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    userinfo_endpoint: z.string().url().optional(),
    jwks_uri: z.string().url(),
    revocation_endpoint: z.string().url().optional(),
    id_token_signing_alg_values_supported: z.array(z.string()).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough();

export type OidcDiscovery = z.infer<typeof oidcDiscoverySchema>;

// -- Token endpoint -----------------------------------------------------------

/**
 * Subset of Fief's `TokenResponse`. `refresh_token` is optional (only present
 * when the original auth request included `offline_access` scope).
 */
export const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.number().int().nonnegative().optional(),
    id_token: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export type RawTokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * Parsed + branded shape that the OIDC client returns to call sites. We keep
 * it as a separate type so the public surface uses branded primitives end to
 * end.
 */
export interface FiefTokenResponse {
  accessToken: AccessToken;
  idToken: IdToken | undefined;
  refreshToken: RefreshToken | undefined;
  expiresIn: number | undefined;
  tokenType: string | undefined;
  scope: string | undefined;
}

// -- JWKS ---------------------------------------------------------------------

/**
 * Minimal RFC 7517 JWK shape. We don't validate the algorithm-specific
 * key-material fields here because `jose.createLocalJWKSet` does that
 * downstream when it imports the key.
 */
export const jwkSchema = z
  .object({
    kid: z.string().min(1).optional(),
    kty: z.string().min(1),
    use: z.string().optional(),
    alg: z.string().optional(),
  })
  .passthrough();

export const jwksSchema = z.object({
  keys: z.array(jwkSchema),
});

export type Jwks = z.infer<typeof jwksSchema>;

// -- Verification -------------------------------------------------------------

/**
 * Caller-supplied options for `verifyIdToken`. `audience` and `issuer` are
 * required to defeat token-mix-up — the connection use-case knows the
 * client_id and Fief tenant origin, so we make the call site spell them out.
 */
export interface VerifyIdTokenOptions {
  audience: string;
  issuer: string;
  /**
   * Optional clock skew tolerance in seconds. Defaults to 30s — the same
   * value `jose` uses internally as `clockTolerance: "30s"`. Exposed because
   * different Saleor deployments have different clock-drift tolerances.
   */
  clockToleranceSeconds?: number;
}

/**
 * Returned shape from `verifyIdToken`. We surface `payload` and `header`
 * separately so the auth-plane can record the `kid` that signed the token
 * for audit purposes (T19 / T47).
 */
export interface VerifyIdTokenResult {
  payload: Record<string, unknown>;
  header: Record<string, unknown>;
}
