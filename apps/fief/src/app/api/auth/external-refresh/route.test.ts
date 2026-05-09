/*
 * @vitest-environment node
 *
 * T20 — `POST /api/auth/external-refresh` route tests (Path A).
 *
 * The route is the apps/fief side of the Saleor `BasePlugin`'s
 * `external_refresh(...)` call (T56/T57). Pipeline:
 *
 *   1. Verify HMAC via T58 (`verifyPluginRequest`) using the install-level
 *      shared secret (`FIEF_PLUGIN_HMAC_SECRET`).
 *   2. Resolve the channel-scope via T12's `ChannelResolver`.
 *   3. Decrypt connection client secrets, call Fief `refreshToken` (T6) with
 *      `[clientSecret, pendingClientSecret].filter(Boolean)`.
 *   4. If Fief returns updated claims AND they differ from cached Saleor
 *      metadata, refresh metadata via T7 (FiefUpdateMetadata +
 *      FiefUpdatePrivateMetadata) tagged origin "fief" + bumped seq (T13).
 *   5. Return updated user-claims payload via T55's
 *      `shapeUserClaimsForSaleorPlugin(...)`.
 *
 * Distinct failure contracts:
 *   - Bad HMAC -> 401 with `{ error: "Unauthorized" }` (the caller cannot
 *     recover without rotating the shared secret).
 *   - Fief refresh fail -> 401 with `{ error: "logout_required",
 *     logoutRequired: true }`. The Saleor plugin (T57) surfaces this to the
 *     storefront which forces a re-login.
 *   - Connection missing -> 404.
 *
 * Performance budget: p95 < 300ms (1 Mongo channel-resolver + 1 Mongo decrypt
 * + 1 Fief refresh round-trip + at most 1 Saleor GraphQL fetch + 0-2
 * Saleor GraphQL writes). Tests do not benchmark; the budget is documented
 * here so future maintainers don't accidentally add an extra Mongo read.
 */

import * as crypto from "node:crypto";

import { err, ok } from "neverthrow";
import { type NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ----------------------------------------------------------------------------
 * Hoisted mocks for the dependencies the route module imports at top level.
 * ----------------------------------------------------------------------------
 */

const { refreshTokenMock, FiefOidcClientMock } = vi.hoisted(() => {
  const refreshToken = vi.fn();
  const ctor = vi.fn().mockImplementation(() => ({ refreshToken }));

  return { refreshTokenMock: refreshToken, FiefOidcClientMock: ctor };
});

const { resolveMock, ChannelResolverMock, createCacheMock } = vi.hoisted(() => {
  const resolve = vi.fn();
  const ctor = vi.fn().mockImplementation(() => ({ resolve }));
  const createCache = vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn() });

  return { resolveMock: resolve, ChannelResolverMock: ctor, createCacheMock: createCache };
});

const { getDecryptedSecretsMock, providerConnectionRepoFactoryMock } = vi.hoisted(() => {
  const getDecryptedSecrets = vi.fn();
  const factory = vi.fn(() => ({
    getDecryptedSecrets,
  }));

  return {
    getDecryptedSecretsMock: getDecryptedSecrets,
    providerConnectionRepoFactoryMock: factory,
  };
});

