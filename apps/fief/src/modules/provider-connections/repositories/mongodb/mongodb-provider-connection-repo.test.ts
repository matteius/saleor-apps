import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RotatingFiefEncryptor } from "@/modules/crypto/encryptor";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type AllowedOrigin,
  createAllowedOrigin,
  createFiefBaseUrl,
  createFiefClientId,
  createFiefTenantId,
  createProviderConnectionId,
  createProviderConnectionName,
  type ProviderConnectionCreateInput,
} from "../../provider-connection";

/*
 * T8 — `MongodbProviderConnectionRepo` behavioural test suite.
 *
 * Covers:
 *   - CRUD round-trip (create / get / list / update / softDelete / restore).
 *   - Encrypted-at-rest verification: the raw Mongo doc must contain
 *     ciphertext, not plaintext, for every secret slot.
 *   - List-by-saleorApiUrl returns multiple connections (multi-config).
 *   - Uniqueness on `{ saleorApiUrl, id }` enforced by the registered index.
 *   - Pending-secret slot serializes correctly (active + pending coexist).
 *   - Soft-deleted entries are excluded from `list` by default; included via
 *     `includeSoftDeleted: true`.
 *   - The migration-runner registry contains the connection-collection
 *     migration after importing `./migrations` (T8 wires into T53).
 */

let mongoServer: MongoMemoryServer;

// 64-hex-char string = 32 bytes; AES-256-CBC requires a 32-byte key.
const TEST_SECRET_KEY = "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_provider_conn_test");
  vi.stubEnv("SECRET_KEY", TEST_SECRET_KEY);
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

const SALEOR_API_URL = "https://shop-1.saleor.cloud/graphql/" as SaleorApiUrl;
const SALEOR_API_URL_OTHER = "https://shop-2.saleor.cloud/graphql/" as SaleorApiUrl;

const buildEncryptor = () => new RotatingFiefEncryptor({ secretKey: TEST_SECRET_KEY });

const buildCreateInput = (
  override: Partial<ProviderConnectionCreateInput> = {},
): ProviderConnectionCreateInput => ({
  saleorApiUrl: SALEOR_API_URL as ProviderConnectionCreateInput["saleorApiUrl"],
  name: createProviderConnectionName("Default tenant"),
  fief: {
    baseUrl: createFiefBaseUrl("https://tenant.fief.dev"),
    tenantId: createFiefTenantId("tenant-uuid-1"),
    clientId: createFiefClientId("client-uuid-1"),
    webhookId: null,
    clientSecret: "plaintext-client-secret-aaaa",
    pendingClientSecret: null,
    adminToken: "plaintext-admin-token-bbbb",
    webhookSecret: "plaintext-webhook-secret-cccc",
    pendingWebhookSecret: null,
    ...override.fief,
  },
  branding: {
    signingKey: "plaintext-signing-key-dddd",
    allowedOrigins: [createAllowedOrigin("https://storefront.example.com")] as AllowedOrigin[],
    ...override.branding,
  },
  claimMapping: [
    {
      fiefClaim: "email",
      saleorMetadataKey: "fief.email",
      required: true,
      visibility: "private",
      reverseSyncEnabled: false,
    },
    {
      fiefClaim: "tenant_id",
      saleorMetadataKey: "fief.tenant_id",
      required: false,
      visibility: "private",
      reverseSyncEnabled: false,
    },
  ],
  ...("name" in override ? { name: override.name! } : {}),
  ...("saleorApiUrl" in override
    ? {
        saleorApiUrl: override.saleorApiUrl! as ProviderConnectionCreateInput["saleorApiUrl"],
      }
    : {}),
  ...("claimMapping" in override ? { claimMapping: override.claimMapping! } : {}),
});

/*
 * Each test gets a fresh module graph + fresh DB so the migration registry
 * resets and the singletons inside `mongo-client` / migration-runner don't
 * leak across tests.
 */
beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_provider_conn_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

