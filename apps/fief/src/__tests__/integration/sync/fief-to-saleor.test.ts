/**
 * @vitest-environment node
 *
 * T41 — Fief→Saleor sync integration.
 *
 * Drives T22's webhook receiver against the production route handler with
 * real Mongo (memory-server) + msw-mocked Fief admin API. The Saleor write
 * surface is a recording fake (the Saleor GraphQL wiring is a deferred T7
 * follow-up — same approach the T19 unit tests took).
 *
 * Suites covered:
 *   - T23 `user.created` / `user.updated` (UserUpsertUseCase)
 *   - T24 `user.deleted` (UserDeleteUseCase)
 *   - T25 `user_permission.*` / `user_role.*` / `user_field.updated`
 *
 * Cross-cutting properties asserted:
 *   - identity_map row written + read across calls.
 *   - HMAC verify against the seeded webhook secret.
 *   - Loop guard drops origin="saleor" payloads (canary lives in
 *      `loop-prevention.test.ts`; this suite asserts the happy non-echo
 *      path so the canary's failure mode is meaningful).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSaleorUserId, type SaleorUserId } from "@/modules/identity-map/identity-map";

import {
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

  const { MongoIdentityMapRepo } = await import(
    "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
  );
  const identityMapRepo = new MongoIdentityMapRepo();

  /*
   * Wire `fiefAdmin.getUser` against a real `FiefAdminApiClient` instance
   * so T25's network path is exercised through msw end-to-end.
   */
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
    identityMapRepo,
    fiefAdmin: {
      getUser: realAdminClient.getUser.bind(realAdminClient),
    },
  });

  await harness.db.collection("identity_map").deleteMany({});
  await harness.db.collection("webhook_log").deleteMany({});
});

const ALICE_FIEF_USER = FIEF_USER_ID;
const ALICE_EMAIL = "alice@example.com";

describe("T23 — Fief→Saleor user.created / user.updated", () => {
  it("user.created: creates Saleor customer + identity_map row", async () => {
    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.created",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        is_active: true,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.status).toBe("accepted");
    expect(body.eventType).toBe("user.created");

    expect(saleorClient.trace.customerCreateCount).toBe(1);
    expect(saleorClient.trace.updateMetadataCount).toBe(1);
    expect(saleorClient.trace.updatePrivateMetadataCount).toBe(1);

    const row = await harness.db.collection("identity_map").findOne({
      fiefUserId: ALICE_FIEF_USER,
    });

    expect(row).toBeTruthy();
    expect(row?.saleorUserId).toBeTruthy();
  });

  it("user.updated for an existing binding: re-uses saleorUserId, no second customerCreate", async () => {
    // First create.
    const firstRes = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.created",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
    });

    expect(firstRes.status).toBe(200);
    expect(saleorClient.trace.customerCreateCount).toBe(1);

    saleorClient.reset();

    // Update with new claim values (different timestamp so dedup doesn't bite).
    const secondRes = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.updated",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        tenant_id: FIEF_TENANT_ID,
        fields: { first_name: "Alice2" },
      },
      timestamp: Math.floor(Date.now() / 1000) + 1,
    });

    expect(secondRes.status).toBe(200);
    expect(saleorClient.trace.customerCreateCount).toBe(0);
    expect(saleorClient.trace.updateMetadataCount).toBe(1);
    expect(saleorClient.trace.updatePrivateMetadataCount).toBe(1);
  });

  it("dedup: replay of identical webhook (same timestamp + body) returns 200 + duplicate", async () => {
    const ts = Math.floor(Date.now() / 1000);

    const first = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.created",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
      timestamp: ts,
    });

    expect(first.status).toBe(200);
    expect(saleorClient.trace.customerCreateCount).toBe(1);

    const second = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.created",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
      timestamp: ts,
    });

    expect(second.status).toBe(200);
    const body = (await second.json()) as Record<string, unknown>;

    expect(body.status).toBe("duplicate");
    // The second delivery MUST NOT trigger another Saleor customerCreate.
    expect(saleorClient.trace.customerCreateCount).toBe(1);
  });

  it("bad HMAC: returns 401, no Saleor I/O", async () => {
    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.created",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
      secret: "wrong-secret",
    });

    expect(res.status).toBe(401);
    expect(saleorClient.trace.customerCreateCount).toBe(0);
  });

  it("unknown connection: returns 410 Gone", async () => {
    const res = await deliverFiefWebhook({
      connectionId: "00000000-0000-4000-8000-000000000000",
      type: "user.created",
      data: {
        id: ALICE_FIEF_USER,
        email: ALICE_EMAIL,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
    });

    expect(res.status).toBe(410);
  });
});

