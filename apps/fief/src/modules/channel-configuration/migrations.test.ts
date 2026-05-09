import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * T9 — Verify the channel-configuration migration is registered with T53's
 * runner and produces the expected indexes when applied.
 *
 * The repo intentionally does NOT create indexes lazily on first access (the
 * APL pattern used in T3) — by the time storage repos exist, T53 is the only
 * place schema lives. So this test exercises the version="003" migration
 * directly by importing the side-effect module and running the runner.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_channel_config_migrations_test");
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
  const db = client.db("fief_channel_config_migrations_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

describe("channel-configuration — migrations", () => {
  it("registers a migration with version=003 and the expected name", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();

    // Importing the module triggers `registerMigration(...)` as a side-effect.
    await import("./migrations");

    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());

    const versions = await db.collection("_schema_versions").find({}).toArray();

    expect(versions.map((v) => v.name)).toStrictEqual(["003:channel-configuration-indexes"]);
  });

  it("creates a unique index on { saleorApiUrl: 1 } for channel_configuration", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    await import("./migrations");
    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());

    const indexes = await db.collection("channel_configuration").indexes();

    const saleorApiUrlIndex = indexes.find(
      (i) => i.key && (i.key as Record<string, unknown>).saleorApiUrl === 1,
    );

    expect(saleorApiUrlIndex).toBeDefined();
    expect(saleorApiUrlIndex?.unique).toBe(true);
  });
});
