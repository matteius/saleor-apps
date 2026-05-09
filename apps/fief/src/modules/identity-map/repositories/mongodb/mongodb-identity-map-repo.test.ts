import { MongoServerError } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import type { IdentityMapRepo } from "../../identity-map-repo";

/*
 * T10 — `identity_map` Mongo repository behavioural tests.
 *
 * The identity map is the synchronization point for the Saleor↔Fief auth-plane
 * race documented in T19/T23 of the plan. The contract this suite locks down:
 *
 *   - Bidirectional lookup: `getBySaleorUser` and `getByFiefUser` round-trip
 *     after a single `upsert`.
 *   - Both unique indexes are enforced — duplicate insert on EITHER direction
 *     surfaces a Mongo `E11000` (proves the migration created both indexes).
 *   - **Race-safe upsert**: two parallel `upsert` calls with the same
 *     `(saleorApiUrl, fiefUserId)` and DIFFERENT `saleorUserId` values must
 *     produce exactly one winner (`wasInserted: true`); the loser sees the
 *     winner's row back with `wasInserted: false`. T19's first-login flow
 *     keys off this flag to decide whether to create the Saleor customer.
 *   - **Monotonic seq**: an upsert with a `syncSeq` <= the existing row's
 *     `lastSyncSeq` MUST NOT regress the row. Returns the existing row with
 *     `wasInserted: false` and the original (higher) `lastSyncSeq` intact.
 *   - The migration registers with `version: "004"` (T8 owns "002", T9 "003",
 *     T11 "005").
 *
 * The race test is repeated 25 times in CI to flush out scheduling-dependent
 * non-determinism. The deterministic guarantee comes from `findOneAndUpdate`
 * with `upsert: true` against a unique compound index — Mongo serializes
 * concurrent upserts and the loser sees the winner's row via
 * `returnDocument: "after"`.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_identity_map_test");
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
  const db = client.db("fief_identity_map_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

const SALEOR_API_URL = "https://shop-1.saleor.cloud/graphql/";
const SALEOR_API_URL_2 = "https://shop-2.saleor.cloud/graphql/";

interface SetupResult {
  repo: IdentityMapRepo;
  saleorApiUrl: SaleorApiUrl;
}

async function setupRepo(saleorApiUrl: string = SALEOR_API_URL): Promise<SetupResult> {
  const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
    "@/modules/db/migration-runner"
  );

  resetMigrationRegistryForTests();

  // Register the T10 migration so the indexes exist before the repo is exercised.
  const { identityMapIndexMigration } = await import("../../migrations");

  registerMigration(identityMapIndexMigration);

  await runMigrations();

  const { MongoIdentityMapRepo } = await import("./mongodb-identity-map-repo");
  const { createSaleorApiUrl } = await import("@/modules/saleor/saleor-api-url");

  const apiUrlResult = createSaleorApiUrl(saleorApiUrl);

  if (apiUrlResult.isErr()) {
    throw apiUrlResult.error;
  }

  return {
    repo: new MongoIdentityMapRepo(),
    saleorApiUrl: apiUrlResult.value,
  };
}

describe("MongoIdentityMapRepo — bidirectional lookup", () => {
  it("round-trips upsert → getBySaleorUser and getByFiefUser", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjox")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("11111111-1111-4111-8111-111111111111");
    const syncSeq = createSyncSeq(1)._unsafeUnwrap();

    const upsertResult = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq,
    });

    expect(upsertResult.isOk()).toBe(true);
    const { row, wasInserted } = upsertResult._unsafeUnwrap();

    expect(wasInserted).toBe(true);
    expect(row.saleorUserId).toBe(saleorUserId);
    expect(row.fiefUserId).toBe(fiefUserId);
    expect(row.lastSyncSeq).toBe(1);
    expect(row.lastSyncedAt).toBeInstanceOf(Date);

    const bySaleor = await repo.getBySaleorUser({ saleorApiUrl, saleorUserId });

    expect(bySaleor.isOk()).toBe(true);
    expect(bySaleor._unsafeUnwrap()?.fiefUserId).toBe(fiefUserId);

    const byFief = await repo.getByFiefUser({ saleorApiUrl, fiefUserId });

    expect(byFief.isOk()).toBe(true);
    expect(byFief._unsafeUnwrap()?.saleorUserId).toBe(saleorUserId);
  });

  it("returns null on lookup miss (does not error)", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const missingSaleor = await repo.getBySaleorUser({
      saleorApiUrl,
      saleorUserId: createSaleorUserId("missing")._unsafeUnwrap(),
    });

    expect(missingSaleor.isOk()).toBe(true);
    expect(missingSaleor._unsafeUnwrap()).toBeNull();

    const missingFief = await repo.getByFiefUser({
      saleorApiUrl,
      fiefUserId: FiefUserIdSchema.parse("22222222-2222-4222-8222-222222222222"),
    });

    expect(missingFief.isOk()).toBe(true);
    expect(missingFief._unsafeUnwrap()).toBeNull();
  });

  it("scopes by saleorApiUrl — same fiefUserId in different tenants is independent", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");
    const { createSaleorApiUrl } = await import("@/modules/saleor/saleor-api-url");

    const saleorApiUrl2 = createSaleorApiUrl(SALEOR_API_URL_2)._unsafeUnwrap();

    const fiefUserId = FiefUserIdSchema.parse("33333333-3333-4333-8333-333333333333");

    const a = await repo.upsert({
      saleorApiUrl,
      saleorUserId: createSaleorUserId("user-a")._unsafeUnwrap(),
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    const b = await repo.upsert({
      saleorApiUrl: saleorApiUrl2,
      saleorUserId: createSaleorUserId("user-b")._unsafeUnwrap(),
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    expect(a._unsafeUnwrap().wasInserted).toBe(true);
    expect(b._unsafeUnwrap().wasInserted).toBe(true);
    expect(a._unsafeUnwrap().row.saleorUserId).toBe("user-a");
    expect(b._unsafeUnwrap().row.saleorUserId).toBe("user-b");
  });
});

describe("MongoIdentityMapRepo — unique-constraint enforcement (proves both indexes exist)", () => {
  it("enforces uniqueness on { saleorApiUrl, saleorUserId } at the driver level", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjox")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("44444444-4444-4444-8444-444444444444");

    const upsert = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    expect(upsert.isOk()).toBe(true);

    /*
     * Bypass the repo and try to insert a second doc with the SAME saleor user id but
     * a different fief user id — must fail at the index level.
     */
    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const collection = db.collection("identity_map");

    let caught: unknown = null;

    try {
      await collection.insertOne({
        saleorApiUrl,
        saleorUserId,
        fiefUserId: "55555555-5555-4555-8555-555555555555",
        lastSyncSeq: 1,
        lastSyncedAt: new Date(),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MongoServerError);
    expect((caught as MongoServerError).code).toBe(11000);
  });

  it("enforces uniqueness on { saleorApiUrl, fiefUserId } at the driver level", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjoy")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("66666666-6666-4666-8666-666666666666");

    const upsert = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    expect(upsert.isOk()).toBe(true);

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const collection = db.collection("identity_map");

    let caught: unknown = null;

    try {
      await collection.insertOne({
        saleorApiUrl,
        saleorUserId: "VXNlcjozzz",
        fiefUserId,
        lastSyncSeq: 1,
        lastSyncedAt: new Date(),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MongoServerError);
    expect((caught as MongoServerError).code).toBe(11000);
  });
});

