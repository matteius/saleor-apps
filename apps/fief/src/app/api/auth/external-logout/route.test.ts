/*
 * @vitest-environment node
 *
 * T21 — `POST /api/auth/external-logout` route tests (Path A).
 *
 * Path coordination:
 *   - The endpoint lives under `/api/auth/external-logout`, matching the
 *     plan and the sibling T18 endpoint at `/api/auth/external-authentication-url`.
 *   - T56's Python client currently has `PATH_LOGOUT = "/api/plugin/external-logout"`
 *     locked by a byte-lock fixture; T57 must update that to `/api/auth/...`
 *     when wiring the BasePlugin overrides — the HMAC sign string includes
 *     the URL pathname, so a Python-side path change is the final coupling
 *     step.
 *
 * Behavior under test:
 *   1. Valid HMAC + valid connection + refreshToken → revokeToken called,
 *      returns 200 `{ ok: true }`.
 *   2. Valid HMAC, no refreshToken → returns 200, NO revoke call (nothing
 *      to revoke; logout is still successful from the caller's POV).
 *   3. Bad HMAC → 401, NO revoke call.
 *   4. Disabled / missing connection → still 200 (best-effort logout —
 *      the user is logging out of Saleor regardless).
 *   5. Fief revoke throws / returns Err → still 200 (errors logged, NOT
 *      propagated; logout is fire-and-forget).
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

const { revokeTokenMock, FiefOidcClientMock } = vi.hoisted(() => {
  const revokeToken = vi.fn();
  const ctor = vi.fn().mockImplementation(() => ({ revokeToken }));

  return { revokeTokenMock: revokeToken, FiefOidcClientMock: ctor };
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

const { channelConfigurationRepoFactoryMock } = vi.hoisted(() => {
  return {
    channelConfigurationRepoFactoryMock: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    })),
  };
});

vi.mock("@/modules/fief-client/oidc-client", () => ({
  FiefOidcClient: FiefOidcClientMock,
}));

vi.mock("@/modules/channel-configuration/channel-resolver", () => ({
  ChannelResolver: ChannelResolverMock,
  createChannelResolverCache: createCacheMock,
}));

vi.mock("@/app/api/auth/external-logout/deps", () => ({
  buildProviderConnectionRepo: providerConnectionRepoFactoryMock,
  buildChannelConfigurationRepo: channelConfigurationRepoFactoryMock,
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
const ROUTE_URL = "https://app.test/api/auth/external-logout";

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

/*
 * A minimal `ProviderConnection`-shaped object — only the bits the route
 * actually reads (`id`, `fief.clientId`, `saleorApiUrl`).
 */
const buildConnection = (overrides: Partial<{ id: string; clientId: string }> = {}) => ({
  id: overrides.id ?? "conn-abc-1234",
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
  claimMapping: [],
  softDeletedAt: null,
});

const buildDecryptedSecrets = (
  overrides: Partial<{
    clientSecret: string;
    pendingClientSecret: string | null;
  }> = {},
) => ({
  fief: {
    clientSecret: overrides.clientSecret ?? "decrypted-secret-current",
    pendingClientSecret: overrides.pendingClientSecret ?? null,
    adminToken: "decrypted-admin-token",
    webhookSecret: "decrypted-webhook-secret",
    pendingWebhookSecret: null,
  },
  branding: {
    signingKey: "decrypted-signing-key",
  },
});

/*
 * ----------------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------------
 */

describe("external-logout route — T21", () => {
  beforeEach(() => {
    revokeTokenMock.mockReset();
    resolveMock.mockReset();
    getDecryptedSecretsMock.mockReset();
    FiefOidcClientMock.mockImplementation(() => ({ revokeToken: revokeTokenMock }));
    ChannelResolverMock.mockImplementation(() => ({ resolve: resolveMock }));
    createCacheMock.mockReturnValue({ get: vi.fn(), set: vi.fn() });
    providerConnectionRepoFactoryMock.mockImplementation(() => ({
      getDecryptedSecrets: getDecryptedSecretsMock,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revokes the refresh token and returns 200 when HMAC + connection + refreshToken are valid", async () => {
    const conn = buildConnection({ clientId: "client-rev-1" });

    resolveMock.mockResolvedValue(ok(conn));
    getDecryptedSecretsMock.mockResolvedValue(
      ok(
        buildDecryptedSecrets({
          clientSecret: "current-secret",
          pendingClientSecret: "pending-secret",
        }),
      ),
    );
    revokeTokenMock.mockResolvedValue(ok(undefined));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-xyz" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toStrictEqual({ ok: true });
    expect(revokeTokenMock).toHaveBeenCalledTimes(1);

    const call = revokeTokenMock.mock.calls[0]?.[0] as {
      token: string;
      tokenTypeHint?: string;
      clientId: string;
      clientSecrets: string[];
    };

    expect(call.token).toBe("rt-xyz");
    expect(call.tokenTypeHint).toBe("refresh_token");
    expect(call.clientId).toBe("client-rev-1");
    expect(call.clientSecrets).toStrictEqual(["current-secret", "pending-secret"]);
  });

  it("returns 200 without calling revoke when no refreshToken is supplied", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({}),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toStrictEqual({ ok: true });
    expect(revokeTokenMock).not.toHaveBeenCalled();
  });

  it("returns 401 and does not call revoke when the HMAC signature is invalid", async () => {
    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-bad" }),
        badSignature: true,
      }),
    );

    expect(res.status).toBe(401);
    expect(revokeTokenMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("returns 200 when the channel resolves to 'disabled' (best-effort logout)", async () => {
    resolveMock.mockResolvedValue(ok("disabled"));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-disabled" }),
        channel: "private",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toStrictEqual({ ok: true });
    expect(revokeTokenMock).not.toHaveBeenCalled();
  });

  it("returns 200 when no connection is configured for the channel (best-effort logout)", async () => {
    resolveMock.mockResolvedValue(ok(null));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-missing" }),
        channel: "no-config",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toStrictEqual({ ok: true });
    expect(revokeTokenMock).not.toHaveBeenCalled();
  });

  it("returns 200 when revokeToken returns Err (best-effort: log + swallow)", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));
    revokeTokenMock.mockResolvedValue(err(new Error("revocation_endpoint missing")));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-err" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toStrictEqual({ ok: true });
    expect(revokeTokenMock).toHaveBeenCalledTimes(1);
  });

  it("returns 200 when revokeToken throws synchronously (best-effort)", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(ok(buildDecryptedSecrets()));
    revokeTokenMock.mockRejectedValue(new Error("network exploded"));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-throw" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toStrictEqual({ ok: true });
  });

  it("returns 200 when getDecryptedSecrets returns Err (best-effort logout)", async () => {
    resolveMock.mockResolvedValue(ok(buildConnection()));
    getDecryptedSecretsMock.mockResolvedValue(err(new Error("decryption failed")));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-decrypt-fail" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    expect(revokeTokenMock).not.toHaveBeenCalled();
  });

  it("returns 200 when the channel resolver returns Err (best-effort logout)", async () => {
    resolveMock.mockResolvedValue(err(new Error("mongo down")));

    const { POST } = await import("./route");

    const res = await POST(
      buildSignedRequest({
        body: JSON.stringify({ refreshToken: "rt-resolver-fail" }),
        channel: "default",
      }),
    );

    expect(res.status).toBe(200);
    expect(revokeTokenMock).not.toHaveBeenCalled();
  });
});
