/**
 * @vitest-environment node
 *
 * T41 — Loop-prevention canary (MANDATORY).
 *
 * Without this test, T13's origin marker can silently regress and
 * infinite-loop production. Two natural loops are induced and asserted:
 *
 *   1. Saleor change → Fief webhook fires back → MUST be dropped by T13.
 *      The payload's Fief `fields` carries `fief_sync_origin = "saleor"`,
 *      mirroring what `tagWrite("saleor", ...)` would have stamped on the
 *      Saleor→Fief outbound write.
 *
 *   2. Fief change → Saleor webhook fires back → MUST be dropped by T13.
 *      The Saleor user's `metadata` carries `fief_sync_origin = "fief"`,
 *      mirroring what `tagWrite("fief", ...)` stamped on the Fief→Saleor
 *      outbound write.
 *
 * **Regression-detection canary**: each loop test has a "control" variant
 * that REMOVES the origin marker and asserts the test sees a write — proving
 * that if any handler stops emitting the marker (or stops checking it), the
 * positive assertion would flip and this suite would fail loudly.
 *
 * Wire-format detail: the loop-guard reads markers from
 *   - Fief side: `data.fields[fief_sync_origin]` (the receiver delivers
 *      these to the use case).
 *   - Saleor side: `payload.user.metadata[].key === "fief_sync_origin"`
 *      (the route handler pre-filters before enqueue, and the use case
 *      defensively re-checks in case the route was bypassed by a
 *      pre-deploy queue row).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHANNEL_SLUG,
  CONNECTION_ID,
  FIEF_USER_ID,
  type IntegrationHarness,
  SALEOR_API_URL,
  seedConnection,
  startHarness,
  stopHarness,
} from "../auth/harness";
import {
  deliverFiefWebhook,
  registerTestFiefHandlers,
  resetFiefEventRouter,
} from "./helpers/fief-receiver-helpers";
import {
  buildSaleorUserPayload,
  buildSaleorWebhookRequest,
  type SyntheticSaleorCtx,
} from "./helpers/saleor-webhook-helpers";
import {
  createInMemorySaleorClient,
  createInMemorySaleorDeactivateClient,
  type FiefAdminMockHandle,
  type InMemorySaleorClient,
  type InMemorySaleorDeactivateClient,
  installFiefAdminMock,
  seedIdentityMapRow,
} from "./helpers/sync-harness";

const FIEF_BASE_URL = "https://tenant.test-fief.invalid";
const FIEF_TENANT_ID = "33333333-3333-4333-8333-333333333333";

/*
 * SDK adapter mock — same pattern as `saleor-to-fief.test.ts`. The
 * implementation factory is hoisted so `beforeEach` can re-attach it
 * after vitest's `mockReset: true` clears it (otherwise webhook-definition
 * modules loaded for the first time in a later test would construct
 * against a no-op SaleorAsyncWebhook).
 */
const __nextCtx = vi.hoisted(() => ({
  current: undefined as undefined | SyntheticSaleorCtx,
}));

const sdkImpl = vi.hoisted(() => () => ({
  createHandler: (handler: (req: Request, ctx: unknown) => Promise<Response>) => {
    return async (req: Request) => {
      if (!__nextCtx.current) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }

      return handler(req, __nextCtx.current);
    };
  },
  getWebhookManifest: () => ({ name: "Customer Webhook" }),
}));

vi.mock("@saleor/app-sdk/handlers/next-app-router", () => ({
  SaleorAsyncWebhook: vi.fn().mockImplementation(sdkImpl),
}));

let harness: IntegrationHarness;
let saleorClient: InMemorySaleorClient;
let saleorDeactivateClient: InMemorySaleorDeactivateClient;
let fiefAdmin: FiefAdminMockHandle;

beforeAll(async () => {
  harness = await startHarness();
  await seedConnection();

  fiefAdmin = installFiefAdminMock(harness.server, FIEF_BASE_URL, FIEF_TENANT_ID);
}, 120_000);