describe("MongoIdentityMapRepo — race-safe upsert (T19 synchronization point)", () => {
  /*
   * The "two-device first-login race" from T19: two AUTH_ISSUE_ACCESS_TOKENS
   * handlers fire concurrently for the same Fief user. Each independently
   * generates a candidate Saleor customer id, then attempts to bind it.
   *
   * The contract: exactly one wins. The loser sees the winner's row and reuses
   * the bound saleor user id (no duplicate customer is created).
   *
   * This test is the canary — without `findOneAndUpdate(... upsert: true ...)`
   * against the unique index, the second concurrent upsert would either
   * (a) silently overwrite (race) or (b) throw E11000 unhandled.
   */
  it("exactly one wins on concurrent upsert — 100 iterations, deterministic", async () => {
    /*
     * 100 iterations per the task brief — flush out scheduling-dependent
     * non-determinism. Each iteration uses a unique fiefUserId so iterations
     * don't interfere; the race is between the two `Promise.all`-launched
     * upserts within a single iteration. Consolidated into one `it` so we
     * pay the migration / setup cost once.
     */
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    for (let iteration = 0; iteration < 100; iteration++) {
      const fiefUserId = FiefUserIdSchema.parse(
        `77777777-7777-4777-8777-77777777${iteration.toString().padStart(4, "0")}`,
      );

      const candidateA = createSaleorUserId(`device-a-${iteration}`)._unsafeUnwrap();
      const candidateB = createSaleorUserId(`device-b-${iteration}`)._unsafeUnwrap();

      const [resultA, resultB] = await Promise.all([
        repo.upsert({
          saleorApiUrl,
          saleorUserId: candidateA,
          fiefUserId,
          syncSeq: createSyncSeq(1)._unsafeUnwrap(),
        }),
        repo.upsert({
          saleorApiUrl,
          saleorUserId: candidateB,
          fiefUserId,
          syncSeq: createSyncSeq(1)._unsafeUnwrap(),
        }),
      ]);

      expect(resultA.isOk(), `iter ${iteration}: resultA must be Ok`).toBe(true);
      expect(resultB.isOk(), `iter ${iteration}: resultB must be Ok`).toBe(true);

      const a = resultA._unsafeUnwrap();
      const b = resultB._unsafeUnwrap();

      // Exactly one winner.
      const wins = [a.wasInserted, b.wasInserted].filter(Boolean).length;

      expect(wins, `iter ${iteration}: exactly one wasInserted=true`).toBe(1);

      // Both observers must see the SAME row (the winner's saleorUserId).
      expect(a.row.saleorUserId, `iter ${iteration}: both see same saleorUserId`).toBe(
        b.row.saleorUserId,
      );
      expect(a.row.fiefUserId).toBe(fiefUserId);

      // The winning saleorUserId must be one of the two candidates.
      expect([candidateA, candidateB]).toContain(a.row.saleorUserId);

      // Verify the underlying collection has exactly one row for this fiefUserId.
      const client = await getMongoClient();
      const db = client.db(getMongoDatabaseName());
      const docs = await db.collection("identity_map").find({ saleorApiUrl, fiefUserId }).toArray();

      expect(docs, `iter ${iteration}: exactly one persisted row`).toHaveLength(1);
    }
  }, 60_000);

  it("a second sequential upsert with same identifiers reports wasInserted: false", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjp4")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("88888888-8888-4888-8888-888888888888");

    const first = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    const second = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(2)._unsafeUnwrap(),
    });

    expect(first._unsafeUnwrap().wasInserted).toBe(true);
    expect(second._unsafeUnwrap().wasInserted).toBe(false);
    // Sequence advanced because the new seq is higher.
    expect(second._unsafeUnwrap().row.lastSyncSeq).toBe(2);
  });
});

