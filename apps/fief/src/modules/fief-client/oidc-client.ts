import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from "jose";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";

import {
  FiefOidcDiscoveryError,
  type FiefOidcError,
  FiefOidcJwksError,
  FiefOidcRevokeError,
  FiefOidcTokenError,
  FiefOidcVerifyError,
} from "./oidc-errors";
import {
  createAccessToken,
  createIdToken,
  createRefreshToken,
  type FiefTokenResponse,
  type Jwks,
  jwksSchema,
  type OidcDiscovery,
  oidcDiscoverySchema,
  tokenResponseSchema,
  type VerifyIdTokenOptions,
  type VerifyIdTokenResult,
} from "./oidc-types";

/*
 * Re-export error classes so test code (and future callers) can grab them via
 * the oidc-client surface without reaching into ./oidc-errors directly.
 */
export {
  FiefOidcDiscoveryError,
  type FiefOidcError,
  FiefOidcJwksError,
  FiefOidcRevokeError,
  FiefOidcTokenError,
  FiefOidcVerifyError,
};

/*
 * Fief OIDC client wrapper — auth-plane hot path.
 *
 * What lives in this file
 * -----------------------
 *
 *   - `FiefOidcClient`        — public class. One instance per Fief tenant
 *                               (`baseUrl`). Designed to live for the lifetime
 *                               of the Node process.
 *   - `prewarm`               — cold-start helper used by instrumentation
 *                               boot (T47 / Next.js `instrumentation.ts`) so
 *                               the first user-facing request does not pay
 *                               discovery + JWKS latency.
 *   - `exchangeCode`          — `grant_type=authorization_code` with
 *                               `client_secret_post`, dual-secret iteration.
 *   - `refreshToken`          — `grant_type=refresh_token`, same iteration.
 *   - `revokeToken`           — RFC 7009 best-effort revoke; only when the
 *                               discovery doc advertises `revocation_endpoint`.
 *   - `verifyIdToken`         — `jose.jwtVerify` against cached JWKS, with a
 *                               single forced refresh on `kid` miss for key
 *                               rollover.
 *
 * Caching
 * -------
 *
 *   - **Discovery**: TTL = 60 min (configurable). After TTL, a stale doc is
 *     returned synchronously while a background refresh runs — call sites in
 *     the auth plane never block on a cache miss after the first warm-up.
 *     A failed background refresh keeps the previous good doc in place
 *     (logs at `error` level).
 *
 *   - **JWKS**: keyed by `kid`. SWR semantics: a valid `kid` returns the
 *     cached set instantly. An unknown `kid` triggers a single forced
 *     refresh (concurrent verifies de-dupe via the in-flight promise) before
 *     failing closed with `FiefOidcJwksError`.
 *
 * Performance notes
 * -----------------
 *
 *   - Uses Node global `fetch` (Next.js / Node 20+). Token + revoke responses
 *     are read with `await response.json()` — single allocation, no streaming
 *     parser overhead since payloads are < 4 KB.
 *
 *   - URLSearchParams bodies are constructed once per call; no JSON
 *     stringify/parse round-trips on the request side.
 *
 *   - The discovery + JWKS caches store *parsed* shapes. We do not re-validate
 *     on every read.
 *
 * Why client-side iteration of secrets (instead of, say, client_secret_basic
 * + a single header)
 * ---------------------------------------------------------------------------
 *
 * T17 implements two-step rotation: a `pending` secret is provisioned and
 * Fief is configured to accept *both* the `current` and `pending` secrets
 * (Fief 0.x supports a single client secret per client, so we do this on the
 * client side). The auth plane sends the `current` secret first; if Fief
 * rejects it (the operator promoted `pending` → `current` upstream during the
 * rotation window) we fall back to `pending` rather than failing the user
 * mid-flow. Once T17 detects N successful uses of `pending`, it promotes it.
 */

const DEFAULT_DISCOVERY_TTL_MS = 60 * 60 * 1000; // 60 min
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000;

