/**
 * @vitest-environment node
 *
 * T40 — Integration test for `POST /api/auth/external-obtain-access-tokens`.
 *
 * Boots Mongo + msw + composition root. The Fief OIDC client is partially
 * mocked at the module boundary because the production T19 route reads
 * `claims` directly from the exchange response — Fief itself does NOT
 * return `claims` in `/api/token` (id_token decoding lives one layer up
 * in production wiring that's a follow-up). Mocking the module means the
 * integration test exercises everything else end-to-end (HMAC verify →
 * Mongo channel resolver → decryption → identity-map upsert → metadata
 * project + write → claims-shaper).
 *
 * Tests required by T40:
 *   - Cold first-login creates customer + identity_map row.
 *   - Warm returning user reuses bound saleorUserId.
 *   - Latency benchmark: p95 < 600 ms over 1000 sequential requests.
 */

import { ok, type Result } from "neverthrow";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALLOWED_ORIGIN,
  buildSignedRequest,
  CHANNEL_SLUG,
  FIEF_USER_ID,
  type IntegrationHarness,
  measureLatency,
  percentile,
  REDIRECT_URI,
  SALEOR_API_URL,
  seedConnection,
  SIGNING_KEY,
  startHarness,
  stopHarness,
} from "./harness";

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type OidcModule = typeof import("@/modules/fief-client/oidc-client");

vi.mock("@/modules/fief-client/oidc-client", async (importOriginal) => {
  const original = await importOriginal<OidcModule>();

  class MockFiefOidcClient {
    public readonly baseUrl: string;
    public exchangeCount = 0;
    public lastInput: unknown;

    constructor(input: { baseUrl: string }) {
      this.baseUrl = input.baseUrl;
    }

    async exchangeCode(input: {
      code: string;
      redirectUri: string;
      clientId: string;
      clientSecrets: string[];
    }): Promise<Result<unknown, Error>> {
      this.exchangeCount += 1;
      this.lastInput = input;

      return ok({
        accessToken: "fief-access-token-1",
        idToken: "fief-id-token-1",
        refreshToken: "fief-refresh-token-1",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: "openid email profile",
        claims: oidcMockState.nextClaims,
      });
    }

    async refreshToken(): Promise<Result<unknown, Error>> {
      return ok({});
    }

    async revokeToken(): Promise<Result<undefined, Error>> {
      return ok(undefined);
    }
  }

  return { ...original, FiefOidcClient: MockFiefOidcClient };
});

vi.mock("@/app/api/auth/external-obtain-access-tokens/build-deps", async () => {
  const { getProductionDeps } = await import("@/lib/composition-root");

  return {
    buildDeps: () => {
      const real = getProductionDeps();

      return {
        channelResolver: real.buildChannelResolver(),
        connectionRepo: real.connectionRepo,
        identityMapRepo: real.identityMapRepo,
        saleorClient: saleorClientFake,
      };
    },
  };
});

const oidcMockState = {
  nextClaims: {} as Record<string, unknown>,
};

interface SaleorCallTrace {
  customerCreateCount: number;
  metadataUpdateCount: number;
  privateMetadataUpdateCount: number;
  lastCreateInput: unknown;
}

const saleorTrace: SaleorCallTrace = {
  customerCreateCount: 0,
  metadataUpdateCount: 0,
  privateMetadataUpdateCount: 0,
  lastCreateInput: undefined,
};

const saleorClientFake = {
  customerCreate: async (input: {
    saleorApiUrl: unknown;
    email: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
  }) => {
    saleorTrace.customerCreateCount += 1;
    saleorTrace.lastCreateInput = input;

    const { ok: okFn } = await import("neverthrow");
    const { createSaleorUserId } = await import("@/modules/identity-map/identity-map");

    return okFn({
      saleorUserId: createSaleorUserId("VXNlcjox")._unsafeUnwrap(),
      email: input.email,
    });
  },
  updateMetadata: async () => {
    saleorTrace.metadataUpdateCount += 1;
    const { ok: okFn } = await import("neverthrow");

    return okFn(undefined);
  },
  updatePrivateMetadata: async () => {
    saleorTrace.privateMetadataUpdateCount += 1;
    const { ok: okFn } = await import("neverthrow");

    return okFn(undefined);
  },
};

const ROUTE_PATHNAME = "/api/auth/external-obtain-access-tokens";

let harness: IntegrationHarness;

