import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { DynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

import { type FailedMintRecord, FailedMintDlqRepoError } from "../failed-mint-dlq-repo";
import { DynamoDbFailedMintDlqRepo } from "./dynamodb-failed-mint-dlq-repo";
import { DynamoDbFailedMint } from "./failed-mint-dlq-db-model";

const PK_VALUE = `${mockedSaleorApiUrl}#${mockedSaleorAppId}`;
const TEST_INVOICE_ID = "in_test_T32_001";
const SK_VALUE = `failed-mint#${TEST_INVOICE_ID}`;

const buildRecord = (overrides: Partial<FailedMintRecord> = {}): FailedMintRecord => ({
  stripeInvoiceId: TEST_INVOICE_ID,
  stripeSubscriptionId: "sub_test_T32",
  stripeCustomerId: "cus_test_T32",
  fiefUserId: "fief_user_T32",
  saleorChannelSlug: "owlbooks",
  saleorVariantId: "VmFyaWFudDox",
  amountCents: 4900,
  currency: "usd",
  taxCents: 400,
  errorMessage: "draftOrderCreate failed",
  errorClass: "DraftOrderCreateFailedError",
  attemptCount: 1,
  nextRetryAt: 1_715_000_300,
  firstAttemptAt: 1_715_000_000,
  lastAttemptAt: 1_715_000_000,
  invoicePayload: JSON.stringify({ id: TEST_INVOICE_ID, amount_paid: 4900, currency: "usd" }),
  ...overrides,
});

const buildDynamoRow = (overrides: Record<string, unknown> = {}) => ({
  PK: PK_VALUE,
  SK: SK_VALUE,
  ...buildRecord(),
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  _et: "FailedMintDlq",
  createdAt: new Date("2026-05-09T00:00:00.000Z").toISOString(),
  modifiedAt: new Date("2026-05-09T00:05:00.000Z").toISOString(),
  ...overrides,
});

describe("DynamoDbFailedMintDlqRepo", () => {
  let repo: DynamoDbFailedMintDlqRepo;
  const mockDocumentClient = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    mockDocumentClient.reset();

    const table = DynamoMainTable.create({
      // @ts-expect-error mocking DynamoDBDocumentClient
      documentClient: mockDocumentClient,
      tableName: "stripe-test-table",
    });

    const entity = DynamoDbFailedMint.createEntity(table);

    repo = new DynamoDbFailedMintDlqRepo({ entity });
  });

  describe("record", () => {
    it("returns ok(null) when DynamoDB write succeeds", async () => {
      mockDocumentClient.on(PutCommand, {}).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.record(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError on non-200 response", async () => {
      mockDocumentClient.on(PutCommand, {}).resolvesOnce({
        $metadata: { httpStatusCode: 500 },
      });

      const result = await repo.record(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });

    it("returns PersistenceFailedError when SDK throws", async () => {
      mockDocumentClient.on(PutCommand, {}).rejectsOnce(new Error("boom"));

      const result = await repo.record(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });

  describe("getById", () => {
    it("returns the record with all fields preserved on round-trip", async () => {
      mockDocumentClient
        .on(GetCommand, { Key: { PK: PK_VALUE, SK: SK_VALUE } })
        .resolvesOnce({ Item: buildDynamoRow(), $metadata: { httpStatusCode: 200 } });

      const result = await repo.getById(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      const value = result._unsafeUnwrap();

      expect(value).not.toBeNull();
      expect(value!.stripeInvoiceId).toBe(TEST_INVOICE_ID);
      expect(value!.stripeSubscriptionId).toBe("sub_test_T32");
      expect(value!.amountCents).toBe(4900);
      expect(value!.attemptCount).toBe(1);
      expect(value!.nextRetryAt).toBe(1_715_000_300);
      expect(value!.errorClass).toBe("DraftOrderCreateFailedError");
    });

    it("returns ok(null) when DynamoDB has no item", async () => {
      mockDocumentClient
        .on(GetCommand, { Key: { PK: PK_VALUE, SK: SK_VALUE } })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } });

      const result = await repo.getById(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError on SDK throw", async () => {
      mockDocumentClient.on(GetCommand).rejectsOnce(new Error("boom"));

      const result = await repo.getById(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });

  describe("listPendingRetries", () => {
    it("returns all pending entries (filter applied client-side via dynamodb-toolbox)", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [buildDynamoRow()],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.listPendingRetries(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        2_000_000_000,
      );

      const records = result._unsafeUnwrap();

      expect(records).toHaveLength(1);
      expect(records[0].stripeInvoiceId).toBe(TEST_INVOICE_ID);
    });

    it("returns ok([]) when no pending entries", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.listPendingRetries(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        2_000_000_000,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual([]);
    });

    it("returns PersistenceFailedError on SDK throw", async () => {
      mockDocumentClient.on(QueryCommand).rejectsOnce(new Error("boom"));

      const result = await repo.listPendingRetries(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        2_000_000_000,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });

  describe("delete", () => {
    it("returns ok(null) when DynamoDB delete succeeds", async () => {
      mockDocumentClient
        .on(DeleteCommand, { Key: { PK: PK_VALUE, SK: SK_VALUE } })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } });

      const result = await repo.delete(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns PersistenceFailedError when SDK throws", async () => {
      mockDocumentClient.on(DeleteCommand).rejectsOnce(new Error("boom"));

      const result = await repo.delete(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });

  describe("markFinalFailure", () => {
    it("read+upsert sets finalFailureAlertedAt timestamp", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-09T12:00:00.000Z"));

      mockDocumentClient
        .on(GetCommand, { Key: { PK: PK_VALUE, SK: SK_VALUE } })
        .resolvesOnce({ Item: buildDynamoRow(), $metadata: { httpStatusCode: 200 } });

      mockDocumentClient.on(PutCommand).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.markFinalFailure(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      expect(result.isOk()).toBe(true);

      // Inspect the PutCommand input to confirm finalFailureAlertedAt was set.
      const calls = mockDocumentClient.commandCalls(PutCommand);

      expect(calls).toHaveLength(1);
      const item = calls[0].args[0].input.Item as Record<string, unknown>;

      expect(item.finalFailureAlertedAt).toBe(Math.floor(Date.UTC(2026, 4, 9, 12, 0, 0) / 1000));

      vi.useRealTimers();
    });

    it("returns PersistenceFailedError when entry does not exist", async () => {
      mockDocumentClient
        .on(GetCommand, { Key: { PK: PK_VALUE, SK: SK_VALUE } })
        .resolvesOnce({ $metadata: { httpStatusCode: 200 } });

      const result = await repo.markFinalFailure(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });

  describe("round-trip", () => {
    it("record → getById returns the same record", async () => {
      mockDocumentClient.on(PutCommand).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      mockDocumentClient
        .on(GetCommand, { Key: { PK: PK_VALUE, SK: SK_VALUE } })
        .resolvesOnce({
          Item: buildDynamoRow(),
          $metadata: { httpStatusCode: 200 },
        });

      const recorded = await repo.record(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(recorded.isOk()).toBe(true);

      const fetched = await repo.getById(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        TEST_INVOICE_ID,
      );

      const value = fetched._unsafeUnwrap();

      expect(value!.stripeInvoiceId).toBe(TEST_INVOICE_ID);
      expect(value!.attemptCount).toBe(1);
    });
  });
});