const { channelConfigurationRepoFactoryMock } = vi.hoisted(() => ({
  channelConfigurationRepoFactoryMock: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

const { getByFiefUserMock, identityMapRepoFactoryMock } = vi.hoisted(() => {
  const getByFiefUser = vi.fn();
  const factory = vi.fn(() => ({ getByFiefUser }));

  return {
    getByFiefUserMock: getByFiefUser,
    identityMapRepoFactoryMock: factory,
  };
});

const { aplGetMock, getSaleorAppAPLMock } = vi.hoisted(() => {
  const aplGet = vi.fn();

  return {
    aplGetMock: aplGet,
    getSaleorAppAPLMock: vi.fn(() => ({ get: aplGet })),
  };
});

const { fetchSaleorUserMock, writeSaleorMetadataMock, extractClaimsMock, saleorClientFactoryMock } =
  vi.hoisted(() => {
    const fetchSaleorUser = vi.fn();
    const writeSaleorMetadata = vi.fn();
    const extractClaims = vi.fn();
    const factory = vi.fn(() => ({
      fetchSaleorUser,
      writeSaleorMetadata,
      extractClaims,
    }));

    return {
      fetchSaleorUserMock: fetchSaleorUser,
      writeSaleorMetadataMock: writeSaleorMetadata,
      extractClaimsMock: extractClaims,
      saleorClientFactoryMock: factory,
    };
  });

/*
 * Default the extractClaims mock to FRESH_CLAIMS_DIVERGED. Individual tests
 * override per-case.
 */

vi.mock("@/modules/fief-client/oidc-client", () => ({
  FiefOidcClient: FiefOidcClientMock,
}));

vi.mock("@/modules/channel-configuration/channel-resolver", () => ({
  ChannelResolver: ChannelResolverMock,
  createChannelResolverCache: createCacheMock,
}));

vi.mock("@/app/api/auth/external-refresh/deps", () => ({
  buildProviderConnectionRepo: providerConnectionRepoFactoryMock,
  buildChannelConfigurationRepo: channelConfigurationRepoFactoryMock,
  buildIdentityMapRepo: identityMapRepoFactoryMock,
  getSaleorAppAPL: getSaleorAppAPLMock,
  buildSaleorMetadataClient: saleorClientFactoryMock,
}));

vi.mock("@/lib/env", () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_PLUGIN_HMAC_SECRET: "test-plugin-hmac-secret",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
  },
}));

/*
 * ----------------------------------------------------------------------------
 * Test helpers — sign a request with the same HMAC the Saleor side emits.
 * ----------------------------------------------------------------------------
 */

const SECRET = "test-plugin-hmac-secret";
const SALEOR_API_URL = "https://shop.example.com/graphql/";
const ROUTE_URL = "https://app.test/api/auth/external-refresh";

const sha256Hex = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

const hmacHex = (secret: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

interface SignedRequestParts {
  body: string;
  channel?: string;
  saleorApiUrl?: string;
  badSignature?: boolean;
}

const buildSignedRequest = (parts: SignedRequestParts): NextRequest => {
  const bodyBytes = Buffer.from(parts.body, "utf-8");
  const ts = Math.floor(Date.now() / 1000);
  const pathname = new URL(ROUTE_URL).pathname;
  const message = `POST\n${pathname}\n${ts}\n${sha256Hex(bodyBytes)}`;
  const signature = parts.badSignature ? "0".repeat(64) : hmacHex(SECRET, message);

  const headers = new Headers();

  headers.set("X-Fief-Plugin-Timestamp", String(ts));
  headers.set("X-Fief-Plugin-Signature", signature);
  headers.set("X-Fief-Plugin-Saleor-Url", parts.saleorApiUrl ?? SALEOR_API_URL);
  headers.set("Content-Type", "application/json");
  if (parts.channel !== undefined) {
    headers.set("X-Fief-Plugin-Channel", parts.channel);
  }

  const req = new Request(ROUTE_URL, {
    method: "POST",
    headers,
    body: bodyBytes,
  }) as unknown as NextRequest;

  Object.defineProperty(req, "nextUrl", {
    value: new URL(ROUTE_URL),
  });

  return req;
};

const buildConnection = (
  overrides: Partial<{ id: string; clientId: string; claimMapping: unknown[] }> = {},
) => ({
  id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
  saleorApiUrl: SALEOR_API_URL,
  name: "test-conn",
  fief: {
    baseUrl: "https://fief.example.com",
    tenantId: "tenant-1",
    clientId: overrides.clientId ?? "client-1",
    webhookId: null,
    encryptedClientSecret: "ignored:ignored",
    encryptedPendingClientSecret: null,
    encryptedAdminToken: "ignored:ignored",
    encryptedWebhookSecret: "ignored:ignored",
    encryptedPendingWebhookSecret: null,
  },
  branding: {
    encryptedSigningKey: "ignored:ignored",
    allowedOrigins: [],
  },
  claimMapping: overrides.claimMapping ?? [
    {
      fiefClaim: "tier",
      saleorMetadataKey: "loyalty_tier",
      visibility: "public",
      required: false,
      reverseSyncEnabled: false,
    },
    {
      fiefClaim: "internal_score",
      saleorMetadataKey: "loyalty_score",
      visibility: "private",
      required: false,
      reverseSyncEnabled: false,
    },
  ],
  softDeletedAt: null,
});

const buildDecryptedSecrets = (
  overrides: Partial<{
    clientSecret: string;
    pendingClientSecret: string | null;
  }> = {},
) => ({
  fief: {
    clientSecret: overrides.clientSecret ?? "decrypted-current",
    pendingClientSecret: overrides.pendingClientSecret ?? null,
    adminToken: "decrypted-admin-token",
    webhookSecret: "decrypted-webhook-secret",
    pendingWebhookSecret: null,
  },
  branding: {
    signingKey: "decrypted-signing-key",
  },
});

const buildSaleorCustomer = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "VXNlcjox",
  email: "user@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  isActive: true,
  metadata: { loyalty_tier: "silver", fief_sync_origin: "fief" } as Record<string, string>,
  privateMetadata: { loyalty_score: "10", fief_sync_seq: "5" } as Record<string, string>,
  ...overrides,
});

