/**
 * @vitest-environment node
 *
 * T40 — Integration test for `POST /api/auth/external-refresh`.
 *
 * Boots Mongo + msw + composition root. The Saleor metadata client (T20's
 * GraphQL surface) is mocked at the deps boundary because T7 GraphQL wiring
 * is a follow-up; the mock asserts the route's diff/write decisions
 * end-to-end.
 *
 * Required tests:
 *   - Happy path: claims unchanged → no metadata write, returns shaped claims.
 *   - Fief refresh failure → 401 logout-required.
 *   - Bad HMAC → 401 (NOT logout-required).
 *   - Latency benchmark: p95 < 300 ms over 1000 sequential requests.
 */

import { err, ok, type Result } from "neverthrow";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSignedRequest,
  CHANNEL_SLUG,
  FIEF_USER_ID,
  type IntegrationHarness,
  measureLatency,
  percentile,
  SALEOR_API_URL,
  seedConnection,
  startHarness,
  stopHarness,
} from "./harness";

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type OidcModule = typeof import("@/modules/fief-client/oidc-client");
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type RefreshDepsModule = typeof import("@/app/api/auth/external-refresh/deps");

vi.mock("@/modules/fief-client/oidc-client", async (importOriginal) => {
  const original = await importOriginal<OidcModule>();

  class MockFiefOidcClient {
    public readonly baseUrl: string;
    public refreshCount = 0;

    constructor(input: { baseUrl: string }) {
      this.baseUrl = input.baseUrl;
    }

    async refreshToken(): Promise<Result<unknown, Error>> {
      this.refreshCount += 1;

      if (oidcRefreshState.shouldFail) {
        return err(new original.FiefOidcTokenError("invalid_grant"));
      }

      return ok({
        accessToken: `access-${this.refreshCount}`,
        idToken: `id-token-${this.refreshCount}`,
        refreshToken: `refresh-${this.refreshCount}`,
        expiresIn: 3600,
        tokenType: "Bearer",
      });
    }

    async exchangeCode(): Promise<Result<unknown, Error>> {
      return ok({});
    }

    async revokeToken(): Promise<Result<undefined, Error>> {
      return ok(undefined);
    }
  }

  return { ...original, FiefOidcClient: MockFiefOidcClient };
});

vi.mock("@/app/api/auth/external-refresh/deps", async (importOriginal) => {
  const real = await importOriginal<RefreshDepsModule>();
  const { getProductionDeps } = await import("@/lib/composition-root");

  return {
    ...real,
    buildProviderConnectionRepo: () => getProductionDeps().connectionRepo,
    buildChannelConfigurationRepo: () => getProductionDeps().channelConfigurationRepo,
    buildIdentityMapRepo: () => getProductionDeps().identityMapRepo,
    buildSaleorMetadataClient: () => saleorMetadataClientFake,
  };
});

interface SaleorMetadataTrace {
  extractClaimsCount: number;
  fetchSaleorUserCount: number;
  writeMetadataCount: number;
  lastWriteInput: unknown;
}

const saleorMetadataTrace: SaleorMetadataTrace = {
  extractClaimsCount: 0,
  fetchSaleorUserCount: 0,
  writeMetadataCount: 0,
  lastWriteInput: undefined,
};

interface SaleorMetadataState {
  freshClaims: Record<string, unknown>;
  saleorCustomer: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    isActive: boolean;
    metadata: Record<string, string>;
    privateMetadata: Record<string, string>;
  };
}

const saleorMetadataState: SaleorMetadataState = {
  freshClaims: {},
  saleorCustomer: {
    id: "VXNlcjox",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Example",
    isActive: true,
    metadata: {},
    privateMetadata: {},
  },
};

const saleorMetadataClientFake = {
  extractClaims: async () => {
    saleorMetadataTrace.extractClaimsCount += 1;

    return ok(saleorMetadataState.freshClaims);
  },
  fetchSaleorUser: async () => {
    saleorMetadataTrace.fetchSaleorUserCount += 1;

    return ok(saleorMetadataState.saleorCustomer);
  },
  writeSaleorMetadata: async (input: unknown) => {
    saleorMetadataTrace.writeMetadataCount += 1;
    saleorMetadataTrace.lastWriteInput = input;

    return ok(undefined);
  },
};

const oidcRefreshState = {
  shouldFail: false,
};

