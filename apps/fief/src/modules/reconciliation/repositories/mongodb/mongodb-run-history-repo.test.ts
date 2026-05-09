import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderConnectionId,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * T32 — Behavioural test suite for the Mongo-backed reconciliation
 * run-history repo.
 *
 * The high-value invariant is the concurrent-run guard: two parallel
 * `claim(...)` calls for the same `(saleorApiUrl, connectionId)` MUST yield
 * exactly one `claimed: true` and one `claimed: false`. We exercise the real
 * Mongo unique partial index by booting `mongodb-memory-server` and running
 * the migration before the test.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_recon_run_history_test");
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_recon_run_history_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://shop-1.saleor.cloud/graphql/",
)._unsafeUnwrap();
const CONNECTION_ID: ProviderConnectionId = createProviderConnectionId(
  "11111111-1111-4111-8111-111111111111",
);

describe("MongodbReconciliationRunHistoryRepo — claim", () => {
  it("first claim wins; subsequent claim observes claimed=false until completion", async () => {
    const { MongodbReconciliationRunHistoryRepo } = await import("./mongodb-run-history-repo");
    const { registerReconciliationRunsMigration } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerReconciliationRunsMigration();
    await runMigrations();

    const repo = new MongodbReconciliationRunHistoryRepo();
    const startedAt = new Date("2026-05-09T00:00:00Z");

    const first = await repo.claim({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
      startedAt,
    });

    expect(first._unsafeUnwrap().claimed).toBe(true);

    const second = await repo.claim({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
      startedAt: new Date("2026-05-09T00:01:00Z"),
    });

    expect(second._unsafeUnwrap().claimed).toBe(false);

    /* Complete the first claim, then re-claiming should succeed. */
    await repo.complete({
      id: first._unsafeUnwrap().row.id,
      status: "ok",
      completedAt: new Date("2026-05-09T00:02:00Z"),
      summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const third = await repo.claim({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
      startedAt: new Date("2026-05-09T00:03:00Z"),
    });

    expect(third._unsafeUnwrap().claimed).toBe(true);
  });

  it("listRecent returns rows for an install ordered by startedAt desc", async () => {
    const { MongodbReconciliationRunHistoryRepo } = await import("./mongodb-run-history-repo");
    const { registerReconciliationRunsMigration } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerReconciliationRunsMigration();
    await runMigrations();

    const repo = new MongodbReconciliationRunHistoryRepo();

    /* Two completed runs at distinct times. */
    const first = await repo.claim({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
      startedAt: new Date("2026-05-09T00:00:00Z"),
    });

    await repo.complete({
      id: first._unsafeUnwrap().row.id,
      status: "ok",
      completedAt: new Date("2026-05-09T00:00:30Z"),
      summary: { total: 5, repaired: 5, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const second = await repo.claim({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
      startedAt: new Date("2026-05-09T01:00:00Z"),
    });

    await repo.complete({
      id: second._unsafeUnwrap().row.id,
      status: "failed",
      completedAt: new Date("2026-05-09T01:00:30Z"),
      summary: { total: 1, repaired: 0, skipped: 0, failed: 1 },
      perRowErrors: [],
      runError: "boom",
    });

    const list = await repo.listRecent({ saleorApiUrl: SALEOR_API_URL, limit: 50 });
    const rows = list._unsafeUnwrap();

    expect(rows).toHaveLength(2);
    expect(rows[0].startedAt.getTime()).toBeGreaterThan(rows[1].startedAt.getTime());
    expect(rows[0].status).toBe("failed");
  });
});
