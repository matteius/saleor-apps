/*
 * @vitest-environment node
 *
 * Wire-up follow-up — `composition-root.findConnectionById` soft-delete
 * filter behavioural test (booted against `mongodb-memory-server`).
 *
 * Documents the bug the original implementation introduced: T8's
 * `MongodbProviderConnectionRepo.create` persists `softDeletedAt: null` for
 * non-deleted rows, but the original lookup filtered with
 * `{ softDeletedAt: { $exists: false } }`. The `$exists: false` predicate
 * NEVER matched a freshly-created connection because the field is present
 * (just null). The fix matches `{ softDeletedAt: null }` directly, which
 * Mongo's BSON null-equality treats as "field is null OR missing" — so both
 * the modern T8 shape AND any legacy pre-T8 docs round-trip.
 *
 * Two cases:
 *   1. Non-soft-deleted connection — `findConnectionById` returns it.
 *      (Was previously NotFound in production due to the `$exists: false`
 *      filter mismatch.)
 *   2. Soft-deleted connection — `findConnectionById` returns NotFound.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RotatingFiefEncryptor } from "@/modules/crypto/encryptor";
import {
  type AllowedOrigin,
  createAllowedOrigin,
  createFiefBaseUrl,
  createFiefClientId,
  createFiefTenantId,
  createProviderConnectionName,
  type ProviderConnectionCreateInput,
} from "@/modules/provider-connections/provider-connection";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

let mongoServer: MongoMemoryServer;

// 64-hex-char string = 32 bytes; AES-256-CBC requires a 32-byte key.
const TEST_SECRET_KEY = "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_composition_root_test");
  vi.stubEnv("SECRET_KEY", TEST_SECRET_KEY);
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

const SALEOR_API_URL = "https://shop-cr.saleor.cloud/graphql/" as SaleorApiUrl;

const buildEncryptor = () => new RotatingFiefEncryptor({ secretKey: TEST_SECRET_KEY });

const buildCreateInput = (): ProviderConnectionCreateInput => ({
  saleorApiUrl: SALEOR_API_URL as ProviderConnectionCreateInput["saleorApiUrl"],
  name: createProviderConnectionName("Composition root tenant"),
  fief: {
    baseUrl: createFiefBaseUrl("https://tenant.fief.dev"),
    tenantId: createFiefTenantId("tenant-uuid-cr"),
    clientId: createFiefClientId("client-uuid-cr"),
    webhookId: null,
    clientSecret: "plaintext-client-secret-cr",
    pendingClientSecret: null,
    adminToken: "plaintext-admin-token-cr",
    webhookSecret: "plaintext-webhook-secret-cr",
    pendingWebhookSecret: null,
  },
  branding: {
    signingKey: "plaintext-signing-key-cr",
    allowedOrigins: [createAllowedOrigin("https://storefront.example.com")] as AllowedOrigin[],
  },
  claimMapping: [],
});

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_composition_root_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

afterEach(async () => {
  const { closeMongoClient } = await import("@/modules/db/mongo-client");

  await closeMongoClient();
});

describe("composition-root.findConnectionById — soft-delete filter wire-up", () => {
  it("returns the connection when softDeletedAt is null (the persisted shape T8 writes)", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import(
      "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo"
    );
    const { findConnectionById } = await import("./composition-root");

    resetMigrationRegistryForTests();
    await import("@/modules/provider-connections/migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const created = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();

    /*
     * Sanity: the persisted shape carries `softDeletedAt: null` (NOT a
     * missing field). This is the property the original `$exists: false`
     * filter mis-handled.
     */
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
    const client = await getMongoClient();
    const rawDoc = await client
      .db(getMongoDatabaseName())
      .collection("provider_connections")
      .findOne({ id: created.id });

    expect(rawDoc).not.toBeNull();
    expect(rawDoc).toHaveProperty("softDeletedAt", null);

    const result = await findConnectionById(created.id);

    expect(result.isOk()).toBe(true);
    const found = result._unsafeUnwrap();

    expect(found.id).toBe(created.id);
    expect(found.saleorApiUrl).toBe(SALEOR_API_URL);
  });

  it("returns NotFound when the connection has been soft-deleted (softDeletedAt is a Date)", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import(
      "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo"
    );
    const { ProviderConnectionRepoError } = await import(
      "@/modules/provider-connections/provider-connection-repo"
    );
    const { findConnectionById } = await import("./composition-root");

    resetMigrationRegistryForTests();
    await import("@/modules/provider-connections/migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const created = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();
    const deleted = await repo.softDelete({ saleorApiUrl: SALEOR_API_URL, id: created.id });

    expect(deleted.isOk()).toBe(true);

    const result = await findConnectionById(created.id);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ProviderConnectionRepoError.NotFound);
  });
});
