import { MongoClient } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import {
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  PriceVariantMapError,
  type PriceVariantMapping,
} from "../../saleor-bridge/price-variant-map";
import { MongodbPriceVariantMapRepo } from "./mongodb-price-variant-map-repo";

/*
 * Mock the `mongodb` driver so unit tests don't need a live MongoDB. We use
 * `vi.hoisted` so the mock objects exist before the `vi.mock` factory runs,
 * and rebuild the spies in `beforeEach` because vitest config has
 * `mockReset: true` which clears every spy between tests (including the
 * MongoClient constructor itself).
 */
const { collectionMock, dbMock, clientMock } = vi.hoisted(() => {
  return {
    collectionMock: {
      createIndex: vi.fn(),
      replaceOne: vi.fn(),
      findOne: vi.fn(),
      deleteOne: vi.fn(),
      find: vi.fn(),
    },
    dbMock: {
      collection: vi.fn(),
    },
    clientMock: {
      connect: vi.fn(),
      db: vi.fn(),
      close: vi.fn(),
    },
  };
});

vi.mock("mongodb", () => ({
  MongoClient: vi.fn(() => clientMock),
}));

vi.mock("@/lib/env", () => ({
  env: {
    MONGODB_URL: "mongodb://localhost:27017/test",
    MONGODB_DATABASE: "saleor_stripe_test",
    SECRET_KEY: "test_secret_key",
  },
}));

const FIXED_CREATED = new Date("2026-05-01T00:00:00.000Z");
const FIXED_MODIFIED = new Date("2026-05-09T00:00:00.000Z");

const stripePriceId = createStripePriceId("price_TEST_TEST_TEST");
const stripePriceId2 = createStripePriceId("price_TEST_TEST_OTHER");
const saleorVariantId = createSaleorVariantId("UHJvZHVjdFZhcmlhbnQ6MQ==");
const saleorVariantId2 = createSaleorVariantId("UHJvZHVjdFZhcmlhbnQ6Mg==");
const saleorChannelSlug = createSaleorChannelSlug("owlbooks");

const ACCESS = { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId };

const buildMapping = (overrides: Partial<PriceVariantMapping> = {}): PriceVariantMapping => ({
  stripePriceId,
  saleorVariantId,
  saleorChannelSlug,
  createdAt: FIXED_CREATED,
  updatedAt: FIXED_MODIFIED,
  ...overrides,
});

const buildMongoDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: "doc-id",
  saleorApiUrl: mockedSaleorApiUrl as unknown as string,
  appId: mockedSaleorAppId,
  stripePriceId: stripePriceId as unknown as string,
  saleorVariantId: saleorVariantId as unknown as string,
  saleorChannelSlug: saleorChannelSlug as unknown as string,
  createdAt: FIXED_CREATED,
  updatedAt: FIXED_MODIFIED,
  ...overrides,
});

