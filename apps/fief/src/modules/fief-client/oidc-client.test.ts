/**
 * @vitest-environment node
 *
 * The OIDC client uses Node `fetch` + `AbortController` (timeout) + `jose`'s
 * WebCrypto-backed `SignJWT` / `jwtVerify`. jsdom's `fetch` polyfill rejects
 * `signal: AbortController.signal` and its WebCrypto subset is incomplete for
 * RSA-OAEP key import — both are fully supported in Node 20+'s native runtime.
 * Force this test file onto the `node` env so we exercise the real production
 * code paths.
 */

import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FiefOidcClient } from "./oidc-client";
import {
  FiefOidcDiscoveryError,
  FiefOidcJwksError,
  FiefOidcRevokeError,
  FiefOidcTokenError,
  FiefOidcVerifyError,
} from "./oidc-errors";

/*
 * Test plan (mapped to T6's validation requirements):
 *
 *   - Discovery cache: second call after pre-warm doesn't hit network (and
 *     mid-call discovery outage doesn't break the auth plane).
 *   - JWKS rollover: client picks correct `kid` after upstream rotates keys.
 *   - Dual-secret: tries current → on 401 falls back to pending → succeeds.
 *   - Happy paths: exchangeCode, refreshToken, revokeToken.
 *   - verifyIdToken: valid token passes, tampered token fails closed.
 *
 * MSW backs every Fief endpoint. We track call counts so the cache assertions
 * are observable rather than implicit.
 */

const FIEF_BASE = "https://tenant.example.com";

/*
 * -----------------------------------------------------------------------------
 * Test harness — JWKS keypairs + counters + handlers
 * -----------------------------------------------------------------------------
 */

interface KeyPairWithKid {
  kid: string;
  privateKey: KeyLike | Uint8Array;
  publicJwk: Record<string, unknown>;
}

const generateRsaKey = async (kid: string): Promise<KeyPairWithKid> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);

  return {
    kid,
    privateKey,
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
};

const issueIdToken = async (
  key: KeyPairWithKid,
  options: { issuer: string; audience: string; subject?: string; expiresInSeconds?: number },
): Promise<string> => {
  return new SignJWT({ email: "alice@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.subject ?? "user-1")
    .setIssuedAt()
    .setExpirationTime(`${options.expiresInSeconds ?? 300}s`)
    .sign(key.privateKey);
};

interface CallCounters {
  discovery: number;
  jwks: number;
  token: number;
  revoke: number;
}

const counters: CallCounters = { discovery: 0, jwks: 0, token: 0, revoke: 0 };

let activeKeys: KeyPairWithKid[] = [];

/**
 * State holders for token endpoint so individual tests can wire up dual-secret
 * scenarios without rebuilding the server.
 */
let tokenHandler:
  | ((req: { secret: string | null; clientId: string | null; body: URLSearchParams }) => Response)
  | null = null;

const handlers = [
  http.get(`${FIEF_BASE}/.well-known/openid-configuration`, () => {
    counters.discovery += 1;

    return HttpResponse.json({
      issuer: FIEF_BASE,
      authorization_endpoint: `${FIEF_BASE}/authorize`,
      token_endpoint: `${FIEF_BASE}/api/token`,
      userinfo_endpoint: `${FIEF_BASE}/api/userinfo`,
      jwks_uri: `${FIEF_BASE}/.well-known/jwks.json`,
      revocation_endpoint: `${FIEF_BASE}/api/revoke`,
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    });
  }),
  http.get(`${FIEF_BASE}/.well-known/jwks.json`, () => {
    counters.jwks += 1;

    return HttpResponse.json({
      keys: activeKeys.map((k) => k.publicJwk),
    });
  }),
  http.post(`${FIEF_BASE}/api/token`, async ({ request }) => {
    counters.token += 1;
    const text = await request.text();
    const body = new URLSearchParams(text);

    if (tokenHandler) {
      return tokenHandler({
        secret: body.get("client_secret"),
        clientId: body.get("client_id"),
        body,
      });
    }

    return HttpResponse.json(
      {
        access_token: "access-default",
        id_token: "id-default",
        refresh_token: "refresh-default",
        expires_in: 3600,
        token_type: "bearer",
        scope: "openid offline_access",
      },
      { status: 200 },
    );
  }),
  http.post(`${FIEF_BASE}/api/revoke`, async () => {
    counters.revoke += 1;

    return new HttpResponse(null, { status: 200 });
  }),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(async () => {
  counters.discovery = 0;
  counters.jwks = 0;
  counters.token = 0;
  counters.revoke = 0;
  tokenHandler = null;
  activeKeys = [await generateRsaKey("key-1")];
});

afterEach(() => server.resetHandlers(...handlers));

/*
 * -----------------------------------------------------------------------------
 * Tests
 * -----------------------------------------------------------------------------
 */

describe("FiefOidcClient — discovery cache", () => {
  it("pre-warm fetches discovery + JWKS exactly once", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.prewarm();

    expect(result.isOk()).toBe(true);
    expect(counters.discovery).toBe(1);
    expect(counters.jwks).toBe(1);
  });

  it("subsequent operations within TTL hit cache (no extra discovery fetch)", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    await client.prewarm();
    expect(counters.discovery).toBe(1);

    // Many auth-plane-style operations:
    for (let i = 0; i < 10; i += 1) {
      const r = await client.exchangeCode({
        code: "auth-code",
        redirectUri: "https://app.example.com/cb",
        clientId: "saleor-client",
        clientSecrets: ["secret-current"],
      });

      expect(r.isOk()).toBe(true);
    }

    expect(counters.discovery).toBe(1); // still one — cache hit ratio = 100%
  });
});

describe("FiefOidcClient — JWKS rollover (stale-while-revalidate)", () => {
  it("forces JWKS refresh when verifying a token signed by a kid not in cache", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    await client.prewarm();
    expect(counters.jwks).toBe(1);

    // Upstream rotates: now serves both old + new key
    const newKey = await generateRsaKey("key-2");

    activeKeys = [activeKeys[0]!, newKey];

    const token = await issueIdToken(newKey, {
      issuer: FIEF_BASE,
      audience: "saleor-client",
    });

    const verifyResult = await client.verifyIdToken(token, {
      audience: "saleor-client",
      issuer: FIEF_BASE,
    });

    expect(verifyResult.isOk()).toBe(true);
    expect(counters.jwks).toBeGreaterThanOrEqual(2);
  });

  it("verifies a token signed by a kid that was already in cache without re-fetch", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    await client.prewarm();
    const fetchesAfterWarm = counters.jwks;

    const token = await issueIdToken(activeKeys[0]!, {
      issuer: FIEF_BASE,
      audience: "saleor-client",
    });

    const verifyResult = await client.verifyIdToken(token, {
      audience: "saleor-client",
      issuer: FIEF_BASE,
    });

    expect(verifyResult.isOk()).toBe(true);
    expect(counters.jwks).toBe(fetchesAfterWarm); // no extra fetch
  });
});