describe("MongoIdentityMapRepo — monotonic lastSyncSeq", () => {
  it("does NOT regress lastSyncSeq when an upsert arrives with an older syncSeq", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjp5")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("99999999-9999-4999-8999-999999999999");

    // Establish a row at seq=10.
    const first = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(10)._unsafeUnwrap(),
    });

    expect(first._unsafeUnwrap().wasInserted).toBe(true);
    expect(first._unsafeUnwrap().row.lastSyncSeq).toBe(10);

    // Out-of-order webhook arrives with seq=5 (lower).
    const stale = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(5)._unsafeUnwrap(),
    });

    expect(stale.isOk()).toBe(true);
    expect(stale._unsafeUnwrap().wasInserted).toBe(false);
    // Row must still report seq=10 — NOT regressed to 5.
    expect(stale._unsafeUnwrap().row.lastSyncSeq).toBe(10);

    // The persisted doc must also still be at 10 (verify directly).
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const persisted = await db.collection("identity_map").findOne({ saleorApiUrl, saleorUserId });

    expect(persisted?.lastSyncSeq).toBe(10);
  });

  it("equal syncSeq is treated as a no-op (does NOT bump lastSyncedAt)", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjp6")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const first = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(7)._unsafeUnwrap(),
    });

    const initialSyncedAt = first._unsafeUnwrap().row.lastSyncedAt;

    // Pause briefly so a hypothetical bump would produce a measurably different timestamp.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const equal = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(7)._unsafeUnwrap(),
    });

    expect(equal._unsafeUnwrap().wasInserted).toBe(false);
    expect(equal._unsafeUnwrap().row.lastSyncSeq).toBe(7);
    expect(equal._unsafeUnwrap().row.lastSyncedAt.getTime()).toBe(initialSyncedAt.getTime());
  });

  it("higher syncSeq advances lastSyncSeq and bumps lastSyncedAt", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjp7")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const first = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    const initialSyncedAt = first._unsafeUnwrap().row.lastSyncedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const advanced = await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(99)._unsafeUnwrap(),
    });

    expect(advanced._unsafeUnwrap().wasInserted).toBe(false);
    expect(advanced._unsafeUnwrap().row.lastSyncSeq).toBe(99);
    expect(advanced._unsafeUnwrap().row.lastSyncedAt.getTime()).toBeGreaterThan(
      initialSyncedAt.getTime(),
    );
  });
});

