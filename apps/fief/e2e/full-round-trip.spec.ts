/**
 * @vitest-environment node
 *
 * T42 — End-to-end test: full SSO + bidirectional sync round trip.
 *
 * This is the production-rollout gate.
 *
 * Mocked-mode flow (the automated CI run):
 *
 *   1. Configure a connection (the e2e seeds via the Mongo repo — equivalent
 *      to the tRPC `connections.create` path, just without the dashboard
 *      JWT layer; same use case wiring downstream).
 *   2. Storefront login through the auth-plane HTTP endpoints:
 *        a. POST `/api/auth/external-authentication-url` (T18) → asserts the
 *           authorize URL embeds a `branding_origin` token signed against
 *           the connection's per-connection signing key (T15 + T46
 *           verifier-side). The `branding_origin` round-trip is the T46
 *           production-rollout gate's primary signal.
 *        b. POST `/api/auth/external-obtain-access-tokens` (T19) → asserts a
 *           Saleor customer is created (via the SaleorFake), the
 *           identity_map row is bound, and Fief claims project into
 *           Saleor metadata + privateMetadata.
 *   3. Mutate the customer in Saleor (via the SaleorFake) → drive the T27
 *      `CustomerUpdatedUseCase` and assert the Fief admin mock observed a
 *      PATCH /admin/api/users/{id} call.
 *   4. Mutate the customer in Fief (via the admin mock) → drive the T23
 *      `UserUpsertUseCase` (the use case the production receiver dispatch
 *      chain ultimately invokes) and assert the SaleorFake observed
 *      metadata updates.
 *   5. Final assertions:
 *        - **No DLQ entries** — the dlq collection is empty.
 *        - **No loop events** — every identity_map row has a strictly
 *          monotonic `lastSyncSeq`, asserted across every write.
 *        - **Branding renders** — the authorize URL includes a signed
 *          `branding_origin` that the verifier accepts (T46 contract).
 *
 * Live-mode (manual) flow: see `apps/fief/e2e/README.md` for the
 * staging-Saleor + staging-opensensor-fief invocation.
 */

// cspell:ignore upsert opensensor

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { verify as verifyBrandingOrigin } from "@/modules/branding/origin-signer";

import {
  ALLOWED_ORIGIN,
  buildSignedRequest,
  CHANNEL_SLUG,
  CONNECTION_ID,
  driveSaleorCustomerUpdated,
  type E2EHarness,
  FIEF_BASE_URL,
  FIEF_CLIENT_ID,
  FIEF_TENANT_ID,
  FIEF_USER_ID,
  REDIRECT_URI,
  SALEOR_API_URL,
  SALEOR_USER_ID_RAW,
  seedConnection,
  SIGNING_KEY,
  startHarness,
  stopHarness,
} from "./harness";

/*
 * The production T19 route reads `claims` directly from the exchange
 * response. Mocking the OIDC client at the module boundary mirrors what the
 * T40 integration test does — the integration test exercises everything
 * else end-to-end (HMAC verify → Mongo channel resolver → decryption →
 * identity-map upsert → metadata project + write → claims-shaper) so we
 * can do the same here.
 *
 * The SaleorFake is the Saleor write surface, injected into the auth-plane
 * route's `buildDeps` and into the Fief→Saleor `UserUpsertUseCase`.
 */

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
    }) {
      this.exchangeCount += 1;
      this.lastInput = input;

      const { ok } = await import("neverthrow");

      return ok({
        accessToken: "fief-access-token-e2e",
        idToken: "fief-id-token-e2e",
        refreshToken: "fief-refresh-token-e2e",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: "openid email profile",
        claims: oidcMockState.nextClaims,
      });
    }

    async refreshToken() {
      const { ok } = await import("neverthrow");

      return ok({});
    }

    async revokeToken() {
      const { ok } = await import("neverthrow");

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
        saleorClient: harness.saleorFake.client,
      };
    },
  };
});

const oidcMockState = {
  nextClaims: {} as Record<string, unknown>,
};

const ROUTE_AUTH_URL = "/api/auth/external-authentication-url";
const ROUTE_OBTAIN = "/api/auth/external-obtain-access-tokens";

let harness: E2EHarness;

