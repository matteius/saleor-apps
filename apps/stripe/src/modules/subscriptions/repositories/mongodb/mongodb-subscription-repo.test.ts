/**
 * MongoDB sibling of `dynamodb-subscription-repo.test.ts`.
 *
 * The stripe app does not depend on `mongodb-memory-server` (only the fief app
 * does); to avoid pulling in that ~150MB binary just for this suite we mock
 * the collection methods directly via the test seam exposed on the repo
 * constructor (`new MongodbSubscriptionRepo({ collection })`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../subscription-record";
import { SubscriptionRepoError } from "../subscription-repo";
import { MongodbSubscriptionRepo } from "./mongodb-subscription-repo";

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

const buildRecord = (overrides: { lastInvoiceId?: string | null } = {}) =>
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
    lastInvoiceId: overrides.lastInvoiceId ?? null,
    lastSaleorOrderId: null,
    createdAt: FIXED_CREATED,
    updatedAt: FIXED_MODIFIED,
  });

const buildMongoDoc = (overrides: Record<string, unknown> = {}) => ({
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  stripeSubscriptionId,
  stripeCustomerId,
  saleorChannelSlug,
  saleorUserId,
  fiefUserId,
  saleorEntityId: null,
  stripePriceId,
  status: "active",
  currentPeriodStart: FIXED_PERIOD_START.toISOString(),
  currentPeriodEnd: FIXED_PERIOD_END.toISOString(),
  cancelAtPeriodEnd: false,
  lastInvoiceId: null,
  lastSaleorOrderId: null,
  planName: null,
  createdAt: FIXED_CREATED.toISOString(),
  modifiedAt: FIXED_MODIFIED.toISOString(),
  ...overrides,
});

type MockCollection = {
  findOne: ReturnType<typeof vi.fn>;
  replaceOne: ReturnType<typeof vi.fn>;
  createIndex: ReturnType<typeof vi.fn>;
};

const buildMockCollection = (): MockCollection => ({
  findOne: vi.fn(),
  replaceOne: vi.fn().mockResolvedValue({ matchedCount: 1, upsertedId: null }),
  createIndex: vi.fn().mockResolvedValue("ok"),
});

describe("MongodbSubscriptionRepo", () => {
  let collection: MockCollection;
  let repo: MongodbSubscriptionRepo;

  beforeEach(() => {
    collection = buildMockCollection();
    repo = new MongodbSubscriptionRepo({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collection: collection as any,
    });
  });

  describe("upsert", () => {
    it("returns ok(null) when MongoDB write succeeds", async () => {
      collection.findOne.mockResolvedValueOnce(null); // no existing record → fresh createdAt
      collection.replaceOne.mockResolvedValueOnce({ matchedCount: 0, upsertedId: "new" });

      const result = await repo.upsert(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord(),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
      expect(collection.replaceOne).toHaveBeenCalledWith(
        {
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          stripeSubscriptionId,
        },
        expect.objectContaining({
          stripeSubscriptionId,
          stripeCustomerId,
          fiefUserId,
        }),
        { upsert: true },
      );
    });

    it("returns FailedWritingSubscriptionError when the driver throws", async () => {
      collection.findOne.mockResolvedValueOnce(null);
      collection.replaceOne.mockRejectedValueOnce(new Error("boom"));

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
      collection.findOne.mockResolvedValueOnce(buildMongoDoc());

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

    it("returns ok(null) when no document found", async () => {
      collection.findOne.mockResolvedValueOnce(null);

      const result = await repo.getBySubscriptionId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeSubscriptionId,
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns FailedFetchingSubscriptionError when the driver throws", async () => {
      collection.findOne.mockRejectedValueOnce(new Error("boom"));

      const result = await repo.getBySubscriptionId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeSubscriptionId,
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedFetchingSubscriptionError,
      );
    });
  });

  describe("getByCustomerId / getByFiefUserId (GSI-equivalent indexes)", () => {
    it("getByCustomerId looks up by (saleorApiUrl, appId, stripeCustomerId)", async () => {
      collection.findOne.mockResolvedValueOnce(buildMongoDoc());

      const result = await repo.getByCustomerId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeCustomerId,
      );

      expect(result._unsafeUnwrap()).toBeInstanceOf(SubscriptionRecord);
      expect(collection.findOne).toHaveBeenCalledWith({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        stripeCustomerId,
      });
    });

    it("getByFiefUserId looks up by (saleorApiUrl, appId, fiefUserId)", async () => {
      collection.findOne.mockResolvedValueOnce(buildMongoDoc());

      const result = await repo.getByFiefUserId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        fiefUserId,
      );

      expect(result._unsafeUnwrap()).toBeInstanceOf(SubscriptionRecord);
      expect(collection.findOne).toHaveBeenCalledWith({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        fiefUserId,
      });
    });

    it("returns ok(null) on miss", async () => {
      collection.findOne.mockResolvedValueOnce(null);

      const result = await repo.getByCustomerId(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeCustomerId,
      );

      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  /*
   * -------------------------------------------------------------------------
   * T31 Layer A — markInvoiceProcessed conditional write
   *
   * Outcomes the Mongo impl must surface, mirroring the DynamoDB contract:
   *   - record absent OR lastInvoiceId differs / null → Ok('updated')
   *   - record present AND lastInvoiceId matches      → Ok('already_processed')
   *   - duplicate-key (E11000) on race                 → Ok('already_processed')
   *   - any other driver error                         → Err(FailedWriting…)
   *   - misuse: no lastInvoiceId on record             → Err(FailedWriting…)
   * -------------------------------------------------------------------------
   */
  describe("markInvoiceProcessed (T31 Layer A)", () => {
    const NEW_INVOICE_ID = "in_T31_NEW_001";

    it("succeeds with 'updated' when no prior record exists", async () => {
      collection.findOne.mockResolvedValueOnce(null);
      collection.replaceOne.mockResolvedValueOnce({ matchedCount: 0, upsertedId: "new" });

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord({ lastInvoiceId: NEW_INVOICE_ID }),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("updated");
    });

    it("returns 'already_processed' when prior lastInvoiceId equals the new one", async () => {
      collection.findOne.mockResolvedValueOnce(buildMongoDoc({ lastInvoiceId: NEW_INVOICE_ID }));

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord({ lastInvoiceId: NEW_INVOICE_ID }),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("already_processed");
      // No write should have been issued — record already up-to-date.
      expect(collection.replaceOne).not.toHaveBeenCalled();
    });

    it("succeeds with 'updated' when prior invoice differs (cycle N+1)", async () => {
      collection.findOne.mockResolvedValueOnce(
        buildMongoDoc({ lastInvoiceId: "in_T31_PREV_CYCLE" }),
      );
      collection.replaceOne.mockResolvedValueOnce({ matchedCount: 1, upsertedId: null });

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord({ lastInvoiceId: NEW_INVOICE_ID }),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("updated");
    });

    it("returns 'already_processed' on E11000 duplicate-key (lost insert race)", async () => {
      collection.findOne.mockResolvedValueOnce(null);
      const dupErr = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

      collection.replaceOne.mockRejectedValueOnce(dupErr);

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord({ lastInvoiceId: NEW_INVOICE_ID }),
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("already_processed");
    });

    it("returns FailedWritingSubscriptionError on unexpected driver errors", async () => {
      collection.findOne.mockResolvedValueOnce(null);
      collection.replaceOne.mockRejectedValueOnce(new Error("network down"));

      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord({ lastInvoiceId: NEW_INVOICE_ID }),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedWritingSubscriptionError,
      );
    });

    it("rejects calls without lastInvoiceId on the record (defensive misuse guard)", async () => {
      const result = await repo.markInvoiceProcessed(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        buildRecord({ lastInvoiceId: null }),
      );

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SubscriptionRepoError.FailedWritingSubscriptionError,
      );
      // No driver call should have been issued at all.
      expect(collection.findOne).not.toHaveBeenCalled();
      expect(collection.replaceOne).not.toHaveBeenCalled();
    });
  });
});