describe("MongoIdentityMapRepo — delete", () => {
  it("delete removes a row and subsequent lookups return null", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId, createSyncSeq } = await import("../../identity-map");
    const { FiefUserIdSchema } = await import("@/modules/fief-client/admin-api-types");

    const saleorUserId = createSaleorUserId("VXNlcjpkZWw=")._unsafeUnwrap();
    const fiefUserId = FiefUserIdSchema.parse("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    await repo.upsert({
      saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: createSyncSeq(1)._unsafeUnwrap(),
    });

    const del = await repo.delete({ saleorApiUrl, saleorUserId });

    expect(del.isOk()).toBe(true);

    const after = await repo.getBySaleorUser({ saleorApiUrl, saleorUserId });

    expect(after.isOk()).toBe(true);
    expect(after._unsafeUnwrap()).toBeNull();

    const afterByFief = await repo.getByFiefUser({ saleorApiUrl, fiefUserId });

    expect(afterByFief._unsafeUnwrap()).toBeNull();
  });

  it("delete is idempotent — deleting a non-existent row is not an error", async () => {
    const { repo, saleorApiUrl } = await setupRepo();
    const { createSaleorUserId } = await import("../../identity-map");

    const result = await repo.delete({
      saleorApiUrl,
      saleorUserId: createSaleorUserId("never-existed")._unsafeUnwrap(),
    });

    expect(result.isOk()).toBe(true);
  });
});

describe("identity-map migration registration", () => {
  it("registers with version '004'", async () => {
    const { identityMapIndexMigration } = await import("../../migrations");

    expect(identityMapIndexMigration.version).toBe("004");
    expect(identityMapIndexMigration.name).toBe("identity-map-indexes");
  });

  it("creates both unique compound indexes", async () => {
    const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { identityMapIndexMigration } = await import("../../migrations");

    resetMigrationRegistryForTests();
    registerMigration(identityMapIndexMigration);

    await runMigrations();

    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const indexes = await db.collection("identity_map").indexes();

    const saleorIdx = indexes.find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ saleorApiUrl: 1, saleorUserId: 1 }),
    );
    const fiefIdx = indexes.find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ saleorApiUrl: 1, fiefUserId: 1 }),
    );

    expect(saleorIdx?.unique).toBe(true);
    expect(fiefIdx?.unique).toBe(true);
  });
});