describe("MongodbProviderConnectionRepo — CRUD round-trip", () => {
  it("create() persists a connection and returns the branded entity", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const result = await repo.create(SALEOR_API_URL, buildCreateInput());

    expect(result.isOk()).toBe(true);
    const created = result._unsafeUnwrap();

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(created.saleorApiUrl).toBe(SALEOR_API_URL);
    expect(created.name).toBe("Default tenant");
    expect(created.fief.clientId).toBe("client-uuid-1");
    // Encrypted slots must NOT equal plaintext — proves encryption ran.
    expect(created.fief.encryptedClientSecret).not.toBe("plaintext-client-secret-aaaa");
    expect(created.fief.encryptedPendingClientSecret).toBeNull();
    expect(created.softDeletedAt).toBeNull();
  });

  it("get() round-trips a previously-created connection", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const created = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();

    const fetched = (
      await repo.get({ saleorApiUrl: SALEOR_API_URL, id: created.id })
    )._unsafeUnwrap();

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe(created.name);
    expect(fetched.fief.encryptedClientSecret).toBe(created.fief.encryptedClientSecret);
    expect(fetched.claimMapping).toHaveLength(2);
  });

  it("get() on a missing id returns NotFound", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");
    const { ProviderConnectionRepoError } = await import("../../provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());
    const missingId = createProviderConnectionId("00000000-0000-4000-8000-000000000000");

    const result = await repo.get({ saleorApiUrl: SALEOR_API_URL, id: missingId });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ProviderConnectionRepoError.NotFound);
  });

  it("update() patches name + secrets and re-encrypts only the supplied slots", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const created = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();

    const updated = (
      await repo.update(
        { saleorApiUrl: SALEOR_API_URL, id: created.id },
        {
          name: createProviderConnectionName("Renamed tenant"),
          fief: {
            clientSecret: "rotated-client-secret",
          },
        },
      )
    )._unsafeUnwrap();

    expect(updated.name).toBe("Renamed tenant");
    // Patched secret was re-encrypted under a new ciphertext.
    expect(updated.fief.encryptedClientSecret).not.toBe(created.fief.encryptedClientSecret);
    expect(updated.fief.encryptedClientSecret).not.toBe("rotated-client-secret");
    // Non-patched secrets unchanged.
    expect(updated.fief.encryptedAdminToken).toBe(created.fief.encryptedAdminToken);
    expect(updated.fief.encryptedWebhookSecret).toBe(created.fief.encryptedWebhookSecret);

    // Decrypted view confirms the rotation.
    const decrypted = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: created.id })
    )._unsafeUnwrap();

    expect(decrypted.fief.clientSecret).toBe("rotated-client-secret");
    expect(decrypted.fief.adminToken).toBe("plaintext-admin-token-bbbb");
  });
});

describe("MongodbProviderConnectionRepo — encrypted at rest", () => {
  it("the raw Mongo doc has ciphertext (not plaintext) in every secret slot", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());
    const created = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const raw = await db.collection("provider_connections").findOne({ id: created.id });

    expect(raw).not.toBeNull();
    const fief = raw!.fief as Record<string, unknown>;
    const branding = raw!.branding as Record<string, unknown>;

    // None of the persisted secret values should equal the plaintext we sent in.
    const plaintexts = [
      "plaintext-client-secret-aaaa",
      "plaintext-admin-token-bbbb",
      "plaintext-webhook-secret-cccc",
      "plaintext-signing-key-dddd",
    ];

    for (const value of [
      fief.encryptedClientSecret,
      fief.encryptedAdminToken,
      fief.encryptedWebhookSecret,
      branding.encryptedSigningKey,
    ]) {
      expect(typeof value).toBe("string");
      expect(plaintexts).not.toContain(value);
      // Encryptor format is `${ivHex}:${cipherHex}` — sanity check.
      expect(value as string).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    }
  });

  it("getDecryptedSecrets returns the original plaintext", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());
    const created = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();

    const decrypted = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: created.id })
    )._unsafeUnwrap();

    expect(decrypted.fief.clientSecret).toBe("plaintext-client-secret-aaaa");
    expect(decrypted.fief.adminToken).toBe("plaintext-admin-token-bbbb");
    expect(decrypted.fief.webhookSecret).toBe("plaintext-webhook-secret-cccc");
    expect(decrypted.fief.pendingClientSecret).toBeNull();
    expect(decrypted.fief.pendingWebhookSecret).toBeNull();
    expect(decrypted.branding.signingKey).toBe("plaintext-signing-key-dddd");
  });
});

describe("MongodbProviderConnectionRepo — multi-config + listing", () => {
  it("list() returns multiple connections for the same saleorApiUrl", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    await repo.create(
      SALEOR_API_URL,
      buildCreateInput({ name: createProviderConnectionName("sandbox") }),
    );
    await repo.create(
      SALEOR_API_URL,
      buildCreateInput({ name: createProviderConnectionName("production") }),
    );
    // Different install — must NOT appear in list for SALEOR_API_URL.
    await repo.create(
      SALEOR_API_URL_OTHER,
      buildCreateInput({
        saleorApiUrl: SALEOR_API_URL_OTHER as ProviderConnectionCreateInput["saleorApiUrl"],
        name: createProviderConnectionName("other-shop"),
      }),
    );

    const result = await repo.list({ saleorApiUrl: SALEOR_API_URL });

    expect(result.isOk()).toBe(true);
    const connections = result._unsafeUnwrap();

    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.name).sort()).toStrictEqual(["production", "sandbox"]);
    for (const c of connections) {
      expect(c.saleorApiUrl).toBe(SALEOR_API_URL);
    }
  });

  it("uniqueness `{ saleorApiUrl, id }` is enforced by the registered index", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const indexes = await db.collection("provider_connections").indexes();
    const byKey = indexes.map((i) => ({ key: i.key, unique: !!i.unique }));

    // Single-key saleorApiUrl index.
    expect(byKey).toContainEqual({ key: { saleorApiUrl: 1 }, unique: false });
    // Compound unique on saleorApiUrl + id.
    expect(byKey).toContainEqual({ key: { saleorApiUrl: 1, id: 1 }, unique: true });

    /*
     * Behavioural verification of the unique index — a manual duplicate insert
     * must fail. Using the raw collection so we bypass the repo's id-gen.
     */
    const dup = {
      id: "00000000-0000-4000-8000-000000000001",
      saleorApiUrl: SALEOR_API_URL,
      name: "dup-1",
      fief: {},
      branding: {},
      claimMapping: [],
      softDeletedAt: null,
    };

    await db.collection("provider_connections").insertOne(dup);
    await expect(
      db.collection("provider_connections").insertOne({ ...dup, name: "dup-2" }),
    ).rejects.toThrow();
  });
});

