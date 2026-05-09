import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * T9 — Mongo channel-configuration repo behavioural tests.
 *
 * Boots an in-process MongoDB via `mongodb-memory-server`, points the env
 * layer at it, and exercises the public repo surface the channel-scope
 * resolver (T12) will consume:
 *
 *   - upsert + read round-trip
 *   - one row per saleorApiUrl (uniqueness guarded by index)
 *   - overrides list is preserved in input order
 *   - re-upsert overwrites overrides + default cleanly
 *   - `get` for a never-seen saleorApiUrl returns `null`
 *
 * The repo deliberately exposes a single-row-per-saleorApiUrl shape — that
 * matches the avatax "default + overrides" pattern the plan calls out, and
 * lets T12's resolver fetch the full config in one round-trip.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_channel_config_test");
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

const saleorApiUrlA = createSaleorApiUrl("https://shop-a.saleor.cloud/graphql/")._unsafeUnwrap();
const saleorApiUrlB = createSaleorApiUrl("https://shop-b.saleor.cloud/graphql/")._unsafeUnwrap();

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_channel_config_test");

  try {
    await db.collection("channel_configuration").drop();
  } catch {
    // collection may not exist yet
  }

  await closeMongoClient();

  vi.resetModules();
});

describe("MongoChannelConfigurationRepo — round-trip", () => {
  it("upserts a config and reads it back exactly", async () => {
    const { MongoChannelConfigurationRepo } = await import("./mongodb-channel-configuration-repo");
    const { createChannelSlug, createConnectionId } = await import("../../channel-configuration");

    const repo = new MongoChannelConfigurationRepo();

    const upsertResult = await repo.upsert({
      saleorApiUrl: saleorApiUrlA,
      defaultConnectionId: createConnectionId("conn-default"),
      overrides: [
        {
          channelSlug: createChannelSlug("uk"),
          connectionId: createConnectionId("conn-uk"),
        },
      ],
    });

    expect(upsertResult.isOk()).toBe(true);

    const readResult = await repo.get(saleorApiUrlA);

    expect(readResult.isOk()).toBe(true);

    const config = readResult._unsafeUnwrap();

    expect(config).not.toBeNull();
    expect(config?.saleorApiUrl).toBe(saleorApiUrlA);
    expect(config?.defaultConnectionId).toBe("conn-default");
    expect(config?.overrides).toStrictEqual([{ channelSlug: "uk", connectionId: "conn-uk" }]);
  });

  it("returns null for an unseen saleorApiUrl", async () => {
    const { MongoChannelConfigurationRepo } = await import("./mongodb-channel-configuration-repo");

    const repo = new MongoChannelConfigurationRepo();

    const result = await repo.get(saleorApiUrlA);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("strips the internal Mongo `_id` from reads", async () => {
    const { MongoChannelConfigurationRepo } = await import("./mongodb-channel-configuration-repo");

    const repo = new MongoChannelConfigurationRepo();

    await repo.upsert({
      saleorApiUrl: saleorApiUrlA,
      defaultConnectionId: null,
      overrides: [],
    });

    const result = await repo.get(saleorApiUrlA);
    const config = result._unsafeUnwrap();

    expect(config).not.toHaveProperty("_id");
  });
});

describe("MongoChannelConfigurationRepo — uniqueness", () => {
  it("a re-upsert overwrites the existing row (single config per saleorApiUrl)", async () => {
    const { MongoChannelConfigurationRepo } = await import("./mongodb-channel-configuration-repo");
    const { createChannelSlug, createConnectionId } = await import("../../channel-configuration");

    const repo = new MongoChannelConfigurationRepo();

    await repo.upsert({
      saleorApiUrl: saleorApiUrlA,
      defaultConnectionId: createConnectionId("conn-old"),
      overrides: [
        {
          channelSlug: createChannelSlug("uk"),
          connectionId: createConnectionId("conn-uk"),
        },
      ],
    });

    await repo.upsert({
      saleorApiUrl: saleorApiUrlA,
      defaultConnectionId: createConnectionId("conn-new"),
      overrides: [],
    });

    const result = await repo.get(saleorApiUrlA);
    const config = result._unsafeUnwrap();

    expect(config?.defaultConnectionId).toBe("conn-new");
    expect(config?.overrides).toStrictEqual([]);

    /*
     * Verify by counting rows in the underlying collection — there must be
     * exactly one document for this saleorApiUrl.
     */
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const count = await db
      .collection("channel_configuration")
      .countDocuments({ saleorApiUrl: saleorApiUrlA });

    expect(count).toBe(1);
  });

  it("isolates configs per saleorApiUrl (no cross-tenant bleed)", async () => {
    const { MongoChannelConfigurationRepo } = await import("./mongodb-channel-configuration-repo");
    const { createConnectionId } = await import("../../channel-configuration");

    const repo = new MongoChannelConfigurationRepo();

    await repo.upsert({
      saleorApiUrl: saleorApiUrlA,
      defaultConnectionId: createConnectionId("conn-a"),
      overrides: [],
    });

    await repo.upsert({
      saleorApiUrl: saleorApiUrlB,
      defaultConnectionId: createConnectionId("conn-b"),
      overrides: [],
    });

    const a = (await repo.get(saleorApiUrlA))._unsafeUnwrap();
    const b = (await repo.get(saleorApiUrlB))._unsafeUnwrap();

    expect(a?.defaultConnectionId).toBe("conn-a");
    expect(b?.defaultConnectionId).toBe("conn-b");
  });
});

describe("MongoChannelConfigurationRepo — order preservation", () => {
  it("preserves overrides array order across upsert + read", async () => {
    const { MongoChannelConfigurationRepo } = await import("./mongodb-channel-configuration-repo");
    const { createChannelSlug, createConnectionId } = await import("../../channel-configuration");

    const repo = new MongoChannelConfigurationRepo();

    const ordered = [
      { channelSlug: createChannelSlug("uk"), connectionId: createConnectionId("c1") },
      { channelSlug: createChannelSlug("us"), connectionId: "disabled" as const },
      { channelSlug: createChannelSlug("ca"), connectionId: createConnectionId("c2") },
      { channelSlug: createChannelSlug("au"), connectionId: createConnectionId("c3") },
    ];

    await repo.upsert({
      saleorApiUrl: saleorApiUrlA,
      defaultConnectionId: null,
      overrides: ordered,
    });

    const result = await repo.get(saleorApiUrlA);
    const config = result._unsafeUnwrap();

    expect(config?.overrides.map((o) => o.channelSlug)).toStrictEqual(["uk", "us", "ca", "au"]);
    expect(config?.overrides.map((o) => o.connectionId)).toStrictEqual([
      "c1",
      "disabled",
      "c2",
      "c3",
    ]);
  });
});