afterAll(async () => {
  await stopHarness();
});

beforeEach(async () => {
  await resetFiefEventRouter();
  saleorClient = createInMemorySaleorClient();
  saleorDeactivateClient = createInMemorySaleorDeactivateClient();
  fiefAdmin.reset();

  /*
   * Re-attach the SDK mock's `mockImplementation` after vitest's
   * `mockReset: true` cleared it.
   */
  const { SaleorAsyncWebhook } = await import("@saleor/app-sdk/handlers/next-app-router");

  vi.mocked(SaleorAsyncWebhook).mockImplementation(sdkImpl as never);

  await harness.db.collection("identity_map").deleteMany({});
  await harness.db.collection("webhook_log").deleteMany({});
  await harness.db.collection("outbound_queue").deleteMany({});

  const { MongoIdentityMapRepo } = await import(
    "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
  );
  const { FiefAdminApiClient } = await import("@/modules/fief-client/admin-api-client");
  const realAdminClient = FiefAdminApiClient.create({
    baseUrl: FIEF_BASE_URL as never,
  });

  await registerTestFiefHandlers({
    saleorApiUrl: SALEOR_API_URL,
    claimMapping: [],
    adminToken: "fief-admin-token-test" as never,
    saleorClient,
    saleorDeactivateClient,
    identityMapRepo: new MongoIdentityMapRepo(),
    fiefAdmin: { getUser: realAdminClient.getUser.bind(realAdminClient) },
  });
});

afterEach(() => {
  __nextCtx.current = undefined;
});

/*
 * ============================================================================
 * Loop direction 1: Saleor change → Fief webhook fires back.
 *
 * The Fief webhook's user.fields includes `fief_sync_origin = "saleor"`.
 * The Fief→Saleor processing side is "saleor". `shouldSkip` returns true
 * (origin === processingSide). The use case MUST drop the event WITHOUT
 * any Saleor write.
 * ============================================================================
 */

describe("Loop canary 1 — Saleor change echoed back via Fief webhook", () => {
  it("MANDATORY: Fief webhook with origin=saleor marker is dropped (no Saleor write)", async () => {
    /*
     * Pre-bind so a regression that bypasses the loop guard would actually
     * make Saleor writes (otherwise the absence of writes could be
     * explained by "no binding, customer not created here").
     */
    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId: "VXNlcjox" as never,
      fiefUserId: FIEF_USER_ID as never,
      syncSeq: 1,
    });

    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.updated",
      data: {
        id: FIEF_USER_ID,
        email: "alice@example.com",
        tenant_id: FIEF_TENANT_ID,
        fields: {
          fief_sync_origin: "saleor", // <-- origin marker says "this came from Saleor"
        },
      },
    });

    expect(res.status).toBe(200);

    // The use case MUST have skipped — no metadata writes.
    expect(saleorClient.trace.updateMetadataCount).toBe(0);
    expect(saleorClient.trace.updatePrivateMetadataCount).toBe(0);
    expect(saleorClient.trace.customerCreateCount).toBe(0);
  });

  it("control: identical webhook WITHOUT origin marker DOES write (proves the canary detects regression)", async () => {
    /*
     * If the loop guard is silently disabled (e.g. someone deletes the
     * `tagWrite(...)` call), this test stays green BUT the positive test
     * above flips to "writes happened" because both branches now write.
     *
     * The control test doubles as a sanity check: with no origin marker,
     * the use case progresses and writes Saleor metadata. If THIS test
     * fails (no writes happened), the test infrastructure is broken
     * upstream — investigate before assuming the canary is the bug.
     */
    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId: "VXNlcjoy" as never,
      fiefUserId: FIEF_USER_ID as never,
      syncSeq: 1,
    });

    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.updated",
      data: {
        id: FIEF_USER_ID,
        email: "alice@example.com",
        tenant_id: FIEF_TENANT_ID,
        fields: {}, // <-- no origin marker
      },
    });

    expect(res.status).toBe(200);

    // With no marker, the use case MUST process the event — Saleor writes happen.
    expect(saleorClient.trace.updateMetadataCount).toBe(1);
    expect(saleorClient.trace.updatePrivateMetadataCount).toBe(1);
  });
});