describe("MongodbProviderConnectionRepo — pending-secret slot", () => {
  it("create() persists pending client + webhook secrets when supplied", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const input = buildCreateInput();

    input.fief.pendingClientSecret = "pending-client-secret-xxxx";
    input.fief.pendingWebhookSecret = "pending-webhook-secret-yyyy";

    const created = (await repo.create(SALEOR_API_URL, input))._unsafeUnwrap();

    expect(created.fief.encryptedPendingClientSecret).not.toBeNull();
    expect(created.fief.encryptedPendingClientSecret).not.toBe("pending-client-secret-xxxx");
    expect(created.fief.encryptedPendingWebhookSecret).not.toBeNull();
    expect(created.fief.encryptedPendingWebhookSecret).not.toBe("pending-webhook-secret-yyyy");

    const decrypted = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: created.id })
    )._unsafeUnwrap();

    expect(decrypted.fief.pendingClientSecret).toBe("pending-client-secret-xxxx");
    expect(decrypted.fief.pendingWebhookSecret).toBe("pending-webhook-secret-yyyy");
  });

  it("update() can clear the pending slot by passing `null`", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const input = buildCreateInput();

    input.fief.pendingClientSecret = "to-be-cleared";

    const created = (await repo.create(SALEOR_API_URL, input))._unsafeUnwrap();

    expect(created.fief.encryptedPendingClientSecret).not.toBeNull();

    const updated = (
      await repo.update(
        { saleorApiUrl: SALEOR_API_URL, id: created.id },
        { fief: { pendingClientSecret: null } },
      )
    )._unsafeUnwrap();

    expect(updated.fief.encryptedPendingClientSecret).toBeNull();
  });
});

describe("MongodbProviderConnectionRepo — soft-delete", () => {
  it("softDelete() flips the marker and excludes the row from default list()", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const a = (
      await repo.create(
        SALEOR_API_URL,
        buildCreateInput({ name: createProviderConnectionName("a") }),
      )
    )._unsafeUnwrap();

    await repo.create(
      SALEOR_API_URL,
      buildCreateInput({ name: createProviderConnectionName("b") }),
    );

    const deleteResult = await repo.softDelete({ saleorApiUrl: SALEOR_API_URL, id: a.id });

    expect(deleteResult.isOk()).toBe(true);

    const defaultList = (await repo.list({ saleorApiUrl: SALEOR_API_URL }))._unsafeUnwrap();

    expect(defaultList).toHaveLength(1);
    expect(defaultList[0]?.name).toBe("b");

    const fullList = (
      await repo.list({ saleorApiUrl: SALEOR_API_URL, includeSoftDeleted: true })
    )._unsafeUnwrap();

    expect(fullList).toHaveLength(2);

    // get() also hides soft-deleted by default.
    const defaultGet = await repo.get({ saleorApiUrl: SALEOR_API_URL, id: a.id });

    expect(defaultGet.isErr()).toBe(true);

    const overrideGet = await repo.get({
      saleorApiUrl: SALEOR_API_URL,
      id: a.id,
      includeSoftDeleted: true,
    });

    expect(overrideGet.isOk()).toBe(true);
    expect(overrideGet._unsafeUnwrap().softDeletedAt).toBeInstanceOf(Date);
  });

  it("restore() clears softDeletedAt", async () => {
    const { resetMigrationRegistryForTests, runMigrations } = await import(
      "@/modules/db/migration-runner"
    );
    const { MongodbProviderConnectionRepo } = await import("./mongodb-provider-connection-repo");

    resetMigrationRegistryForTests();
    await import("../../migrations");
    await runMigrations();

    const repo = new MongodbProviderConnectionRepo(buildEncryptor());

    const a = (await repo.create(SALEOR_API_URL, buildCreateInput()))._unsafeUnwrap();

    await repo.softDelete({ saleorApiUrl: SALEOR_API_URL, id: a.id });

    const restored = (
      await repo.restore({ saleorApiUrl: SALEOR_API_URL, id: a.id })
    )._unsafeUnwrap();

    expect(restored.softDeletedAt).toBeNull();

    const list = (await repo.list({ saleorApiUrl: SALEOR_API_URL }))._unsafeUnwrap();

    expect(list).toHaveLength(1);
  });
});
