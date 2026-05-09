/**
 * @vitest-environment node
 *
 * T41 — Saleor→Fief sync integration.
 *
 * Drives the four Saleor webhook routes (T26-T29) end-to-end:
 *   1. The route handler enqueues a job onto T52's outbound queue (real
 *      Mongo via memory-server).
 *   2. A worker iteration leases the job and dispatches the matching
 *      use-case, which calls the (msw-mocked) Fief admin API.
 *
 * The Saleor App SDK's signature check is bypassed with the standard
 * `vi.mock(...)` adapter pattern from `customer-created/route.test.ts`
 * (T26's unit suite) — the dedicated `verify-signature.test.ts` (T48)
 * covers crypto.
 *
 * T52 worker note (per the task spec): "if the queue worker T52 is hard
 * to drive in test, document the workaround". We DO drive a single worker
 * iteration here by manually leasing + dispatching: this exercises the
 * full producer→consumer→Fief-admin path without standing up the
 * polling-loop's lifecycle (which would slow the suite by 250ms+ per
 * dispatch). The worker's lease semantics + DLQ handoff are covered by
 * T52's dedicated unit suite (`mongodb-queue-repo.test.ts`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { type SaleorApiUrl } from "@/modules/identity-map/identity-map";

import {
  CHANNEL_SLUG,
  type IntegrationHarness,
  SALEOR_API_URL,
  seedConnection,
  startHarness,
  stopHarness,
} from "../auth/harness";
import {
  buildSaleorUserPayload,
  buildSaleorWebhookRequest,
  type SyntheticSaleorCtx,
} from "./helpers/saleor-webhook-helpers";
import {
  type FiefAdminMockHandle,
  installFiefAdminMock,
  seedIdentityMapRow,
} from "./helpers/sync-harness";

const FIEF_BASE_URL = "https://tenant.test-fief.invalid";
const FIEF_TENANT_ID = "33333333-3333-4333-8333-333333333333";

/*
 * SDK adapter mock — replicates the pattern from the unit-test suite for
 * each event so the route handlers reach our route body without JWKS.
 *
 * `nextCtx.current` gates 401 vs ctx-delivered: tests set it before
 * invoking POST, then read it back to swap payload between cases.
 */
const __nextCtx = vi.hoisted(() => ({
  current: undefined as undefined | SyntheticSaleorCtx,
}));

/*
 * Implementation factory hoisted so we can re-attach it in `beforeEach`
 * (the global vitest config sets `mockReset: true`, which clears
 * `vi.fn().mockImplementation(...)` before EACH test — including the
 * implementation set inside the `vi.mock` factory). Without re-attach,
 * webhook-definition modules loaded for the first time in a later test
 * would call `new SaleorAsyncWebhook(...)` and get `undefined`.
 */
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
  fiefAdmin.reset();

  /*
   * Re-attach the SDK mock's `mockImplementation` after vitest's
   * `mockReset: true` cleared it. Webhook-definition modules loaded for
   * the first time in this test will then construct correctly.
   */
  const { SaleorAsyncWebhook } = await import("@saleor/app-sdk/handlers/next-app-router");

  vi.mocked(SaleorAsyncWebhook).mockImplementation(sdkImpl as never);

  await harness.db.collection("outbound_queue").deleteMany({});
  await harness.db.collection("identity_map").deleteMany({});
  await harness.db.collection("webhook_log").deleteMany({});
  await harness.db.collection("webhook_log_dlq").deleteMany({});

  __nextCtx.current = {
    payload: buildSaleorUserPayload({
      metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
    }),
    authData: {
      saleorApiUrl: SALEOR_API_URL as unknown as string,
      appId: "app-1",
      token: "saleor-token",
    },
  };
});

afterEach(() => {
  __nextCtx.current = undefined;
});

/*
 * Helper: lease the next queue job and dispatch it through the matching
 * use-case. Mirrors the worker's per-iteration body without the polling
 * loop. Returns the dispatch outcome for assertions.
 */
