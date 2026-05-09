import { type AuthData } from "@saleor/app-sdk/APL";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * T3 — MongoAPL behavioural test suite.
 *
 * Boots an in-process MongoDB via `mongodb-memory-server`, points the env
 * layer at it, and exercises the public `APL` interface end-to-end:
 *
 *   - set/get/delete/getAll round-trip
 *   - singleton verification — `MongoClient.connect` is invoked exactly once
 *     even after N consecutive APL calls (serverless cold-start gating).
 *   - clean shutdown via `MongoAPL#close()` releases the underlying pool.
 *   - isReady / isConfigured behave as the SDK contract expects.
 *
 * The mongo-client singleton (`src/modules/db/mongo-client.ts`) is exercised
 * indirectly through MongoAPL — we spy on `MongoClient.prototype.connect` to
 * count opens.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_apl_test");
  vi.stubEnv("APL", "mongodb");
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

const sampleAuth = (override: Partial<AuthData> = {}): AuthData => ({
  appId: "app-id-1",
  saleorApiUrl: "https://shop-1.saleor.cloud/graphql/",
  token: "token-1",
  jwks: '{"keys":[]}',
  ...override,
});

/*
 * Each test gets a fresh module graph so the singleton state in
 * `mongo-client.ts` resets and we can re-spy on `MongoClient.prototype.connect`
 * cleanly. `vi.resetModules()` invalidates `import()` caches; subsequent
 * dynamic imports re-evaluate the module top-level.
 */
beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  // Drop the collection between runs so getAll is deterministic.
  const { getMongoClient } = await import("../db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_apl_test");

  try {
    await db.collection("apl_auth_data").drop();
  } catch {
    // Collection may not exist yet — fine.
  }
  // Close so the next test exercises a fresh singleton.
  const { closeMongoClient } = await import("../db/mongo-client");

  await closeMongoClient();
  vi.resetModules();
});

describe("MongoAPL", () => {
  it("round-trips set → get for a single auth entry", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const data = sampleAuth();

    await apl.set(data);
    const fetched = await apl.get(data.saleorApiUrl);

    expect(fetched).toStrictEqual(data);

    await apl.close();
  });

  it("returns undefined for a missing saleorApiUrl on get", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const fetched = await apl.get("https://does-not-exist.saleor.cloud/graphql/");

    expect(fetched).toBeUndefined();

    await apl.close();
  });

  it("upserts on set when an entry already exists for the same saleorApiUrl", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const original = sampleAuth({ token: "token-old" });

    await apl.set(original);
    await apl.set({ ...original, token: "token-new" });

    const fetched = await apl.get(original.saleorApiUrl);

    expect(fetched?.token).toBe("token-new");

    await apl.close();
  });

  it("deletes an entry then get returns undefined", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();
    const data = sampleAuth();

    await apl.set(data);
    await apl.delete(data.saleorApiUrl);
    const fetched = await apl.get(data.saleorApiUrl);

    expect(fetched).toBeUndefined();

    await apl.close();
  });

  it("getAll returns every set entry without the Mongo `_id` field", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const a = sampleAuth({
      appId: "app-a",
      saleorApiUrl: "https://shop-a.saleor.cloud/graphql/",
      token: "tok-a",
    });
    const b = sampleAuth({
      appId: "app-b",
      saleorApiUrl: "https://shop-b.saleor.cloud/graphql/",
      token: "tok-b",
    });

    await apl.set(a);
    await apl.set(b);

    const all = await apl.getAll();

    expect(all).toHaveLength(2);
    /*
     * `_id` is a Mongo-internal field that must be stripped before returning
     * to the SDK so the AuthData contract is honored.
     */
    for (const entry of all) {
      expect(entry).not.toHaveProperty("_id");
    }
    expect(all.map((e) => e.token).sort()).toStrictEqual(["tok-a", "tok-b"]);

    await apl.close();
  });

  it("isConfigured returns { configured: true } when MONGODB_URL is set", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const result = await apl.isConfigured();

    expect(result).toStrictEqual({ configured: true });

    await apl.close();
  });

  it("isReady returns { ready: true } against a live server", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const result = await apl.isReady();

    expect(result).toStrictEqual({ ready: true });

    await apl.close();
  });
});