const buildBrandingOriginToken = async (): Promise<string> => {
  const { sign } = await import("@/modules/branding/origin-signer");

  return sign(ALLOWED_ORIGIN, SIGNING_KEY);
};

const callRoute = async (req: Request): Promise<Response> => {
  const { POST } = await import("@/app/api/auth/external-obtain-access-tokens/route");

  return POST(req as never);
};

const resetSaleorTrace = () => {
  saleorTrace.customerCreateCount = 0;
  saleorTrace.metadataUpdateCount = 0;
  saleorTrace.privateMetadataUpdateCount = 0;
  saleorTrace.lastCreateInput = undefined;
};

beforeAll(async () => {
  harness = await startHarness();
  await seedConnection();
}, 120_000);

afterAll(async () => {
  await stopHarness();
});

beforeEach(async () => {
  harness.fiefMock.reset();
  resetSaleorTrace();

  oidcMockState.nextClaims = {
    sub: FIEF_USER_ID,
    email: "alice@example.com",
    first_name: "Alice",
    last_name: "Example",
    is_active: true,
  };

  await harness.db.collection("identity_map").deleteMany({});
});

describe("T40 — external-obtain-access-tokens end-to-end", () => {
  it("cold first-login: creates Saleor customer + identity-map row + returns shaped claims", async () => {
    const brandingOrigin = await buildBrandingOriginToken();
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "fief-auth-code-cold",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      },
    });

    const res = await callRoute(req);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.id).toBeTruthy();
    expect(body.email).toBe("alice@example.com");

    expect(saleorTrace.customerCreateCount).toBe(1);

    const identityRow = await harness.db.collection("identity_map").findOne({
      fiefUserId: FIEF_USER_ID,
    });

    expect(identityRow).toBeTruthy();
    expect(identityRow?.saleorUserId).toBeTruthy();
  });

  it("warm returning user: re-uses bound saleorUserId without re-creating Saleor customer", async () => {
    const brandingOrigin = await buildBrandingOriginToken();
    const body = {
      saleorApiUrl: SALEOR_API_URL as unknown as string,
      channelSlug: CHANNEL_SLUG as unknown as string,
      input: {
        code: "fief-auth-code-warm",
        redirectUri: REDIRECT_URI,
        origin: ALLOWED_ORIGIN,
        brandingOrigin,
      },
    };

    const firstReq = buildSignedRequest({ pathname: ROUTE_PATHNAME, body });
    const firstRes = await callRoute(firstReq);

    expect(firstRes.status).toBe(200);
    expect(saleorTrace.customerCreateCount).toBe(1);

    resetSaleorTrace();

    const secondReq = buildSignedRequest({ pathname: ROUTE_PATHNAME, body });
    const secondRes = await callRoute(secondReq);

    expect(secondRes.status).toBe(200);
    expect(saleorTrace.customerCreateCount).toBe(0);
  });

  it("returns 401 on bad HMAC", async () => {
    const brandingOrigin = await buildBrandingOriginToken();
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "x",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      },
      secret: "the-wrong-secret",
    });

    const res = await callRoute(req);

    expect(res.status).toBe(401);
    expect(saleorTrace.customerCreateCount).toBe(0);
  });

  it(
    "p95 latency over 1000 requests is under 600 ms (T19 budget)",
    { timeout: 300_000 },
    async () => {
      const brandingOrigin = await buildBrandingOriginToken();
      const body = {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "fief-auth-code-bench",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      };

      // Seed once outside the loop so every iteration takes the warm path.
      await callRoute(buildSignedRequest({ pathname: ROUTE_PATHNAME, body }));
      resetSaleorTrace();

      const samples = await measureLatency(1000, async () => {
        const req = buildSignedRequest({ pathname: ROUTE_PATHNAME, body });
        const res = await callRoute(req);

        if (res.status !== 200) {
          throw new Error(`expected 200, got ${res.status}`);
        }
      });

      const p95 = percentile(samples.perRequestMs, 95);
      const p99 = percentile(samples.perRequestMs, 99);
      const median = percentile(samples.perRequestMs, 50);

      console.log(
        `T19 latency over 1000 reqs: median=${median.toFixed(2)}ms p95=${p95.toFixed(
          2,
        )}ms p99=${p99.toFixed(2)}ms total=${samples.totalMs.toFixed(0)}ms`,
      );

      expect(p95).toBeLessThan(600);
    },
  );

  it("connection-pool singleton invariant — only one MongoClient.connect across the run", () => {
    const calls = harness.getConnectCallCount();

    expect(calls).toBe(1);
  });
});