export interface FiefOidcClientInput {
  /**
   * Fief tenant base URL, e.g. `https://tenant.example.com`. Discovery will
   * be fetched from `${baseUrl}/.well-known/openid-configuration`.
   */
  baseUrl: string;
  /**
   * Discovery cache TTL in milliseconds. After this elapses a background
   * refresh is kicked off; cached value still serves until the refresh
   * completes. Default: 60 min.
   */
  discoveryTtlMs?: number;
  /**
   * Per-request fetch timeout in milliseconds. Default: 10 s.
   */
  requestTimeoutMs?: number;
  /**
   * Optional fetch implementation override — wired in tests when a global
   * `fetch` interceptor is not available. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
  clientId: string;
  /**
   * Ordered list of client secrets to try. The first secret is the "current"
   * one; subsequent entries are pending-rotation slots. The client iterates
   * in order on 401/invalid_client and returns the first success. **Empty
   * arrays are rejected** (returns `FiefOidcTokenError`).
   */
  clientSecrets: string[];
}

export interface RefreshTokenInput {
  refreshToken: string;
  clientId: string;
  clientSecrets: string[];
  /** Optional space-separated scope list; passed through to Fief. */
  scope?: string;
}

export interface RevokeTokenInput {
  token: string;
  /** Hint per RFC 7009 — `access_token` or `refresh_token`. Fief accepts both. */
  tokenTypeHint?: "access_token" | "refresh_token";
  clientId: string;
  clientSecrets: string[];
}

interface DiscoveryCacheEntry {
  fetchedAt: number;
  value: OidcDiscovery;
}

export class FiefOidcClient {
  private readonly logger = createLogger("FiefOidcClient");

  private readonly baseUrl: string;
  private readonly discoveryTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Last successfully fetched discovery doc. `undefined` only on cold start. */
  private discoveryCache: DiscoveryCacheEntry | undefined;

  /** In-flight discovery fetch — used to dedupe concurrent cold-start callers. */
  private discoveryInFlight: Promise<Result<OidcDiscovery, FiefOidcError>> | undefined;

  /** Last fetched JWKS payload. Source of truth for `verifyIdToken`. */
  private jwksCache: Jwks | undefined;
  private jwksFetchedAt = 0;
  private jwksInFlight: Promise<Result<Jwks, FiefOidcError>> | undefined;