/**
 * A Fief refresh token-response. The shape mirrors `FiefTokenResponse` from
 * `oidc-types.ts`: tokens are branded but here we cast to keep test setup
 * lightweight (the route only reads `accessToken` / `refreshToken` /
 * `idToken`-derived claims via the injected `fetchClaimsFromTokenResponse`
 * seam — see route.ts).
 */
const buildTokenResponse = (
  overrides: Partial<{
    accessToken: string;
    refreshToken: string | undefined;
    idToken: string;
  }> = {},
) => ({
  accessToken: overrides.accessToken ?? "new-access-token",
  refreshToken: overrides.refreshToken ?? "new-refresh-token",
  idToken: overrides.idToken ?? "new-id-token",
  expiresIn: 3600,
  tokenType: "Bearer",
  scope: "openid email profile",
});

/**
 * Identity map row. The route uses it to find the Saleor user id given the
 * Fief subject claim from the refreshed id_token.
 */
const FIEF_USER_UUID = "22222222-2222-4222-8222-222222222222";

const buildIdentityMapRow = () => ({
  saleorApiUrl: SALEOR_API_URL,
  saleorUserId: "VXNlcjox" as unknown as string,
  fiefUserId: FIEF_USER_UUID as unknown as string,
  lastSyncSeq: 5,
  lastSyncedAt: new Date("2026-05-08T00:00:00Z"),
});

/**
 * The "fresh" Fief claims surfaced by the route's claim-extraction step.
 * In production these come from the `id_token` payload (verified via T6's
 * `verifyIdToken`); the test mocks `buildSaleorMetadataClient` so the route
 * receives them via the seam.
 */
const FRESH_CLAIMS_DIVERGED = {
  sub: FIEF_USER_UUID,
  email: "user@example.com",
  tier: "gold",
  internal_score: 42,
};

const FRESH_CLAIMS_UNCHANGED = {
  sub: FIEF_USER_UUID,
  email: "user@example.com",
  tier: "silver",
  internal_score: 10,
};

/*
 * ----------------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------------
 */

