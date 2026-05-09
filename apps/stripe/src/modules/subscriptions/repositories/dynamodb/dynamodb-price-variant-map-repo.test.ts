import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { DynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

import {
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  PriceVariantMapError,
  type PriceVariantMapping,
} from "../../saleor-bridge/price-variant-map";
import { DynamoDbPriceVariantMapRepo } from "./dynamodb-price-variant-map-repo";
import { DynamoDbPriceVariantMap } from "./price-variant-map-db-model";

const FIXED_CREATED = new Date("2026-05-01T00:00:00.000Z");
const FIXED_MODIFIED = new Date("2026-05-09T00:00:00.000Z");

const stripePriceId = createStripePriceId("price_TEST_TEST_TEST");
const stripePriceId2 = createStripePriceId("price_TEST_TEST_OTHER");
const saleorVariantId = createSaleorVariantId("UHJvZHVjdFZhcmlhbnQ6MQ==");
const saleorVariantId2 = createSaleorVariantId("UHJvZHVjdFZhcmlhbnQ6Mg==");
const saleorChannelSlug = createSaleorChannelSlug("owlbooks");

const PK_VALUE = `${mockedSaleorApiUrl}#${mockedSaleorAppId}`;
const SK_VALUE = `price-variant-map#${stripePriceId}`;
const SK_VALUE_2 = `price-variant-map#${stripePriceId2}`;

const buildMapping = (overrides: Partial<PriceVariantMapping> = {}): PriceVariantMapping => ({
  stripePriceId,
  saleorVariantId,
  saleorChannelSlug,
  createdAt: FIXED_CREATED,
  updatedAt: FIXED_MODIFIED,
  ...overrides,
});

const buildDynamoRow = (overrides: Record<string, unknown> = {}) => ({
  PK: PK_VALUE,
  SK: SK_VALUE,
  stripePriceId,
  saleorVariantId,
  saleorChannelSlug,
  createdAt: FIXED_CREATED.toISOString(),
  modifiedAt: FIXED_MODIFIED.toISOString(),
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  _et: "PriceVariantMap",
  ...overrides,
});

describe("DynamoDbPriceVariantMapRepo", () => {
  let repo: DynamoDbPriceVariantMapRepo;
  const mockDocumentClient = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    mockDocumentClient.reset();

    const table = DynamoMainTable.create({
      // @ts-expect-error mocking DynamoDBDocumentClient
      documentClient: mockDocumentClient,
      tableName: "stripe-test-table",
    });

    const entity = DynamoDbPriceVariantMap.createEntity(table);

    repo = new DynamoDbPriceVariantMapRepo({ entity });
  });

  describe("set", () => {
    it("returns ok(null) when DynamoDB write succeeds", async () => {
      mockDocumentClient.on(PutCommand, {}).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.set(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildMapping(),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError on non-200 response", async () => {
      mockDocumentClient.on(PutCommand, {}).resolvesOnce({
        $metadata: { httpStatusCode: 500 },
      });

      const result = await repo.set(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildMapping(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });

    it("returns PersistenceFailedError when SDK throws", async () => {
      mockDocumentClient.on(PutCommand, {}).rejectsOnce(new Error("boom"));

      const result = await repo.set(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildMapping(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });

  describe("get", () => {
    it("returns the mapping with all 3 fields preserved on round-trip", async () => {
      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          Item: buildDynamoRow(),
          $metadata: { httpStatusCode: 200 },
        });

      const result = await repo.get(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      const mapping = result._unsafeUnwrap();

      expect(mapping).not.toBeNull();
      expect(mapping!.stripePriceId).toBe(stripePriceId);
      expect(mapping!.saleorVariantId).toBe(saleorVariantId);
      expect(mapping!.saleorChannelSlug).toBe(saleorChannelSlug);
      expect(mapping!.createdAt.toISOString()).toBe(FIXED_CREATED.toISOString());
      expect(mapping!.updatedAt.toISOString()).toBe(FIXED_MODIFIED.toISOString());
    });

    it("returns ok(null) when no item found in DynamoDB (unknown stripePriceId)", async () => {
      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          $metadata: { httpStatusCode: 200 },
        });

      const result = await repo.get(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError on non-200 status", async () => {
      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          $metadata: { httpStatusCode: 500 },
        });

      const result = await repo.get(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });

    it("returns PersistenceFailedError on SDK throw (DynamoDB throws → returns wrapped Err)", async () => {
      mockDocumentClient.on(GetCommand).rejectsOnce(new Error("boom"));

      const result = await repo.get(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });

  describe("delete", () => {
    it("returns ok(null) when DynamoDB delete succeeds", async () => {
      mockDocumentClient
        .on(DeleteCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          $metadata: { httpStatusCode: 200 },
        });

      const result = await repo.delete(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError when SDK throws", async () => {
      mockDocumentClient.on(DeleteCommand).rejectsOnce(new Error("boom"));

      const result = await repo.delete(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });

    it("after delete, subsequent get returns ok(null)", async () => {
      mockDocumentClient
        .on(DeleteCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } });

      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } });

      const deleteResult = await repo.delete(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(deleteResult.isOk()).toBe(true);

      const getResult = await repo.get(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripePriceId,
      );

      expect(getResult.isOk()).toBe(true);
      expect(getResult._unsafeUnwrap()).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all mappings for the installation via partition-scoped Query", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [
          buildDynamoRow(),
          buildDynamoRow({
            SK: SK_VALUE_2,
            stripePriceId: stripePriceId2,
            saleorVariantId: saleorVariantId2,
          }),
        ],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.list({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
      });

      const mappings = result._unsafeUnwrap();

      expect(mappings).toHaveLength(2);
      expect(mappings[0].stripePriceId).toBe(stripePriceId);
      expect(mappings[0].saleorVariantId).toBe(saleorVariantId);
      expect(mappings[0].saleorChannelSlug).toBe(saleorChannelSlug);
      expect(mappings[1].stripePriceId).toBe(stripePriceId2);
      expect(mappings[1].saleorVariantId).toBe(saleorVariantId2);
    });

    it("returns ok([]) when no mappings exist for the installation", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.list({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual([]);
    });

    it("returns PersistenceFailedError on SDK throw", async () => {
      mockDocumentClient.on(QueryCommand).rejectsOnce(new Error("boom"));

      const result = await repo.list({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
      });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(PriceVariantMapError.PersistenceFailedError);
    });
  });
});
