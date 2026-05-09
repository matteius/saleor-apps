import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * T53 — Mongo schema migration runner behavioural test suite.
 *
 * Boots an in-process MongoDB via `mongodb-memory-server`, points the env
 * layer at it, and verifies:
 *
 *   - First boot creates indexes + records to `_schema_versions`.
 *   - Second boot is a no-op (no duplicate-index errors).
 *   - Concurrent boot (two runners simultaneously) does not throw — the
 *     distributed lock prevents double-apply.
 *   - A migration registered after first boot runs on next boot.
 *   - `createIndex` helper is idempotent for identical specs.
 *   - `createIndex` with a *conflicting* spec is logged + skipped (no throw).
 *
 * The runner exposes a registry-based API so storage repos (T8/T9/T10/T11)
 * can register their indexes via `registerMigration({ version, name, run })`
 * rather than running side-effects on module load.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_migrations_test");
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

/*
 * Each test gets a fresh module graph so the migration registry resets and
 * the `mongo-client` singleton can be re-spied. Between tests we drop the
 * test database so collections / indexes / `_schema_versions` start clean.
 */
beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("./mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_migrations_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

describe("migration-runner — first boot", () => {
  it("applies registered migrations and records them in _schema_versions", async () => {
    const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
      "./migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    resetMigrationRegistryForTests();

    registerMigration({
      version: "001",
      name: "create-foo-indexes",
      async run(db) {
        await db.collection("foo").createIndex({ saleorApiUrl: 1 });
      },
    });

    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());

    const indexes = await db.collection("foo").indexes();
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("saleorApiUrl_1");

    const versions = await db.collection("_schema_versions").find({}).toArray();

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ name: "001:create-foo-indexes" });
    expect(versions[0]?.appliedAt).toBeInstanceOf(Date);
  });
});

describe("migration-runner — idempotency", () => {
  it("a second boot is a no-op (does not re-run already-applied migrations)", async () => {
    const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
      "./migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    resetMigrationRegistryForTests();

    const runFn = vi.fn(async (db) => {
      await db.collection("bar").createIndex({ saleorApiUrl: 1 });
    });

    registerMigration({
      version: "001",
      name: "create-bar-indexes",
      run: runFn,
    });

    await runMigrations();
    expect(runFn).toHaveBeenCalledTimes(1);

    // Boot again — registry is the same (intentionally NOT reset).
    await runMigrations();
    expect(runFn).toHaveBeenCalledTimes(1);

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const versions = await db.collection("_schema_versions").find({}).toArray();

    expect(versions).toHaveLength(1);
  });

  it("does not throw on duplicate createIndex when the runner is invoked twice", async () => {
    const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
      "./migration-runner"
    );
    const { createIndex } = await import("./create-index");
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    resetMigrationRegistryForTests();

    registerMigration({
      version: "001",
      name: "via-helper",
      async run(db) {
        await createIndex(db.collection("baz"), { saleorApiUrl: 1 }, { unique: true });
      },
    });

    await runMigrations();

    /*
     * Force a second apply by clearing _schema_versions — simulates a manual
     * reset / disaster recovery path. The createIndex helper must handle it.
     */
    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());

    await db.collection("_schema_versions").deleteMany({});

    await expect(runMigrations()).resolves.not.toThrow();
  });
});

describe("migration-runner — concurrent boot", () => {
  it("two parallel runMigrations calls do not throw and only apply each migration once", async () => {
    const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
      "./migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    resetMigrationRegistryForTests();

    const runFn = vi.fn(async (db) => {
      // Simulate work; lock contention happens during this window.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await db.collection("qux").createIndex({ saleorApiUrl: 1 });
    });

    registerMigration({
      version: "001",
      name: "concurrent-test",
      run: runFn,
    });

    // Two simultaneous boots — only one should win the lock and apply.
    const [a, b] = await Promise.allSettled([runMigrations(), runMigrations()]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(runFn).toHaveBeenCalledTimes(1);

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const versions = await db.collection("_schema_versions").find({}).toArray();

    expect(versions).toHaveLength(1);
  });
});

describe("migration-runner — late registration", () => {
  it("a migration registered after first boot is applied on next boot", async () => {
    const { registerMigration, runMigrations, resetMigrationRegistryForTests } = await import(
      "./migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    resetMigrationRegistryForTests();

    registerMigration({
      version: "001",
      name: "first",
      async run(db) {
        await db.collection("first").createIndex({ a: 1 });
      },
    });

    await runMigrations();

    const lateRunFn = vi.fn(async (db) => {
      await db.collection("second").createIndex({ b: 1 });
    });

    registerMigration({
      version: "002",
      name: "second",
      run: lateRunFn,
    });

    await runMigrations();

    expect(lateRunFn).toHaveBeenCalledTimes(1);

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const versions = await db.collection("_schema_versions").find({}).sort({ name: 1 }).toArray();

    expect(versions.map((v) => v.name)).toStrictEqual(["001:first", "002:second"]);
  });
});

describe("createIndex — idempotency", () => {
  it("is a no-op when the same index spec already exists", async () => {
    const { createIndex } = await import("./create-index");
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const collection = db.collection("idempotent_idx");

    const first = await createIndex(collection, { saleorApiUrl: 1 }, { unique: true });
    const second = await createIndex(collection, { saleorApiUrl: 1 }, { unique: true });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.skipped).toBeUndefined();
  });

  it("logs and skips (does not throw) when an index with the same key but different options already exists", async () => {
    const { createIndex } = await import("./create-index");
    const { getMongoClient, getMongoDatabaseName } = await import("./mongo-client");

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const collection = db.collection("conflicting_idx");

    // Pre-create a non-unique index on the same key.
    await collection.createIndex({ saleorApiUrl: 1 });

    const result = await createIndex(collection, { saleorApiUrl: 1 }, { unique: true });

    expect(result.created).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/conflict/i);
  });
});