describe("external-refresh route — T20", () => {
  beforeEach(() => {
    refreshTokenMock.mockReset();
    resolveMock.mockReset();
    getDecryptedSecretsMock.mockReset();
    fetchSaleorUserMock.mockReset();
    writeSaleorMetadataMock.mockReset();
    extractClaimsMock.mockReset();
    getByFiefUserMock.mockReset();
    aplGetMock.mockReset();

    FiefOidcClientMock.mockImplementation(() => ({ refreshToken: refreshTokenMock }));
    ChannelResolverMock.mockImplementation(() => ({ resolve: resolveMock }));
    createCacheMock.mockReturnValue({ get: vi.fn(), set: vi.fn() });
    providerConnectionRepoFactoryMock.mockImplementation(() => ({
      getDecryptedSecrets: getDecryptedSecretsMock,
    }));
    identityMapRepoFactoryMock.mockImplementation(() => ({
      getByFiefUser: getByFiefUserMock,
    }));
    getSaleorAppAPLMock.mockImplementation(() => ({ get: aplGetMock }));
    saleorClientFactoryMock.mockImplementation(() => ({
      fetchSaleorUser: fetchSaleorUserMock,
      writeSaleorMetadata: writeSaleorMetadataMock,
      extractClaims: extractClaimsMock,
    }));

    aplGetMock.mockResolvedValue({ token: "saleor-app-token", saleorApiUrl: SALEOR_API_URL });
    getByFiefUserMock.mockResolvedValue(ok(buildIdentityMapRow()));
    fetchSaleorUserMock.mockResolvedValue(ok(buildSaleorCustomer()));
    writeSaleorMetadataMock.mockResolvedValue(ok(undefined));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------ HAPPY PATH
  it("happy path: returns shaped claims payload and the new Fief tokens", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(
      ok(
        buildDecryptedSecrets({
          clientSecret: "current-secret",
          pendingClientSecret: "pending-secret",
        }),
      ),
    );
    refreshTokenMock.mockResolvedValue(ok(buildTokenResponse()));
    extractClaimsMock.mockResolvedValue(ok(FRESH_CLAIMS_DIVERGED));

    // The metadata-client seam returns the FRESH claims for the shaper.
    fetchSaleorUserMock.mockResolvedValue(ok(buildSaleorCustomer()));
    writeSaleorMetadataMock.mockResolvedValue(ok(undefined));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-old" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({
      logoutRequired: false,
      fiefAccessToken: "new-access-token",
      fiefRefreshToken: "new-refresh-token",
    });

    // Claims payload conforms to T55's wire contract.
    const claims = json["claims"] as Record<string, unknown>;

    expect(Object.keys(claims).sort()).toStrictEqual([
      "email",
      "firstName",
      "id",
      "isActive",
      "lastName",
      "metadata",
      "privateMetadata",
    ]);
    expect(claims["id"]).toBe("VXNlcjox");
    expect(claims["email"]).toBe("user@example.com");
    expect(claims["isActive"]).toBe(true);

    // Refresh was called with the dual-secret iterator.
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    const refreshArg = refreshTokenMock.mock.calls[0]?.[0] as {
      refreshToken: string;
      clientId: string;
      clientSecrets: string[];
    };

    expect(refreshArg.refreshToken).toBe("rt-old");
    expect(refreshArg.clientId).toBe("client-1");
    expect(refreshArg.clientSecrets).toStrictEqual(["current-secret", "pending-secret"]);
  });

  // ------------------------------------------------------------------ DIVERGED CLAIMS
  it("when claims diverge from cached metadata, refreshes Saleor metadata tagged origin=fief + bumped seq", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));
    refreshTokenMock.mockResolvedValue(ok(buildTokenResponse()));
    extractClaimsMock.mockResolvedValue(ok(FRESH_CLAIMS_DIVERGED));
    fetchSaleorUserMock.mockResolvedValue(ok(buildSaleorCustomer()));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-1" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);

    expect(writeSaleorMetadataMock).toHaveBeenCalledTimes(1);

    const writeArg = writeSaleorMetadataMock.mock.calls[0]?.[0] as {
      saleorUserId: string;
      metadata: Record<string, string>;
      privateMetadata: Record<string, string>;
    };

    expect(writeArg.saleorUserId).toBe("VXNlcjox");
    // Origin marker tagged "fief" in public metadata.
    expect(writeArg.metadata["fief_sync_origin"]).toBe("fief");
    // Bumped seq lives in private metadata; must be > previous lastSyncSeq=5.
    const newSeq = Number(writeArg.privateMetadata["fief_sync_seq"]);

    expect(Number.isInteger(newSeq)).toBe(true);
    expect(newSeq).toBeGreaterThan(5);
    // The diverged projection is present.
    expect(writeArg.metadata["loyalty_tier"]).toBe("gold");
    expect(writeArg.privateMetadata["loyalty_score"]).toBe("42");
  });

  // ------------------------------------------------------------------ UNCHANGED CLAIMS
  it("when claims match cached metadata, does NOT write Saleor metadata", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));
    refreshTokenMock.mockResolvedValue(ok(buildTokenResponse()));
    extractClaimsMock.mockResolvedValue(ok(FRESH_CLAIMS_UNCHANGED));
    fetchSaleorUserMock.mockResolvedValue(ok(buildSaleorCustomer()));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-2" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    expect(writeSaleorMetadataMock).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ FIEF REFRESH FAILED
  it("returns 401 with logout_required when Fief refresh fails (Err)", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));
    refreshTokenMock.mockResolvedValue(err(new Error("invalid_grant")));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-expired" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(401);

    const json = (await res.json()) as Record<string, unknown>;

    expect(json["error"]).toBe("logout_required");
    expect(json["logoutRequired"]).toBe(true);
    // No claims payload on a logout-required response.
    expect(json["claims"]).toBeUndefined();
    // Saleor metadata MUST NOT be written when Fief refresh failed.
    expect(writeSaleorMetadataMock).not.toHaveBeenCalled();
  });

  it("returns 401 with logout_required when Fief refresh throws synchronously", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));
    refreshTokenMock.mockRejectedValue(new Error("network down"));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-net" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json["error"]).toBe("logout_required");
    expect(json["logoutRequired"]).toBe(true);
  });

  // ------------------------------------------------------------------ BAD HMAC
  it("returns 401 with Unauthorized (NOT logout_required) on bad HMAC", async () => {
    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-bad-sig" }),
        channel: "default",
        badSignature: true,
      }),
    );

    expect(res.status).toBe(401);

    const json = (await res.json()) as Record<string, unknown>;

    /*
     * Distinct from the logout-required contract: the caller cannot recover
     * by clearing the user session — the operator must rotate the shared
     * secret. Surface that as the standard `Unauthorized` error.
     */
    expect(json["error"]).toBe("Unauthorized");
    expect(json["logoutRequired"]).toBeUndefined();

    // Pipeline must short-circuit at HMAC; nothing downstream should run.
    expect(refreshTokenMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(writeSaleorMetadataMock).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ CONNECTION MISSING
  it("returns 404 when no connection is bound to the channel", async () => {
    resolveMock.mockResolvedValue(ok(null));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-no-conn" }),
        channel: "no-config",
      }),
    );

    expect(res.status).toBe(404);

    const json = (await res.json()) as Record<string, unknown>;

    expect(json["error"]).toBe("Not Found");
    /*
     * Distinct from logout-required: a 404 means the install configuration
     * is wrong (operator must wire a connection); we do NOT instruct the
     * storefront to log the user out.
     */
    expect(json["logoutRequired"]).toBeUndefined();
    expect(refreshTokenMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the connection is DISABLED for this channel", async () => {
    resolveMock.mockResolvedValue(ok("disabled"));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-disabled" }),
        channel: "private",
      }),
    );

    /*
     * Operator opted this channel out of Fief auth. From the storefront's
     * perspective the connection is "missing" — same 404 contract. A future
     * refinement could distinguish 403 here; v1 collapses both into "no
     * Fief auth available for this channel".
     */
    expect(res.status).toBe(404);
    expect(refreshTokenMock).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ BODY VALIDATION
  it("returns 400 when the body is missing the refreshToken field", async () => {
    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({}),
        channel: "default",
      }),
    );

    expect(res.status).toBe(400);
    expect(refreshTokenMock).not.toHaveBeenCalled();
  });
});