  constructor(input: FiefOidcClientInput) {
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.discoveryTtlMs = input.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS;
    this.requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    /*
     * Default to the global fetch — Node 20+ provides it. Tests using msw
     * intercept the global so this path is exercised end-to-end.
     */
    this.fetchImpl = input.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  /*
   * ---------------------------------------------------------------------------
   * Public surface
   * ---------------------------------------------------------------------------
   */

  /**
   * Cold-start helper. Fetches discovery + JWKS so the first user-facing
   * request does not pay either round-trip. Safe to call repeatedly — caches
   * are reused. Returns `Result` so the boot sequence can log + continue
   * even if Fief is briefly down at startup.
   */
  async prewarm(): Promise<Result<void, FiefOidcError>> {
    return appInternalTracer.startActiveSpan("FiefOidcClient.prewarm", async () => {
      const discoveryResult = await this.getDiscovery({ forceFresh: true });

      if (discoveryResult.isErr()) {
        return err(discoveryResult.error);
      }

      const jwksResult = await this.fetchJwks(discoveryResult.value.jwks_uri);

      if (jwksResult.isErr()) {
        return err(jwksResult.error);
      }

      return ok(undefined);
    });
  }

  /**
   * `grant_type=authorization_code` exchange. Iterates `clientSecrets` until
   * one is accepted; if all return 401/invalid_client (or any non-2xx),
   * returns the last upstream error wrapped as `FiefOidcTokenError`.
   */
  async exchangeCode(input: ExchangeCodeInput): Promise<Result<FiefTokenResponse, FiefOidcError>> {
    return appInternalTracer.startActiveSpan("FiefOidcClient.exchangeCode", async () => {
      if (input.clientSecrets.length === 0) {
        return err(new FiefOidcTokenError("exchangeCode requires at least one client secret"));
      }

      const discoveryResult = await this.getDiscovery({ forceFresh: false });

      if (discoveryResult.isErr()) {
        return err(discoveryResult.error);
      }

      const tokenEndpoint = discoveryResult.value.token_endpoint;
      const buildBody = (clientSecret: string) => {
        const body = new URLSearchParams();

        body.set("grant_type", "authorization_code");
        body.set("code", input.code);
        body.set("redirect_uri", input.redirectUri);
        body.set("client_id", input.clientId);
        body.set("client_secret", clientSecret);

        return body;
      };

      return this.tryEachSecret(tokenEndpoint, input.clientSecrets, buildBody);
    });
  }

  /**
   * `grant_type=refresh_token`. Same dual-secret iteration as `exchangeCode`.
   */
  async refreshToken(input: RefreshTokenInput): Promise<Result<FiefTokenResponse, FiefOidcError>> {
    return appInternalTracer.startActiveSpan("FiefOidcClient.refreshToken", async () => {
      if (input.clientSecrets.length === 0) {
        return err(new FiefOidcTokenError("refreshToken requires at least one client secret"));
      }

      const discoveryResult = await this.getDiscovery({ forceFresh: false });

      if (discoveryResult.isErr()) {
        return err(discoveryResult.error);
      }

      const tokenEndpoint = discoveryResult.value.token_endpoint;
      const buildBody = (clientSecret: string) => {
        const body = new URLSearchParams();

        body.set("grant_type", "refresh_token");
        body.set("refresh_token", input.refreshToken);
        body.set("client_id", input.clientId);
        body.set("client_secret", clientSecret);

        if (input.scope !== undefined) {
          body.set("scope", input.scope);
        }

        return body;
      };

      return this.tryEachSecret(tokenEndpoint, input.clientSecrets, buildBody);
    });
  }

  /**
   * RFC 7009 revocation. Best-effort: 200 → ok; any other outcome wraps as
   * `FiefOidcRevokeError`. **Special-cased** when the discovery doc does not
   * advertise `revocation_endpoint` — Fief 0.x does not expose one — we
   * surface a typed error so the logout handler (T21) can degrade to "clear
   * local session, log warn, return 200" rather than guessing a path.
   */
  async revokeToken(input: RevokeTokenInput): Promise<Result<void, FiefOidcError>> {
    return appInternalTracer.startActiveSpan("FiefOidcClient.revokeToken", async () => {
      if (input.clientSecrets.length === 0) {
        return err(new FiefOidcRevokeError("revokeToken requires at least one client secret"));
      }

      const discoveryResult = await this.getDiscovery({ forceFresh: false });

      if (discoveryResult.isErr()) {
        return err(discoveryResult.error);
      }

      const revocationEndpoint = discoveryResult.value.revocation_endpoint;

      if (!revocationEndpoint) {
        return err(
          new FiefOidcRevokeError("Discovery document does not advertise a revocation_endpoint"),
        );
      }

      let lastError: InstanceType<typeof FiefOidcRevokeError> | undefined;

      for (const secret of input.clientSecrets) {
        const body = new URLSearchParams();

        body.set("token", input.token);
        if (input.tokenTypeHint !== undefined) {
          body.set("token_type_hint", input.tokenTypeHint);
        }
        body.set("client_id", input.clientId);
        body.set("client_secret", secret);

        const response = await this.postForm(revocationEndpoint, body);

        if (response.isErr()) {
          lastError = new FiefOidcRevokeError("Network error during token revocation", {
            cause: response.error,
          });
          continue;
        }

        if (response.value.ok) {
          return ok(undefined);
        }

        if (response.value.status === 401) {
          // Try the next secret in the rotation set.
          lastError = new FiefOidcRevokeError(
            `Revoke rejected with 401 (secret index exhausted; will try next)`,
          );
          continue;
        }

        lastError = new FiefOidcRevokeError(
          `Revoke endpoint returned non-2xx: ${response.value.status}`,
        );
        // RFC 7009 §2.2: a non-401 error is terminal — do not retry with another secret.
        break;
      }

      return err(lastError ?? new FiefOidcRevokeError("Revoke failed for unknown reason"));
    });
  }

  /**
   * Verifies an ID token against the cached JWKS. On `kid` miss, forces a
   * single JWKS refresh (covers key rollover) before failing closed.
   */
  async verifyIdToken(
    token: string,
    options: VerifyIdTokenOptions,
  ): Promise<Result<VerifyIdTokenResult, FiefOidcError>> {
    return appInternalTracer.startActiveSpan("FiefOidcClient.verifyIdToken", async () => {
      const discoveryResult = await this.getDiscovery({ forceFresh: false });

      if (discoveryResult.isErr()) {
        return err(discoveryResult.error);
      }

      let header: ReturnType<typeof decodeProtectedHeader>;

      try {
        header = decodeProtectedHeader(token);
      } catch (cause) {
        return err(new FiefOidcVerifyError("ID token has malformed header", { cause }));
      }

      const tokenKid = header.kid;
      const jwksResult = await this.getJwksForKid(tokenKid, discoveryResult.value.jwks_uri);

      if (jwksResult.isErr()) {
        return err(jwksResult.error);
      }

      const localJwks = createLocalJWKSet({ keys: jwksResult.value.keys } as JSONWebKeySet);

      try {
        const verified = await jwtVerify(token, localJwks, {
          audience: options.audience,
          issuer: options.issuer,
          clockTolerance: `${options.clockToleranceSeconds ?? 30}s`,
        });

        return ok({
          payload: verified.payload as Record<string, unknown>,
          header: verified.protectedHeader as Record<string, unknown>,
        });
      } catch (cause) {
        return err(new FiefOidcVerifyError("ID token verification failed", { cause }));
      }
    });
  }

  /*
   * ---------------------------------------------------------------------------
   * Internal — discovery cache
   * ---------------------------------------------------------------------------
   */

  /**
   * Returns the current discovery doc, fetching/refreshing as needed.
   *
   * Cache strategy:
   *   - Empty cache: dedupe via `discoveryInFlight` so a thundering herd of
   *     cold-start requests share one fetch.
   *   - Fresh (within TTL): return immediately, no network.
   *   - Stale: return cached value synchronously, kick off background refresh
   *     (fire-and-forget). If the refresh fails, the cache is unchanged.
   *   - `forceFresh: true`: blocks on a fresh fetch (used by `prewarm`).
   */
  private async getDiscovery({
    forceFresh,
  }: {
    forceFresh: boolean;
  }): Promise<Result<OidcDiscovery, FiefOidcError>> {
    if (!forceFresh && this.discoveryCache !== undefined) {
      const ageMs = Date.now() - this.discoveryCache.fetchedAt;

      if (ageMs < this.discoveryTtlMs) {
        return ok(this.discoveryCache.value);
      }

      // Stale — kick off background refresh, return cached value now.
      if (this.discoveryInFlight === undefined) {
        this.discoveryInFlight = this.fetchDiscovery().finally(() => {
          this.discoveryInFlight = undefined;
        });
        // Intentional: we do not await. Background refresh result is logged.
        this.discoveryInFlight.then((result) => {
          if (result.isErr()) {
            this.logger.error("Background discovery refresh failed; serving stale", {
              error: result.error,
            });
          }
        });
      }

      return ok(this.discoveryCache.value);
    }

    // Cold start (or forceFresh). Dedupe concurrent callers.
    if (this.discoveryInFlight === undefined) {
      this.discoveryInFlight = this.fetchDiscovery().finally(() => {
        this.discoveryInFlight = undefined;
      });
    }

    return this.discoveryInFlight;
  }

  private async fetchDiscovery(): Promise<Result<OidcDiscovery, FiefOidcError>> {
    const url = `${this.baseUrl}/.well-known/openid-configuration`;
    const response = await this.safeFetch(url, { method: "GET" });

    if (response.isErr()) {
      return err(
        new FiefOidcDiscoveryError("Network error fetching discovery document", {
          cause: response.error,
        }),
      );
    }

    if (!response.value.ok) {
      return err(
        new FiefOidcDiscoveryError(`Discovery endpoint returned non-2xx: ${response.value.status}`),
      );
    }

    let raw: unknown;

    try {
      raw = await response.value.json();
    } catch (cause) {
      return err(new FiefOidcDiscoveryError("Discovery response was not valid JSON", { cause }));
    }

    const parsed = oidcDiscoverySchema.safeParse(raw);

    if (!parsed.success) {
      return err(
        new FiefOidcDiscoveryError("Discovery document failed schema validation", {
          cause: parsed.error,
        }),
      );
    }

    this.discoveryCache = {
      fetchedAt: Date.now(),
      value: parsed.data,
    };

    return ok(parsed.data);
  }

  /*
   * ---------------------------------------------------------------------------
   * Internal — JWKS cache
   * ---------------------------------------------------------------------------
   */

  /**
   * Returns a JWKS that contains `kid`. If `kid` is `undefined` (token has no
   * `kid` header — uncommon but legal) returns whatever is cached, fetching
   * if cold. If the cached set lacks `kid` we force exactly one refresh; if
   * the refreshed set still lacks it, we fail with `FiefOidcJwksError`.
   */
  private async getJwksForKid(
    kid: string | undefined,
    jwksUri: string,
  ): Promise<Result<Jwks, FiefOidcError>> {
    if (this.jwksCache !== undefined && (kid === undefined || this.hasKid(this.jwksCache, kid))) {
      return ok(this.jwksCache);
    }

    const refreshed = await this.fetchJwks(jwksUri);

    if (refreshed.isErr()) {
      return err(refreshed.error);
    }

    if (kid !== undefined && !this.hasKid(refreshed.value, kid)) {
      return err(new FiefOidcJwksError(`No JWKS key matches kid="${kid}" after forced refresh`));
    }

    return ok(refreshed.value);
  }

  private hasKid(jwks: Jwks, kid: string): boolean {
    for (const key of jwks.keys) {
      if (key.kid === kid) return true;
    }

    return false;
  }

  private async fetchJwks(jwksUri: string): Promise<Result<Jwks, FiefOidcError>> {
    if (this.jwksInFlight !== undefined) {
      return this.jwksInFlight;
    }

    this.jwksInFlight = this.doFetchJwks(jwksUri).finally(() => {
      this.jwksInFlight = undefined;
    });

    return this.jwksInFlight;
  }

  private async doFetchJwks(jwksUri: string): Promise<Result<Jwks, FiefOidcError>> {
    const response = await this.safeFetch(jwksUri, { method: "GET" });

    if (response.isErr()) {
      return err(new FiefOidcJwksError("Network error fetching JWKS", { cause: response.error }));
    }

    if (!response.value.ok) {
      return err(new FiefOidcJwksError(`JWKS endpoint returned non-2xx: ${response.value.status}`));
    }

    let raw: unknown;

    try {
      raw = await response.value.json();
    } catch (cause) {
      return err(new FiefOidcJwksError("JWKS response was not valid JSON", { cause }));
    }

    const parsed = jwksSchema.safeParse(raw);

    if (!parsed.success) {
      return err(
        new FiefOidcJwksError("JWKS payload failed schema validation", {
          cause: parsed.error,
        }),
      );
    }

    this.jwksCache = parsed.data;
    this.jwksFetchedAt = Date.now();

    return ok(parsed.data);
  }

  /*
   * ---------------------------------------------------------------------------
   * Internal — token endpoint helpers
   * ---------------------------------------------------------------------------
   */

  /**
   * Iterates `clientSecrets` POSTing to `tokenEndpoint`. Returns the first
   * 2xx response parsed into a branded `FiefTokenResponse`. On 401 (the only
   * status meaning "wrong secret, try the next one") iterates; any other
   * non-2xx is terminal and returned as `FiefOidcTokenError`.
   */
  private async tryEachSecret(
    tokenEndpoint: string,
    clientSecrets: string[],
    buildBody: (secret: string) => URLSearchParams,
  ): Promise<Result<FiefTokenResponse, FiefOidcError>> {
    let lastError: InstanceType<typeof FiefOidcTokenError> | undefined;

    for (const secret of clientSecrets) {
      const response = await this.postForm(tokenEndpoint, buildBody(secret));

      if (response.isErr()) {
        lastError = new FiefOidcTokenError("Network error calling token endpoint", {
          cause: response.error,
        });
        continue;
      }

      if (response.value.ok) {
        return this.parseTokenResponse(response.value);
      }

      if (response.value.status === 401) {
        // `invalid_client` per RFC 6749 §5.2 — try the next secret.
        let upstreamError: unknown = undefined;

        try {
          upstreamError = await response.value.json();
        } catch {
          // Body wasn't JSON — ignore, the status is the signal.
        }

        lastError = new FiefOidcTokenError(
          "Token endpoint rejected client secret (401); will try next if available",
          { cause: upstreamError },
        );
        continue;
      }

      // Any non-401 non-2xx is terminal.
      let upstreamError: unknown = undefined;

      try {
        upstreamError = await response.value.json();
      } catch {
        /* ignore */
      }

      return err(
        new FiefOidcTokenError(`Token endpoint returned non-2xx: ${response.value.status}`, {
          cause: upstreamError,
        }),
      );
    }

    return err(lastError ?? new FiefOidcTokenError("Token request failed for an unknown reason"));
  }

  private async parseTokenResponse(
    response: Response,
  ): Promise<Result<FiefTokenResponse, FiefOidcError>> {
    let raw: unknown;

    try {
      raw = await response.json();
    } catch (cause) {
      return err(new FiefOidcTokenError("Token response was not valid JSON", { cause }));
    }

    const parsed = tokenResponseSchema.safeParse(raw);

    if (!parsed.success) {
      return err(
        new FiefOidcTokenError("Token response failed schema validation", {
          cause: parsed.error,
        }),
      );
    }

    /*
     * Branded constructors throw on empty strings — wrap defensively. Any
     * field that was optional in the upstream response stays optional here.
     */
    try {
      return ok({
        accessToken: createAccessToken(parsed.data.access_token),
        idToken:
          parsed.data.id_token !== undefined ? createIdToken(parsed.data.id_token) : undefined,
        refreshToken:
          parsed.data.refresh_token !== undefined
            ? createRefreshToken(parsed.data.refresh_token)
            : undefined,
        expiresIn: parsed.data.expires_in,
        tokenType: parsed.data.token_type,
        scope: parsed.data.scope,
      });
    } catch (cause) {
      return err(
        new FiefOidcTokenError("Token response branded-type construction failed", {
          cause,
        }),
      );
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * Internal — fetch primitives
   * ---------------------------------------------------------------------------
   */

  private async postForm(url: string, body: URLSearchParams): Promise<Result<Response, Error>> {
    return this.safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  }

  /**
   * Wraps `fetch` with an `AbortController`-driven timeout and converts the
   * thrown error into a `Result` so call sites stay branchless. The returned
   * `Response` is a normal Node fetch response; consumers must read its body
   * exactly once.
   */
  private async safeFetch(url: string, init: RequestInit): Promise<Result<Response, Error>> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });

      return ok(response);
    } catch (caught) {
      const error =
        caught instanceof Error
          ? caught
          : new Error(`Non-Error thrown by fetch: ${String(caught)}`);

      return err(error);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