describe("MongodbPriceVariantMapRepo", () => {
  let repo: MongodbPriceVariantMapRepo;

  beforeEach(() => {
    /*
     * `mockReset` in vitest.config wipes every spy between tests, including
     * the MongoClient constructor and all collection methods. Restore the
     * chained client/db/collection mocks here so each test starts from a
     * clean known state regardless of run order.
     */
    vi.mocked(MongoClient).mockImplementation((() => clientMock) as never);

    collectionMock.createIndex.mockResolvedValue("idx_1");
    collectionMock.replaceOne.mockResolvedValue({ acknowledged: true, upsertedCount: 1 });
    collectionMock.findOne.mockResolvedValue(null);
    collectionMock.deleteOne.mockResolvedValue({ acknowledged: true, deletedCount: 1 });
    collectionMock.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
    }));
    dbMock.collection.mockReturnValue(collectionMock);
    clientMock.connect.mockResolvedValue(undefined);
    clientMock.db.mockReturnValue(dbMock);
    clientMock.close.mockResolvedValue(undefined);

    repo = new MongodbPriceVariantMapRepo();
  });

  describe("set", () => {
    it("upserts mapping and returns ok(null) on success", async () => {
      const result = await repo.set(ACCESS, buildMapping());

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();

      expect(collectionMock.replaceOne).toHaveBeenCalledWith(
        {
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          stripePriceId: stripePriceId as unknown as string,
        },
        expect.objectContaining({
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          stripePriceId: stripePriceId as unknown as string,
          saleorVariantId: saleorVariantId as unknown as string,
          saleorChannelSlug: saleorChannelSlug as unknown as string,
          createdAt: FIXED_CREATED,
          updatedAt: FIXED_MODIFIED,
        }),
        { upsert: true },
      );
    });

    it("returns PersistenceFailedError when replaceOne throws", async () => {
      collectionMock.replaceOne.mockRejectedValueOnce(new Error("boom"));

      const result = await repo.set(ACCESS, buildMapping());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });

  describe("get", () => {
    it("returns the mapping with all fields preserved on round-trip", async () => {
      collectionMock.findOne.mockResolvedValueOnce(buildMongoDoc());

      const result = await repo.get(ACCESS, stripePriceId);

      const mapping = result._unsafeUnwrap();

      expect(mapping).not.toBeNull();
      expect(mapping!.stripePriceId).toBe(stripePriceId);
      expect(mapping!.saleorVariantId).toBe(saleorVariantId);
      expect(mapping!.saleorChannelSlug).toBe(saleorChannelSlug);
      expect(mapping!.createdAt.toISOString()).toBe(FIXED_CREATED.toISOString());
      expect(mapping!.updatedAt.toISOString()).toBe(FIXED_MODIFIED.toISOString());

      expect(collectionMock.findOne).toHaveBeenCalledWith({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        stripePriceId: stripePriceId as unknown as string,
      });
    });

    it("returns ok(null) when no document found (unknown stripePriceId — contract)", async () => {
      collectionMock.findOne.mockResolvedValueOnce(null);

      const result = await repo.get(ACCESS, stripePriceId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError when findOne throws", async () => {
      collectionMock.findOne.mockRejectedValueOnce(new Error("boom"));

      const result = await repo.get(ACCESS, stripePriceId);

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });

  describe("delete", () => {
    it("returns ok(null) when delete succeeds", async () => {
      const result = await repo.delete(ACCESS, stripePriceId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
      expect(collectionMock.deleteOne).toHaveBeenCalledWith({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        stripePriceId: stripePriceId as unknown as string,
      });
    });

    it("returns PersistenceFailedError when deleteOne throws", async () => {
      collectionMock.deleteOne.mockRejectedValueOnce(new Error("boom"));

      const result = await repo.delete(ACCESS, stripePriceId);

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });

  describe("list", () => {
    it("returns all mappings for the installation", async () => {
      collectionMock.find.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([
          buildMongoDoc(),
          buildMongoDoc({
            stripePriceId: stripePriceId2 as unknown as string,
            saleorVariantId: saleorVariantId2 as unknown as string,
          }),
        ]),
      });

      const result = await repo.list(ACCESS);

      const mappings = result._unsafeUnwrap();

      expect(mappings).toHaveLength(2);
      expect(mappings[0].stripePriceId).toBe(stripePriceId);
      expect(mappings[0].saleorVariantId).toBe(saleorVariantId);
      expect(mappings[0].saleorChannelSlug).toBe(saleorChannelSlug);
      expect(mappings[1].stripePriceId).toBe(stripePriceId2);
      expect(mappings[1].saleorVariantId).toBe(saleorVariantId2);

      expect(collectionMock.find).toHaveBeenCalledWith({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
      });
    });

    it("returns ok([]) when no mappings exist", async () => {
      collectionMock.find.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await repo.list(ACCESS);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual([]);
    });

    it("returns PersistenceFailedError when find().toArray() throws", async () => {
      collectionMock.find.mockReturnValueOnce({
        toArray: vi.fn().mockRejectedValue(new Error("boom")),
      });

      const result = await repo.list(ACCESS);

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });
});