describe("FiefOidcClient — dual-secret rotation window", () => {
  it("falls back to pending secret when current is rejected with 401", async () => {
    tokenHandler = ({ secret }) => {
      if (secret === "old-current") {
        return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
      }

      if (secret === "new-pending") {
        return HttpResponse.json({
          access_token: "access-via-pending",
          id_token: "id-via-pending",
          refresh_token: "refresh-via-pending",
          expires_in: 3600,
          token_type: "bearer",
          scope: "openid offline_access",
        });
      }

      return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
    };

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.exchangeCode({
      code: "auth-code",
      redirectUri: "https://app.example.com/cb",
      clientId: "saleor-client",
      clientSecrets: ["old-current", "new-pending"],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().accessToken).toBe("access-via-pending");
    expect(counters.token).toBe(2); // current then pending
  });

  it("succeeds on first secret without trying the second", async () => {
    let secondAttempted = false;

    tokenHandler = ({ secret }) => {
      if (secret === "current-good") {
        return HttpResponse.json({
          access_token: "access-via-current",
          expires_in: 3600,
        });
      }

      secondAttempted = true;

      return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
    };

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.exchangeCode({
      code: "auth-code",
      redirectUri: "https://app.example.com/cb",
      clientId: "saleor-client",
      clientSecrets: ["current-good", "pending-extra"],
    });

    expect(result.isOk()).toBe(true);
    expect(secondAttempted).toBe(false);
    expect(counters.token).toBe(1);
  });

  it("returns FiefOidcTokenError when all secrets are rejected", async () => {
    tokenHandler = () => HttpResponse.json({ error: "invalid_client" }, { status: 401 });

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.exchangeCode({
      code: "auth-code",
      redirectUri: "https://app.example.com/cb",
      clientId: "saleor-client",
      clientSecrets: ["bad-1", "bad-2"],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcTokenError);
    expect(counters.token).toBe(2);
  });

  it("rejects empty secrets array up front", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.exchangeCode({
      code: "auth-code",
      redirectUri: "https://app.example.com/cb",
      clientId: "saleor-client",
      clientSecrets: [],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcTokenError);
    expect(counters.token).toBe(0);
  });
});

describe("FiefOidcClient — exchangeCode happy path", () => {
  it("posts the right form-encoded body and parses the token response", async () => {
    let capturedBody: URLSearchParams | null = null;

    tokenHandler = ({ body }) => {
      capturedBody = body;

      return HttpResponse.json({
        access_token: "access-1",
        id_token: "id-1",
        refresh_token: "refresh-1",
        expires_in: 1800,
        token_type: "bearer",
        scope: "openid offline_access",
      });
    };

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.exchangeCode({
      code: "auth-code-xyz",
      redirectUri: "https://app.example.com/cb",
      clientId: "saleor-client",
      clientSecrets: ["secret-current"],
    });

    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();

    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.idToken).toBe("id-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(tokens.expiresIn).toBe(1800);

    expect(capturedBody).not.toBeNull();
    const sentBody = capturedBody as URLSearchParams | null;

    expect(sentBody?.get("grant_type")).toBe("authorization_code");
    expect(sentBody?.get("code")).toBe("auth-code-xyz");
    expect(sentBody?.get("redirect_uri")).toBe("https://app.example.com/cb");
    expect(sentBody?.get("client_id")).toBe("saleor-client");
    expect(sentBody?.get("client_secret")).toBe("secret-current");
  });
});

describe("FiefOidcClient — refreshToken happy path", () => {
  it("sends grant_type=refresh_token and returns refreshed tokens", async () => {
    let capturedBody: URLSearchParams | null = null;

    tokenHandler = ({ body }) => {
      capturedBody = body;

      return HttpResponse.json({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
      });
    };

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.refreshToken({
      refreshToken: "rt-old",
      clientId: "saleor-client",
      clientSecrets: ["secret-current"],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().accessToken).toBe("refreshed-access");
    expect(result._unsafeUnwrap().refreshToken).toBe("refreshed-refresh");

    const sentBody = capturedBody as URLSearchParams | null;

    expect(sentBody?.get("grant_type")).toBe("refresh_token");
    expect(sentBody?.get("refresh_token")).toBe("rt-old");
  });
});

describe("FiefOidcClient — revokeToken happy path", () => {
  it("hits revocation_endpoint and returns ok on 200", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.revokeToken({
      token: "rt-to-revoke",
      clientId: "saleor-client",
      clientSecrets: ["secret-current"],
    });

    expect(result.isOk()).toBe(true);
    expect(counters.revoke).toBe(1);
  });

  it("returns FiefOidcRevokeError when discovery doc has no revocation_endpoint", async () => {
    server.use(
      http.get(`${FIEF_BASE}/.well-known/openid-configuration`, () => {
        counters.discovery += 1;

        return HttpResponse.json({
          issuer: FIEF_BASE,
          authorization_endpoint: `${FIEF_BASE}/authorize`,
          token_endpoint: `${FIEF_BASE}/api/token`,
          jwks_uri: `${FIEF_BASE}/.well-known/jwks.json`,
        });
      }),
    );

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.revokeToken({
      token: "rt-to-revoke",
      clientId: "saleor-client",
      clientSecrets: ["secret-current"],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcRevokeError);
  });
});

describe("FiefOidcClient — verifyIdToken", () => {
  it("verifies a well-formed token signed by a known JWKS key", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    await client.prewarm();

    const token = await issueIdToken(activeKeys[0]!, {
      issuer: FIEF_BASE,
      audience: "saleor-client",
    });

    const result = await client.verifyIdToken(token, {
      audience: "saleor-client",
      issuer: FIEF_BASE,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().payload).toMatchObject({
      iss: FIEF_BASE,
      aud: "saleor-client",
      sub: "user-1",
    });
  });

  it("rejects a tampered token (signature does not verify)", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    await client.prewarm();

    const token = await issueIdToken(activeKeys[0]!, {
      issuer: FIEF_BASE,
      audience: "saleor-client",
    });

    // Flip a single character in the payload section.
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]?.slice(0, -1)}A.${parts[2]}`;

    const result = await client.verifyIdToken(tampered, {
      audience: "saleor-client",
      issuer: FIEF_BASE,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcVerifyError);
  });

  it("rejects a token whose audience does not match", async () => {
    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    await client.prewarm();

    const token = await issueIdToken(activeKeys[0]!, {
      issuer: FIEF_BASE,
      audience: "different-client",
    });

    const result = await client.verifyIdToken(token, {
      audience: "saleor-client",
      issuer: FIEF_BASE,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcVerifyError);
  });
});

describe("FiefOidcClient — discovery failure modes", () => {
  it("returns FiefOidcDiscoveryError when discovery endpoint is down on cold start", async () => {
    server.use(
      http.get(`${FIEF_BASE}/.well-known/openid-configuration`, () => {
        return new HttpResponse("upstream down", { status: 503 });
      }),
    );

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.prewarm();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcDiscoveryError);
  });

  it("returns FiefOidcJwksError on cold start when JWKS endpoint is down", async () => {
    server.use(
      http.get(`${FIEF_BASE}/.well-known/jwks.json`, () => {
        return new HttpResponse("jwks down", { status: 503 });
      }),
    );

    const client = new FiefOidcClient({ baseUrl: FIEF_BASE });

    const result = await client.prewarm();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefOidcJwksError);
  });
});