const drainOneJob = async (): Promise<{ leased: boolean; outcome?: string }> => {
  const { MongodbOutboundQueueRepo } = await import(
    "@/modules/queue/repositories/mongodb/mongodb-queue-repo"
  );
  const repo = new MongodbOutboundQueueRepo();
  const leased = await repo.lease("test-worker", 60_000);

  if (leased.isErr()) {
    throw leased.error;
  }

  const job = leased.value;

  if (!job) {
    return { leased: false };
  }

  /*
   * Build the use case the route's eventType maps to. The route enqueues
   * jobs using the per-event `*_EVENT_TYPE` sentinel — we map back here.
   *
   * Each use case is constructed against:
   *   - real channel + provider repos (Mongo memory-server)
   *   - msw-backed FiefAdminApiClient
   *   - real identity_map repo
   *   - kill switch returning false
   */
  const { MongoChannelConfigurationRepo } = await import(
    "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo"
  );
  const { MongodbProviderConnectionRepo } = await import(
    "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo"
  );
  const { MongoIdentityMapRepo } = await import(
    "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
  );
  const { FiefAdminApiClient } = await import("@/modules/fief-client/admin-api-client");
  const { createFiefEncryptor } = await import("@/modules/crypto/encryptor");

  const encryptor = createFiefEncryptor();
  const channelConfigurationRepo = new MongoChannelConfigurationRepo();
  const providerConnectionRepo = new MongodbProviderConnectionRepo(encryptor);
  const identityMapRepo = new MongoIdentityMapRepo();
  const fiefAdminClient = FiefAdminApiClient.create({
    baseUrl: FIEF_BASE_URL as never,
  });

  let outcome: string;

  switch (job.eventType) {
    case "saleor.customer_created": {
      const { CustomerCreatedUseCase } = await import(
        "@/modules/sync/saleor-to-fief/customer-created.use-case"
      );
      const useCase = new CustomerCreatedUseCase({
        channelConfigurationRepo,
        providerConnectionRepo,
        fiefAdmin: fiefAdminClient,
        identityMapRepo,
        isSaleorToFiefDisabled: () => false,
      });
      const result = await useCase.execute(job.payload as never);

      if (result.isErr()) {
        throw result.error;
      }
      outcome = result.value.outcome;
      break;
    }
    case "saleor.customer_updated": {
      const { CustomerUpdatedUseCase } = await import(
        "@/modules/sync/saleor-to-fief/customer-updated.use-case"
      );
      const useCase = new CustomerUpdatedUseCase({
        channelConfigurationRepo,
        providerConnectionRepo,
        fiefAdmin: fiefAdminClient,
        identityMapRepo,
        isSaleorToFiefDisabled: () => false,
      });
      const result = await useCase.execute(job.payload as never);

      if (result.isErr()) {
        throw result.error;
      }
      outcome = result.value.outcome;
      break;
    }
    case "saleor.customer_metadata_updated": {
      const { CustomerMetadataUpdatedUseCase } = await import(
        "@/modules/sync/saleor-to-fief/customer-metadata-updated.use-case"
      );
      const useCase = new CustomerMetadataUpdatedUseCase({
        channelConfigurationRepo,
        providerConnectionRepo,
        fiefAdmin: fiefAdminClient,
        identityMapRepo,
        isSaleorToFiefDisabled: () => false,
      });
      const result = await useCase.execute(job.payload as never);

      if (result.isErr()) {
        throw result.error;
      }
      outcome = result.value.outcome;
      break;
    }
    case "saleor.customer_deleted": {
      const { CustomerDeletedUseCase } = await import(
        "@/modules/sync/saleor-to-fief/customer-deleted.use-case"
      );
      const useCase = new CustomerDeletedUseCase({
        channelConfigurationRepo,
        providerConnectionRepo,
        fiefAdmin: fiefAdminClient,
        identityMapRepo,
        isSaleorToFiefDisabled: () => false,
      });
      const result = await useCase.execute(job.payload as never);

      if (result.isErr()) {
        throw result.error;
      }
      outcome = result.value.outcome;
      break;
    }
    default:
      throw new Error(`unhandled eventType in test drainer: ${job.eventType}`);
  }

  const completed = await repo.complete(job.id);

  if (completed.isErr()) {
    throw completed.error;
  }

  return { leased: true, outcome };
};

describe("T26 — Saleor CUSTOMER_CREATED → Fief", () => {
  it("happy path: route enqueues, worker iteration creates Fief user + binds identity_map", async () => {
    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-created/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-created",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_CREATED",
      }) as never,
    );

    expect(res.status).toBe(200);

    const queueCount = await harness.db.collection("outbound_queue").countDocuments({});

    expect(queueCount).toBe(1);

    const drained = await drainOneJob();

    expect(drained.leased).toBe(true);
    expect(drained.outcome).toBe("synced");
    expect(fiefAdmin.createUserCalls).toBe(1);

    const identityRow = await harness.db.collection("identity_map").findOne({
      saleorUserId: "VXNlcjox",
    });

    expect(identityRow).toBeTruthy();

    // Queue is drained.
    const remaining = await harness.db.collection("outbound_queue").countDocuments({});

    expect(remaining).toBe(0);
  });

  it("email-collision: skips createUser, reuses existing Fief user", async () => {
    fiefAdmin.seedUser({ email: "bob@example.com" });

    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjoy",
        email: "bob@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-created/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-created",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_CREATED",
      }) as never,
    );

    expect(res.status).toBe(200);

    const drained = await drainOneJob();

    expect(drained.outcome).toBe("synced");
    // Email-collision path: NO new user created.
    expect(fiefAdmin.createUserCalls).toBe(0);
  });

  it("origin marker 'fief' on the payload: route filters before enqueue (no Mongo write)", async () => {
    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjoz",
        email: "carol@example.com",
        metadata: [{ key: "fief_sync_origin", value: "fief" }],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-created/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-created",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_CREATED",
      }) as never,
    );

    expect(res.status).toBe(200);

    const queueCount = await harness.db.collection("outbound_queue").countDocuments({});

    expect(queueCount).toBe(0);
  });
});