const callAuthUrlRoute = async (req: Request): Promise<Response> => {
  const { POST } = await import("@/app/api/auth/external-authentication-url/route");

  return POST(req as never);
};

const callObtainRoute = async (req: Request): Promise<Response> => {
  const { POST } = await import("@/app/api/auth/external-obtain-access-tokens/route");

  return POST(req as never);
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
  harness.saleorFake.reset();

  oidcMockState.nextClaims = {
    sub: FIEF_USER_ID,
    email: "alice@example.com",
    first_name: "Alice",
    last_name: "Example",
    is_active: true,
    loyalty_tier: "silver",
  };

  /*
   * Wipe per-test state for the round-trip collections — the connection +
   * channel-config are seeded once in `beforeAll`.
   */
  await harness.db.collection("identity_map").deleteMany({});
  await harness.db.collection("webhook_log").deleteMany({});
  await harness.db.collection("dlq").deleteMany({});
});

describe("T42 — full SSO + bidirectional sync E2E (mocked Fief + mocked Saleor)", () => {
  it("step 1: external-authentication-url returns a Fief authorize URL with verifiable branding_origin (T18 + T46)", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_AUTH_URL,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: { redirectUri: REDIRECT_URI, origin: ALLOWED_ORIGIN },
      },
    });

    const res = await callAuthUrlRoute(req);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);

    expect(url.origin).toBe(FIEF_BASE_URL);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe(FIEF_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

    /*
     * T46 contract: the authorize URL carries a signed `branding_origin`
     * the Fief verifier (the opensensor-fief T46 verifier-side, mirrored by
     * the in-app verifier here) accepts. Verifying with the connection's
     * signing key + allowedOrigins list is exactly what the production Fief
     * pipeline does after `/authorize` lands. A failure here means the
     * upstream brand resolver would silently fall back to the default
     * brand — the production-rollout gate this task documents.
     */
    const brandingToken = url.searchParams.get("branding_origin");

    expect(brandingToken).toBeTruthy();

    const verifyResult = verifyBrandingOrigin(brandingToken!, SIGNING_KEY, [ALLOWED_ORIGIN]);

    expect(verifyResult.isOk()).toBe(true);
    expect(verifyResult._unsafeUnwrap().origin).toBe(ALLOWED_ORIGIN);
  });

  it("step 2: external-obtain-access-tokens creates a Saleor customer + binds identity_map + projects claims (T19)", async () => {
    /* Mint the branding token the auth-plane front door would have minted in step 1. */
    const { sign: signBrandingOrigin } = await import("@/modules/branding/origin-signer");
    const brandingOrigin = await signBrandingOrigin(ALLOWED_ORIGIN, SIGNING_KEY);

    const req = buildSignedRequest({
      pathname: ROUTE_OBTAIN,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "fief-auth-code-roundtrip",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      },
    });

    const res = await callObtainRoute(req);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.id).toBe(SALEOR_USER_ID_RAW);
    expect(body.email).toBe("alice@example.com");

    /* Saleor customer was created exactly once. */
    expect(harness.saleorFake.trace.customerCreateCount).toBe(1);
    /* Public + private metadata writes both fired. */
    expect(harness.saleorFake.trace.metadataUpdateCount).toBe(1);
    expect(harness.saleorFake.trace.privateMetadataUpdateCount).toBe(1);

    const customer = harness.saleorFake.getCustomer(SALEOR_USER_ID_RAW);

    expect(customer).toBeDefined();
    expect(customer!.email).toBe("alice@example.com");

    /*
     * Claims projection (T14) — `first_name` claim → public `fief_first_name`
     * key; `loyalty_tier` claim → private `fief_loyalty_tier` key.
     */
    const publicMetaMap = new Map(customer!.metadata.map((m) => [m.key, m.value]));
    const privateMetaMap = new Map(customer!.privateMetadata.map((m) => [m.key, m.value]));

    expect(publicMetaMap.get("fief_first_name")).toBe("Alice");
    expect(privateMetaMap.get("fief_loyalty_tier")).toBe("silver");

    /*
     * Loop-guard markers (T13) — the auth-plane writes targetSide="fief"
     * because the change ORIGINATED on Fief. The marker landing on Saleor's
     * side is what the Saleor → Fief loop guard later observes to drop the
     * echo. The seq must also be present on the private bucket.
     */
    expect(publicMetaMap.get("fief_sync_origin")).toBe("fief");
    expect(privateMetaMap.has("fief_sync_seq")).toBe(true);

    /* identity_map row was bound at the storage layer. */
    const identityRow = await harness.db.collection("identity_map").findOne({
      fiefUserId: FIEF_USER_ID,
    });

    expect(identityRow).toBeDefined();
    expect(identityRow!.saleorUserId).toBe(SALEOR_USER_ID_RAW);
    expect(identityRow!.lastSyncSeq).toBe(1);
  });

  it("step 3: mutating the customer in Saleor patches the Fief user (T27 + T5)", async () => {
    /* Re-seed the prior step's state via a fresh login. */
    const { sign: signBrandingOrigin } = await import("@/modules/branding/origin-signer");
    const brandingOrigin = await signBrandingOrigin(ALLOWED_ORIGIN, SIGNING_KEY);
    const loginReq = buildSignedRequest({
      pathname: ROUTE_OBTAIN,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "fief-auth-code-step3",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      },
    });
    const loginRes = await callObtainRoute(loginReq);

    expect(loginRes.status).toBe(200);

    /*
     * Pre-seed the Fief admin mock with a record matching FIEF_USER_ID so the
     * identity_map → PATCH chain has a target.
     */
    harness.fiefMock.upsertAdminUser({
      id: FIEF_USER_ID,
      email: "alice@example.com",
      email_verified: false,
      is_active: true,
      tenant_id: FIEF_TENANT_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      fields: {},
    });

    /* Operator changes the customer's email in Saleor. */
    const mutated = harness.saleorFake.mutateCustomer(SALEOR_USER_ID_RAW, {
      email: "alice-new@example.com",
      isConfirmed: true,
    });

    /*
     * Drive the Saleor → Fief direction. In production the route handler
     * (T27) enqueues a job; the worker (T52) drains it; the use case
     * (T27 use case) hits T5's admin client → PATCH. The e2e drives the
     * use case directly because the queue worker is a runtime concern (its
     * tests live in `src/modules/queue/worker.test.ts`); this lets the
     * round trip stay deterministic without a polling sleep.
     */
    const result = await driveSaleorCustomerUpdated({
      customer: mutated,
      saleorApiUrl: SALEOR_API_URL,
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap() as { outcome: string };

    expect(outcome.outcome).toBe("synced");

    /* The Fief admin mock observed a PATCH /admin/api/users/{id}. */
    expect(harness.fiefMock.state.adminUserPatchCount).toBe(1);

    const updated = harness.fiefMock.getAdminUser(FIEF_USER_ID);

    expect(updated).toBeDefined();
    expect(updated!.email).toBe("alice-new@example.com");
    expect(updated!.email_verified).toBe(true);

    /* Body shape — T27 patches `email` + `email_verified` + `fields.{first_name,last_name}`. */
    const patchBody = harness.fiefMock.state.lastUserPatchBody!;

    expect(patchBody.email).toBe("alice-new@example.com");
    expect(patchBody.email_verified).toBe(true);
    /*
     * `firstName` / `lastName` propagate from the Saleor customer record's
     * current state — the cold-login synced Fief's `first_name = "Alice"`
     * + `last_name = "Example"` into the SaleorFake's customer fields.
     */
    expect((patchBody.fields as Record<string, unknown>).first_name).toBe("Alice");
    expect((patchBody.fields as Record<string, unknown>).last_name).toBe("Example");

    /*
     * identity_map seq must have advanced — was 1 after the cold-login,
     * is 2 after the patch.
     */
    const identityRow = await harness.db.collection("identity_map").findOne({
      fiefUserId: FIEF_USER_ID,
    });

    expect(identityRow!.lastSyncSeq).toBeGreaterThan(1);
  });

  it("step 4: mutating the user in Fief updates the Saleor customer via T23 → SaleorFake metadata writes", async () => {
    /* Re-seed state for an independent step. */
    const { sign: signBrandingOrigin } = await import("@/modules/branding/origin-signer");
    const brandingOrigin = await signBrandingOrigin(ALLOWED_ORIGIN, SIGNING_KEY);
    const loginReq = buildSignedRequest({
      pathname: ROUTE_OBTAIN,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "fief-auth-code-step4",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      },
    });

    await callObtainRoute(loginReq);

    /*
     * Reset the Saleor write trace so the assertions below count only the
     * Fief→Saleor direction's writes.
     */
    const writesBeforeFiefDirection = {
      metadataUpdateCount: harness.saleorFake.trace.metadataUpdateCount,
      privateMetadataUpdateCount: harness.saleorFake.trace.privateMetadataUpdateCount,
    };

    /* Mutate the user in Fief — operator changes their loyalty tier. */
    const fiefUserAfterMutation = {
      id: FIEF_USER_ID,
      email: "alice@example.com",
      email_verified: false,
      is_active: true,
      tenant_id: FIEF_TENANT_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      fields: {
        first_name: "Alice",
        last_name: "Example",
        loyalty_tier: "gold",
      },
    };

    harness.fiefMock.upsertAdminUser(fiefUserAfterMutation);

    /*
     * Drive the Fief → Saleor direction via the T23 user-upsert use case.
     * Production: Fief webhook hits T22's receiver → eventRouter dispatches
     * to the registered T23 handler → handler calls `useCase.execute(...)`.
     * The e2e drives the use case directly because the eventRouter is a
     * module-level singleton wired at app boot, not in the test runtime.
     */
    const { UserUpsertUseCase } = await import(
      "@/modules/sync/fief-to-saleor/user-upsert.use-case"
    );
    const { MongoIdentityMapRepo } = await import(
      "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
    );

    const useCase = new UserUpsertUseCase({
      identityMapRepo: new MongoIdentityMapRepo(),
      saleorClient: harness.saleorFake.client,
    });

    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      claimMapping: [
        {
          fiefClaim: "first_name",
          saleorMetadataKey: "fief_first_name",
          visibility: "public",
        },
        {
          fiefClaim: "loyalty_tier",
          saleorMetadataKey: "fief_loyalty_tier",
          visibility: "private",
        },
      ],
      payload: {
        type: "user.updated",
        eventId: "fief-evt-step4",
        data: fiefUserAfterMutation as unknown as Record<string, unknown>,
      },
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();

    expect(outcome.kind).toBe("written");

    /*
     * SaleorFake observed BOTH metadata + privateMetadata writes from this
     * direction.
     */
    expect(harness.saleorFake.trace.metadataUpdateCount).toBeGreaterThan(
      writesBeforeFiefDirection.metadataUpdateCount,
    );
    expect(harness.saleorFake.trace.privateMetadataUpdateCount).toBeGreaterThan(
      writesBeforeFiefDirection.privateMetadataUpdateCount,
    );

    /* The mutated value (`loyalty_tier=gold`) projected into Saleor's private metadata. */
    const customer = harness.saleorFake.getCustomer(SALEOR_USER_ID_RAW);

    expect(customer).toBeDefined();
    const privateMap = new Map(customer!.privateMetadata.map((m) => [m.key, m.value]));

    expect(privateMap.get("fief_loyalty_tier")).toBe("gold");
  });

  it("final: no DLQ entries, monotonic identity_map seq, branding-origin verifies (production-rollout gate)", async () => {
    /*
     * MANDATORY final assertions (per the task spec):
     *   - No DLQ entries.
     *   - No loop events (seq is monotonic across the full flow).
     *   - Branding (T46) renders correctly — authorize URL embeds a signed
     *     branding_origin the verifier accepts.
     *
     * Run a full flow inside this case so the assertions reflect the
     * complete round trip rather than a single prior step's residue.
     */

    /* Step (a) — fresh login + branding URL check. */
    const authReq = buildSignedRequest({
      pathname: ROUTE_AUTH_URL,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: { redirectUri: REDIRECT_URI, origin: ALLOWED_ORIGIN },
      },
    });
    const authRes = await callAuthUrlRoute(authReq);

    expect(authRes.status).toBe(200);
    const authBody = (await authRes.json()) as { authorizationUrl: string };
    const authUrl = new URL(authBody.authorizationUrl);
    const brandingToken = authUrl.searchParams.get("branding_origin");

    expect(brandingToken).toBeTruthy();
    const verifyResult = verifyBrandingOrigin(brandingToken!, SIGNING_KEY, [ALLOWED_ORIGIN]);

    expect(verifyResult.isOk()).toBe(true);

    /* Step (b) — token exchange. */
    const { sign: signBrandingOrigin } = await import("@/modules/branding/origin-signer");
    const brandingOrigin = await signBrandingOrigin(ALLOWED_ORIGIN, SIGNING_KEY);
    const obtainReq = buildSignedRequest({
      pathname: ROUTE_OBTAIN,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          code: "fief-auth-code-final",
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
          brandingOrigin,
        },
      },
    });
    const obtainRes = await callObtainRoute(obtainReq);

    expect(obtainRes.status).toBe(200);

    /* Step (c) — Saleor → Fief. */
    harness.fiefMock.upsertAdminUser({
      id: FIEF_USER_ID,
      email: "alice@example.com",
      email_verified: false,
      is_active: true,
      tenant_id: FIEF_TENANT_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      fields: {},
    });

    const seqBeforeSaleorWrite = (await harness.db
      .collection("identity_map")
      .findOne({ fiefUserId: FIEF_USER_ID }))!.lastSyncSeq;

    const mutated = harness.saleorFake.mutateCustomer(SALEOR_USER_ID_RAW, {
      firstName: "Alice (updated)",
    });
    const saleorToFiefResult = await driveSaleorCustomerUpdated({
      customer: mutated,
      saleorApiUrl: SALEOR_API_URL,
    });

    expect(saleorToFiefResult.isOk()).toBe(true);

    const seqAfterSaleorWrite = (await harness.db
      .collection("identity_map")
      .findOne({ fiefUserId: FIEF_USER_ID }))!.lastSyncSeq;

    /* Step (d) — Fief → Saleor. */
    const { UserUpsertUseCase } = await import(
      "@/modules/sync/fief-to-saleor/user-upsert.use-case"
    );
    const { MongoIdentityMapRepo } = await import(
      "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
    );
    const useCase = new UserUpsertUseCase({
      identityMapRepo: new MongoIdentityMapRepo(),
      saleorClient: harness.saleorFake.client,
    });
    const fiefToSaleorResult = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      claimMapping: [
        {
          fiefClaim: "first_name",
          saleorMetadataKey: "fief_first_name",
          visibility: "public",
        },
      ],
      payload: {
        type: "user.updated",
        eventId: "fief-evt-final",
        data: {
          id: FIEF_USER_ID,
          email: "alice@example.com",
          tenant_id: FIEF_TENANT_ID,
          fields: { first_name: "Alice", last_name: "Example", loyalty_tier: "platinum" },
        },
      },
    });

    expect(fiefToSaleorResult.isOk()).toBe(true);

    const seqAfterFiefWrite = (await harness.db
      .collection("identity_map")
      .findOne({ fiefUserId: FIEF_USER_ID }))!.lastSyncSeq;

    /*
     * ============================================================
     * Final assertions — the production-rollout gate.
     * ============================================================
     */

    /*
     * (1) No DLQ entries — the dlq collection is empty.
     */
    const dlqEntries = await harness.db.collection("dlq").find({}).toArray();

    expect(dlqEntries).toHaveLength(0);

    /*
     * (2) No loop events — `lastSyncSeq` advances monotonically across the
     * full round trip (login → Saleor mutation → Fief mutation). A regression
     * here means a write echoed back through the loop guard and the seq
     * either stalled or rewound.
     */
    expect(seqBeforeSaleorWrite).toBe(1);
    expect(seqAfterSaleorWrite).toBeGreaterThan(seqBeforeSaleorWrite);
    expect(seqAfterFiefWrite).toBeGreaterThan(seqAfterSaleorWrite);

    /*
     * (3) Branding renders correctly — the authorize URL's branding_origin
     * verifies cleanly. Already asserted in step (a) above. Re-asserted
     * here so the production-rollout gate captures all three signals in a
     * single test for the operator dashboard's read-out.
     */
    expect(verifyResult.isOk()).toBe(true);
    expect(verifyResult._unsafeUnwrap().origin).toBe(ALLOWED_ORIGIN);

    /*
     * (4) Sanity: connection seeded as expected — the loop-guard relies on
     * `(saleorApiUrl, fiefUserId)` scoping which the seed established.
     */
    const connections = await harness.db
      .collection("provider_connections")
      .find({ id: CONNECTION_ID as unknown as string })
      .toArray();

    expect(connections).toHaveLength(1);
  });
});
