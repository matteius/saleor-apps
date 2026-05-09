import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
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
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../subscription-record";
import { SubscriptionRepoError } from "../subscription-repo";
import { DynamoDbSubscriptionRepo } from "./dynamodb-subscription-repo";
import { DynamoDbSubscription } from "./subscription-db-model";

const FIXED_PERIOD_START = new Date("2026-01-01T00:00:00.000Z");
const FIXED_PERIOD_END = new Date("2026-02-01T00:00:00.000Z");
const FIXED_CREATED = new Date("2026-01-01T00:00:00.000Z");
const FIXED_MODIFIED = new Date("2026-01-01T00:00:00.000Z");

const stripeSubscriptionId = createStripeSubscriptionId("sub_TEST_TEST_TEST");
const stripeCustomerId = createStripeCustomerId("cus_TEST_TEST_TEST");
const stripePriceId = createStripePriceId("price_TEST_TEST_TEST");
const fiefUserId = createFiefUserId("fief-user-TEST");
const saleorChannelSlug = createSaleorChannelSlug("owlbooks");
const saleorUserId = "saleor-user-TEST";

const PK_VALUE = `${mockedSaleorApiUrl}#${mockedSaleorAppId}`;
const SK_VALUE = `SUBSCRIPTION#${stripeSubscriptionId}`;

const buildRecord = () =>
  new SubscriptionRecord({
    stripeSubscriptionId,
    stripeCustomerId,
    saleorChannelSlug,
    saleorUserId,
    fiefUserId,
    saleorEntityId: null,
    stripePriceId,
    status: "active",
    currentPeriodStart: FIXED_PERIOD_START,
    currentPeriodEnd: FIXED_PERIOD_END,
    cancelAtPeriodEnd: false,
    lastInvoiceId: null,
    lastSaleorOrderId: null,
    createdAt: FIXED_CREATED,
    updatedAt: FIXED_MODIFIED,
  });

const buildDynamoRow = (overrides: Record<string, unknown> = {}) => ({
  PK: PK_VALUE,
  SK: SK_VALUE,
  stripeSubscriptionId,
  stripeCustomerId,
  saleorChannelSlug,
  saleorUserId,
  fiefUserId,
  stripePriceId,
  status: "active",
  currentPeriodStart: FIXED_PERIOD_START.toISOString(),
  currentPeriodEnd: FIXED_PERIOD_END.toISOString(),
  cancelAtPeriodEnd: false,
  createdAt: FIXED_CREATED.toISOString(),
  modifiedAt: FIXED_MODIFIED.toISOString(),
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  _et: "SubscriptionRecord",
  ...overrides,
});

