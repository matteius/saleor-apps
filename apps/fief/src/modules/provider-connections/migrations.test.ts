import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * T8 — verifies the provider-connections migration registers itself with the
 * T53 runner when imported, and that running the registry actually creates
 * the expected indexes on the `provider_connections` collection.
 *
 * We exercise via real `mongodb-memory-server` so we're testing the integrated
 * path the production boot will follow (instrumentation → registry import →
 * runMigrations).
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_provider_conn_migration_test");
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
  const db = client.db("fief_provider_conn_migration_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

describe("provider-connections migrations", () => {
  it("registers migration `002` and creates the expected indexes on boot", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    // Importing the migrations module registers via T53's `registerMigration`.
    await import("./migrations");

    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());

    const indexes = await db.collection("provider_connections").indexes();
    const indexShapes = indexes.map((i) => ({ key: i.key, unique: !!i.unique }));

    expect(indexShapes).toContainEqual({ key: { saleorApiUrl: 1 }, unique: false });
    expect(indexShapes).toContainEqual({ key: { saleorApiUrl: 1, id: 1 }, unique: true });

    // Recorded in the version log under the agreed-on `002` slot.
    const versions = await db.collection("_schema_versions").find({}).toArray();
    const names = versions.map((v) => v.name);

    expect(names).toContain("002:provider-connections-indexes");
  });
});