describe("T24 — Fief→Saleor user.deleted", () => {
  it("user.deleted with existing binding: deactivates Saleor customer (isActive=false)", async () => {
    // Pre-bind identity_map so the delete handler finds the saleorUserId.
    const saleorUserId: SaleorUserId = createSaleorUserId("VXNlcjox")._unsafeUnwrap();

    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId,
      fiefUserId: ALICE_FIEF_USER as never,
      syncSeq: 1,
    });

    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.deleted",
      data: {
        id: ALICE_FIEF_USER,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
    });

    expect(res.status).toBe(200);

    expect(saleorDeactivateClient.trace.customerUpdateCount).toBe(1);
    expect(saleorDeactivateClient.trace.lastIsActive).toBe(false);
    expect(saleorDeactivateClient.trace.updateMetadataCount).toBe(1);
  });

  it("user.deleted without binding: idempotent no-op (no Saleor I/O)", async () => {
    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user.deleted",
      data: {
        id: ALICE_FIEF_USER,
        tenant_id: FIEF_TENANT_ID,
        fields: {},
      },
    });

    expect(res.status).toBe(200);
    expect(saleorDeactivateClient.trace.customerUpdateCount).toBe(0);
    expect(saleorDeactivateClient.trace.updateMetadataCount).toBe(0);
  });
});

describe("T25 — Fief→Saleor permission/role/field events", () => {
  it("user_permission.created with a binding: re-fetches Fief user + writes Saleor metadata", async () => {
    const saleorUserId: SaleorUserId = createSaleorUserId("VXNlcjoy")._unsafeUnwrap();

    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId,
      fiefUserId: ALICE_FIEF_USER as never,
      syncSeq: 1,
    });

    fiefAdmin.seedUser({
      id: ALICE_FIEF_USER,
      email: ALICE_EMAIL,
      fields: { plan: "premium" },
    });

    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user_permission.created",
      data: {
        user_id: ALICE_FIEF_USER,
        permission_id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
      },
    });

    expect(res.status).toBe(200);
    expect(fiefAdmin.getUserCalls).toBeGreaterThanOrEqual(1);
    expect(saleorClient.trace.updateMetadataCount).toBeGreaterThanOrEqual(1);
  });

  it("user_field.updated: raises a reconciliation flag (no per-user fan-out)", async () => {
    let raisedCount = 0;

    const reconciliationFlagRepo = {
      raise: async () => {
        raisedCount += 1;
        const { ok } = await import("neverthrow");

        return ok({}) as never;
      },
      get: async () => {
        const { ok } = await import("neverthrow");

        return ok(null) as never;
      },
    };

    // Re-register handlers with the recording flag repo.
    const { MongoIdentityMapRepo } = await import(
      "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
    );
    const { FiefAdminApiClient } = await import("@/modules/fief-client/admin-api-client");
    const realAdminClient = FiefAdminApiClient.create({
      baseUrl: FIEF_BASE_URL as never,
    });

    await resetFiefEventRouter();
    await registerTestFiefHandlers({
      saleorApiUrl: SALEOR_API_URL,
      claimMapping: [],
      adminToken: "fief-admin-token-test" as never,
      saleorClient,
      saleorDeactivateClient,
      identityMapRepo: new MongoIdentityMapRepo(),
      fiefAdmin: {
        getUser: realAdminClient.getUser.bind(realAdminClient),
      },
      reconciliationFlagRepo,
    });

    const res = await deliverFiefWebhook({
      connectionId: CONNECTION_ID as unknown as string,
      type: "user_field.updated",
      data: {
        id: "ffffffff-1111-4111-8111-ffffffffffff",
        slug: "plan",
        name: "Plan",
        type: "STRING",
      },
    });

    expect(res.status).toBe(200);
    expect(raisedCount).toBe(1);
    expect(saleorClient.trace.updateMetadataCount).toBe(0);
  });
});