describe("DynamoDbSubscriptionRepo", () => {
  let repo: DynamoDbSubscriptionRepo;
  const mockDocumentClient = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    mockDocumentClient.reset();

    const table = DynamoMainTable.create({
      // @ts-expect-error mocking DynamoDBDocumentClient
      documentClient: mockDocumentClient,
      tableName: "stripe-test-table",
    });

    const entity = DynamoDbSubscription.createEntity(table);

    repo = new DynamoDbSubscriptionRepo({ entity });
  });

  describe("upsert", () => {
    it("returns ok(null) when DynamoDB write succeeds", async () => {
      mockDocumentClient.on(PutCommand, {}).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.upsert(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns FailedWritingSubscriptionError on non-200 response", async () => {
      mockDocumentClient.on(PutCommand, {}).resolvesOnce({
        $metadata: { httpStatusCode: 500 },
      });

      const result = await repo.upsert(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedWritingSubscriptionError,
      );
    });

    it("returns FailedWritingSubscriptionError when SDK throws", async () => {
      mockDocumentClient.on(PutCommand, {}).rejectsOnce(new Error("boom"));

      const result = await repo.upsert(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedWritingSubscriptionError,
      );
    });
  });

  describe("getBySubscriptionId", () => {
    it("returns SubscriptionRecord round-trip when found", async () => {
      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          Item: buildDynamoRow(),
          $metadata: { httpStatusCode: 200 },
        });

      const result = await repo.getBySubscriptionId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeSubscriptionId,
      );

      const record = result._unsafeUnwrap();

      expect(record).toBeInstanceOf(SubscriptionRecord);
      expect(record!.stripeSubscriptionId).toBe(stripeSubscriptionId);
      expect(record!.stripeCustomerId).toBe(stripeCustomerId);
      expect(record!.fiefUserId).toBe(fiefUserId);
      expect(record!.status).toBe("active");
      expect(record!.cancelAtPeriodEnd).toBe(false);
      expect(record!.currentPeriodStart.toISOString()).toBe(FIXED_PERIOD_START.toISOString());
      expect(record!.currentPeriodEnd.toISOString()).toBe(FIXED_PERIOD_END.toISOString());
      expect(record!.lastInvoiceId).toBeNull();
      expect(record!.lastSaleorOrderId).toBeNull();
    });

    it("returns ok(null) when no item found in DynamoDB", async () => {
      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          $metadata: { httpStatusCode: 200 },
        });

      const result = await repo.getBySubscriptionId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeSubscriptionId,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns FailedFetchingSubscriptionError on non-200 status", async () => {
      mockDocumentClient
        .on(GetCommand, {
          Key: { PK: PK_VALUE, SK: SK_VALUE },
        })
        .resolvesOnce({
          $metadata: { httpStatusCode: 500 },
        });

      const result = await repo.getBySubscriptionId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeSubscriptionId,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedFetchingSubscriptionError,
      );
    });
  });

  describe("getByCustomerId", () => {
    it("returns matching SubscriptionRecord via Query+filter", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [buildDynamoRow()],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.getByCustomerId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeCustomerId,
      );

      const record = result._unsafeUnwrap();

      expect(record).toBeInstanceOf(SubscriptionRecord);
      expect(record!.stripeCustomerId).toBe(stripeCustomerId);
      expect(record!.stripeSubscriptionId).toBe(stripeSubscriptionId);
    });

    it("returns ok(null) when no match found", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.getByCustomerId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeCustomerId,
      );

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns FailedFetchingSubscriptionError on SDK throw", async () => {
      mockDocumentClient.on(QueryCommand).rejectsOnce(new Error("boom"));

      const result = await repo.getByCustomerId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeCustomerId,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedFetchingSubscriptionError,
      );
    });
  });

  describe("getByFiefUserId", () => {
    it("returns matching SubscriptionRecord via Query+filter", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [buildDynamoRow()],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.getByFiefUserId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        fiefUserId,
      );

      const record = result._unsafeUnwrap();

      expect(record).toBeInstanceOf(SubscriptionRecord);
      expect(record!.fiefUserId).toBe(fiefUserId);
      expect(record!.stripeSubscriptionId).toBe(stripeSubscriptionId);
    });

    it("returns ok(null) when no match found", async () => {
      mockDocumentClient.on(QueryCommand).resolvesOnce({
        Items: [],
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.getByFiefUserId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        fiefUserId,
      );

      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  /*
   * -------------------------------------------------------------------------
   * T31 Layer A — markInvoiceProcessed conditional Put
   *
   * Wire-level shape:
   *   PutItem with ConditionExpression
   *     `attribute_not_exists(#0) OR #0 <> :0` (where #0 = lastInvoiceId)
   *
   * Outcomes:
   *   - PutItem returns 200 → Ok('updated')
   *   - PutItem throws ConditionalCheckFailedException → Ok('already_processed')
   *   - PutItem throws other AWS error → Err(FailedWritingSubscriptionError)
   *
   * The "different cycle" case verifies that a NEW invoice id (cycle N+1)
   * also passes the condition because `lastInvoiceId <> :newInvoiceId` is true.
   * -------------------------------------------------------------------------
   */
  describe("markInvoiceProcessed (T31 Layer A)", () => {
    const NEW_INVOICE_ID = "in_T31_NEW_001";

    const buildClaimRecord = (overrides?: { lastInvoiceId?: string }) =>
      new SubscriptionRecord({
        stripeSubscriptionId,
        stripeCustomerId,
        saleorChannelSlug,
        saleorUserId,
        fiefUserId,
        saleorEntityId: null,
        stripePriceId,
        status: "active",
        currentPeriodStart: FIXED_PERIOD_START,
        currentPeriodEnd: FIXED_PERIOD_END,
        cancelAtPeriodEnd: false,
        lastInvoiceId: overrides?.lastInvoiceId ?? NEW_INVOICE_ID,
        lastSaleorOrderId: null,
        createdAt: FIXED_CREATED,
        updatedAt: FIXED_MODIFIED,
      });

    it("succeeds with 'updated' when no prior invoice (attribute_not_exists arm wins)", async () => {
      mockDocumentClient.on(PutCommand).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildClaimRecord(),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("updated");

      /*
       * Sanity check: the underlying PutItem carried a ConditionExpression
       * mentioning attribute_not_exists and OR `<>` over `lastInvoiceId`.
       */
      const putCall = mockDocumentClient.commandCalls(PutCommand)[0];
      const expr = (putCall.args[0].input as { ConditionExpression?: string }).ConditionExpression;

      expect(expr).toBeDefined();
      // dynamodb-toolbox alias-substitutes attr names → assert structure.
      expect(expr).toMatch(/attribute_not_exists/);
      expect(expr).toMatch(/<>/);
      /*
       * The attribute name appears as a placeholder like `#1_1` in the
       * ConditionExpression with `lastInvoiceId` resolved via
       * `ExpressionAttributeNames`. Check the names map for the field.
       */
      const names = (
        putCall.args[0].input as {
          ExpressionAttributeNames?: Record<string, string>;
        }
      ).ExpressionAttributeNames;

      expect(Object.values(names ?? {})).toContain("lastInvoiceId");
    });

    it("returns 'already_processed' when prior invoice matches (ConditionalCheckFailedException)", async () => {
      mockDocumentClient.on(PutCommand).rejectsOnce(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildClaimRecord(),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("already_processed");
    });

    it("succeeds with 'updated' when prior invoice differs (cycle N+1; ne arm wins)", async () => {
      mockDocumentClient.on(PutCommand).resolvesOnce({
        $metadata: { httpStatusCode: 200 },
      });

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildClaimRecord({ lastInvoiceId: "in_T31_CYCLE_2" }),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("updated");
    });

    it("returns FailedWritingSubscriptionError for non-conditional AWS errors", async () => {
      mockDocumentClient.on(PutCommand).rejectsOnce(new Error("ProvisionedThroughputExceeded"));

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildClaimRecord(),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedWritingSubscriptionError,
      );
    });

    it("rejects calls without lastInvoiceId on the record (defensive misuse guard)", async () => {
      const recordWithoutInvoice = new SubscriptionRecord({
        stripeSubscriptionId,
        stripeCustomerId,
        saleorChannelSlug,
        saleorUserId,
        fiefUserId,
        saleorEntityId: null,
        stripePriceId,
        status: "active",
        currentPeriodStart: FIXED_PERIOD_START,
        currentPeriodEnd: FIXED_PERIOD_END,
        cancelAtPeriodEnd: false,
        lastInvoiceId: null, // ← misuse
        lastSaleorOrderId: null,
        createdAt: FIXED_CREATED,
        updatedAt: FIXED_MODIFIED,
      });

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        recordWithoutInvoice,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedWritingSubscriptionError,
      );
      // No PutItem should have been issued.
      expect(mockDocumentClient.commandCalls(PutCommand)).toHaveLength(0);
    });
  });
});