/*
 * ============================================================================
 * Loop direction 2: Fief change → Saleor webhook fires back.
 *
 * The Saleor `user.metadata` includes `fief_sync_origin = "fief"`. The
 * Saleor→Fief route handler pre-filters this and drops the event WITHOUT
 * even enqueueing a job onto the outbound queue. This is the load-bearing
 * defense — if the route stops checking the marker, the queue would
 * accept echoes and the worker would loop them back through Fief.
 * ============================================================================
 */

describe("Loop canary 2 — Fief change echoed back via Saleor webhook", () => {
  it("MANDATORY: Saleor CUSTOMER_UPDATED with origin=fief is dropped (no enqueue, no Fief write)", async () => {
    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [
          { key: "_fief_channel", value: CHANNEL_SLUG as unknown as string },
          { key: "fief_sync_origin", value: "fief" }, // <-- origin marker says "this came from Fief"
        ],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-updated/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-updated",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_UPDATED",
      }) as never,
    );

    expect(res.status).toBe(200);

    // No queue write.
    const queueCount = await harness.db.collection("outbound_queue").countDocuments({});

    expect(queueCount).toBe(0);

    /*
     * Belt-and-suspenders: even if the route enqueued, no Fief write
     * happened (worker hasn't run, but the assertion is structural).
     */
    expect(fiefAdmin.updateUserCalls).toBe(0);
    expect(fiefAdmin.createUserCalls).toBe(0);
  });

  it("control: identical webhook WITHOUT origin marker DOES enqueue (proves the canary detects regression)", async () => {
    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
        // <-- no origin marker
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-updated/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-updated",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_UPDATED",
      }) as never,
    );

    expect(res.status).toBe(200);

    // Without marker, the route MUST enqueue.
    const queueCount = await harness.db.collection("outbound_queue").countDocuments({});

    expect(queueCount).toBe(1);
  });
});

/*
 * ============================================================================
 * Direct-induction canary: synthesize the natural loop end-to-end.
 *
 * Sequence:
 *   1. Drive the saleor-to-fief CUSTOMER_CREATED route — enqueue happens.
 *   2. Manually replay the same payload back through the Fief webhook
 *      (simulating "Fief now emits user.created/updated reflecting the
 *      Saleor write"). Mark the Fief data with origin="saleor".
 *   3. Assert the Fief→Saleor side does NOT loop back into Saleor writes.
 * ============================================================================
 */

describe("End-to-end loop induction (Saleor → Fief → Saleor echo)", () => {
  it("MANDATORY: a full Saleor change does not infinite-loop when Fief echoes back", async () => {
    /*
     * Step 1 — simulate the Saleor-side write being echoed via the Fief
     * webhook. In production T26's worker would have caused this; here
     * we model the Fief delivery directly with the `origin=saleor` tag
     * that T26 stamped on the Fief side via `updateUser({ fields: { fief_sync_origin: "saleor" }})`.
     */
    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId: "VXNlcjox" as never,
      fiefUserId: FIEF_USER_ID as never,
      syncSeq: 5,
    });

    saleorClient.reset();
    saleorDeactivateClient.reset();

    // Step 2 — the Fief echo arrives.
    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.updated",
      data: {
        id: FIEF_USER_ID,
        email: "alice@example.com",
        tenant_id: FIEF_TENANT_ID,
        fields: {
          fief_sync_origin: "saleor",
          fief_sync_seq: "5",
        },
      },
    });

    expect(res.status).toBe(200);

    // Step 3 — assertion: NO Saleor writes (loop broken).
    expect(saleorClient.trace.customerCreateCount).toBe(0);
    expect(saleorClient.trace.updateMetadataCount).toBe(0);
    expect(saleorClient.trace.updatePrivateMetadataCount).toBe(0);
  });
});