describe("MongoAPL — singleton MongoClient", () => {
  it("calls MongoClient#connect exactly once across many APL calls", async () => {
    /*
     * Spy on the driver-level `connect` so we count opens on the underlying
     * pool, not just the wrapper. The mongo-client module ought to memoize
     * its connect promise so concurrent + sequential callers share one pool.
     */
    const mongodb = await import("mongodb");
    const connectSpy = vi.spyOn(mongodb.MongoClient.prototype, "connect");

    const { MongoAPL } = await import("./mongodb-apl");
    const apl = new MongoAPL();

    const data = sampleAuth();

    // Sequential calls.
    await apl.set(data);
    await apl.get(data.saleorApiUrl);
    await apl.getAll();
    await apl.delete(data.saleorApiUrl);
    await apl.get(data.saleorApiUrl);

    /*
     * Concurrent calls — this is the harder case; if `connect` isn't
     * properly promise-memoized we'd see one connect per concurrent caller.
     */
    await Promise.all([
      apl.set(data),
      apl.set(sampleAuth({ saleorApiUrl: "https://shop-2.saleor.cloud/graphql/" })),
      apl.get(data.saleorApiUrl),
      apl.getAll(),
    ]);

    expect(connectSpy).toHaveBeenCalledTimes(1);

    await apl.close();
  });

  it("two MongoAPL instances share the same underlying MongoClient (one connect)", async () => {
    /*
     * The singleton lives in `mongo-client.ts`, not on the APL — so making
     * two MongoAPLs in the same process must NOT open two pools.
     */
    const mongodb = await import("mongodb");
    const connectSpy = vi.spyOn(mongodb.MongoClient.prototype, "connect");

    const { MongoAPL } = await import("./mongodb-apl");
    const apl1 = new MongoAPL();
    const apl2 = new MongoAPL();

    await apl1.set(sampleAuth({ saleorApiUrl: "https://shop-x.saleor.cloud/graphql/" }));
    await apl2.set(sampleAuth({ saleorApiUrl: "https://shop-y.saleor.cloud/graphql/" }));
    await apl1.getAll();
    await apl2.getAll();

    expect(connectSpy).toHaveBeenCalledTimes(1);

    await apl1.close();
    // apl2 doesn't need its own close; the singleton is shared.
  });
});

describe("MongoAPL — clean shutdown", () => {
  it("closes the underlying MongoClient when close() is called", async () => {
    const { MongoAPL } = await import("./mongodb-apl");
    const { getMongoClient } = await import("../db/mongo-client");

    const apl = new MongoAPL();

    await apl.set(sampleAuth());
    const clientBefore = await getMongoClient();
    const closeSpy = vi.spyOn(clientBefore, "close");

    await apl.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("permits a fresh connect after close()", async () => {
    const mongodb = await import("mongodb");
    const connectSpy = vi.spyOn(mongodb.MongoClient.prototype, "connect");

    const { MongoAPL } = await import("./mongodb-apl");

    const apl = new MongoAPL();

    await apl.set(sampleAuth());
    await apl.close();

    // Re-use after close — singleton must rebuild its client lazily.
    await apl.set(sampleAuth({ saleorApiUrl: "https://shop-reopen.saleor.cloud/graphql/" }));
    const fetched = await apl.get("https://shop-reopen.saleor.cloud/graphql/");

    expect(fetched?.token).toBe("token-1");
    // First test op + post-close re-open = exactly two connects.
    expect(connectSpy).toHaveBeenCalledTimes(2);

    await apl.close();
  });
});