const ROUTE_PATHNAME = "/api/auth/external-refresh";

let harness: IntegrationHarness;

const callRoute = async (req: Request): Promise<Response> => {
  const { POST } = await import("@/app/api/auth/external-refresh/route");

  return POST(req as never);
};

const seedIdentityMap = async () => {
  const { MongoIdentityMapRepo } = await import(
    "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
  );
  const { createSaleorUserId, createSyncSeq } = await import("@/modules/identity-map/identity-map");
  const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

  const repo = new MongoIdentityMapRepo();
  const saleorUserId = createSaleorUserId("VXNlcjox")._unsafeUnwrap();
  const fiefUserId = FiefUserIdSchema.parse(FIEF_USER_ID);
  const syncSeq = createSyncSeq(1)._unsafeUnwrap();

  const result = await repo.upsert({
    saleorApiUrl: SALEOR_API_URL,
    saleorUserId,
    fiefUserId,
    syncSeq,
  });

  if (result.isErr()) {
    throw result.error;
  }
};

const resetTrace = () => {
  saleorMetadataTrace.extractClaimsCount = 0;
  saleorMetadataTrace.fetchSaleorUserCount = 0;
  saleorMetadataTrace.writeMetadataCount = 0;
  saleorMetadataTrace.lastWriteInput = undefined;
};

beforeAll(async () => {
  harness = await startHarness();
  await seedConnection();
  await seedIdentityMap();
}, 120_000);

afterAll(async () => {
  await stopHarness();
});

beforeEach(() => {
  harness.fiefMock.reset();
  resetTrace();
  oidcRefreshState.shouldFail = false;
  saleorMetadataState.freshClaims = {
    sub: FIEF_USER_ID,
    email: "alice@example.com",
    first_name: "Alice",
    last_name: "Example",
    is_active: true,
  };
  saleorMetadataState.saleorCustomer = {
    id: "VXNlcjox",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Example",
    isActive: true,
    metadata: {},
    privateMetadata: {},
  };
});

describe("T40 — external-refresh end-to-end", () => {
  it("happy path: claims unchanged → no metadata write, returns shaped claims", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: { refreshToken: "fief-refresh-token-1" },
    });

    const res = await callRoute(req);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.logoutRequired).toBe(false);
    expect(body.fiefAccessToken).toBeTruthy();
    expect(body.claims).toBeTruthy();

    expect(saleorMetadataTrace.writeMetadataCount).toBe(0);
  });

  it("Fief refresh failure → 401 logout-required", async () => {
    oidcRefreshState.shouldFail = true;
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: { refreshToken: "stale-refresh-token" },
    });

    const res = await callRoute(req);

    expect(res.status).toBe(401);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.logoutRequired).toBe(true);
    expect(body.error).toBe("logout_required");
  });

  it("returns 401 (NOT logout-required) on bad HMAC", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: { refreshToken: "fief-refresh-token-1" },
      secret: "the-wrong-secret",
    });

    const res = await callRoute(req);

    expect(res.status).toBe(401);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.logoutRequired).toBeUndefined();
    expect(body.error).toBe("Unauthorized");
  });

  it(
    "p95 latency over 1000 requests is under 300 ms (T20 budget)",
    { timeout: 300_000 },
    async () => {
      const samples = await measureLatency(1000, async () => {
        const req = buildSignedRequest({
          pathname: ROUTE_PATHNAME,
          body: { refreshToken: "fief-refresh-token-bench" },
        });
        const res = await callRoute(req);

        if (res.status !== 200) {
          throw new Error(`expected 200, got ${res.status}`);
        }
      });

      const p95 = percentile(samples.perRequestMs, 95);
      const p99 = percentile(samples.perRequestMs, 99);
      const median = percentile(samples.perRequestMs, 50);

      console.log(
        `T20 latency over 1000 reqs: median=${median.toFixed(2)}ms p95=${p95.toFixed(
          2,
        )}ms p99=${p99.toFixed(2)}ms total=${samples.totalMs.toFixed(0)}ms`,
      );

      expect(p95).toBeLessThan(300);
    },
  );

  it("connection-pool singleton invariant — only one MongoClient.connect across the run", () => {
    const calls = harness.getConnectCallCount();

    expect(calls).toBe(1);
  });
});

void CHANNEL_SLUG;