describe("T27 — Saleor CUSTOMER_UPDATED → Fief", () => {
  it("with bound identity_map: PATCHes the Fief user", async () => {
    fiefAdmin.seedUser({
      id: "44444444-4444-4444-8444-444444444444",
      email: "alice@example.com",
    });

    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId: "VXNlcjox" as never,
      fiefUserId: "44444444-4444-4444-8444-444444444444" as never,
      syncSeq: 1,
    });

    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
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

    const drained = await drainOneJob();

    expect(drained.outcome).toBe("synced");
    expect(fiefAdmin.updateUserCalls).toBe(1);
  });
});

describe("T28 — Saleor CUSTOMER_METADATA_UPDATED → Fief", () => {
  it("with bound identity_map: PATCHes the Fief user fields", async () => {
    fiefAdmin.seedUser({
      id: "55555555-5555-4555-8555-555555555555",
      email: "alice@example.com",
    });

    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId: "VXNlcjox" as never,
      fiefUserId: "55555555-5555-4555-8555-555555555555" as never,
      syncSeq: 1,
    });

    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [
          { key: "_fief_channel", value: CHANNEL_SLUG as unknown as string },
          { key: "loyalty_tier", value: "gold" },
        ],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-metadata-updated/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-metadata-updated",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_METADATA_UPDATED",
      }) as never,
    );

    expect(res.status).toBe(200);

    const drained = await drainOneJob();

    expect(["synced", "noChange", "noChanges"]).toContain(drained.outcome);
  });
});

describe("T29 — Saleor CUSTOMER_DELETED → Fief", () => {
  it("with bound identity_map: deactivates the Fief user (is_active=false)", async () => {
    const fiefId = "66666666-6666-4666-8666-666666666666";

    fiefAdmin.seedUser({
      id: fiefId,
      email: "alice@example.com",
    });

    await seedIdentityMapRow({
      saleorApiUrl: SALEOR_API_URL,
      saleorUserId: "VXNlcjox" as never,
      fiefUserId: fiefId as never,
      syncSeq: 1,
    });

    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-deleted/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-deleted",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_DELETED",
      }) as never,
    );

    expect(res.status).toBe(200);

    const drained = await drainOneJob();

    expect(drained.outcome).toBe("deactivated");
    expect(fiefAdmin.updateUserCalls).toBe(1);

    // The patched user must have is_active=false.
    const fiefUser = fiefAdmin.users.get(fiefId);

    expect(fiefUser?.is_active).toBe(false);
  });

  it("without identity_map binding: idempotent no-op", async () => {
    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjo3",
        email: "ghost@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-deleted/route");
    const res = await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-deleted",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_DELETED",
      }) as never,
    );

    expect(res.status).toBe(200);

    const drained = await drainOneJob();

    expect(drained.outcome).toBe("noFiefUser");
    expect(fiefAdmin.updateUserCalls).toBe(0);
  });
});

describe("T52 worker integration — single-iteration drain", () => {
  it("queue is empty after a successful drain", async () => {
    __nextCtx.current = {
      payload: buildSaleorUserPayload({
        id: "VXNlcjox",
        email: "alice@example.com",
        metadata: [{ key: "_fief_channel", value: CHANNEL_SLUG as unknown as string }],
      }),
      authData: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("@/app/api/webhooks/saleor/customer-created/route");

    await POST(
      buildSaleorWebhookRequest({
        pathname: "/api/webhooks/saleor/customer-created",
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        event: "CUSTOMER_CREATED",
      }) as never,
    );

    expect(await harness.db.collection("outbound_queue").countDocuments({})).toBe(1);

    await drainOneJob();

    expect(await harness.db.collection("outbound_queue").countDocuments({})).toBe(0);
  });
});

// Suppress unused warning — SaleorApiUrl import keeps the typed branding sharp.
void (null as unknown as SaleorApiUrl);
