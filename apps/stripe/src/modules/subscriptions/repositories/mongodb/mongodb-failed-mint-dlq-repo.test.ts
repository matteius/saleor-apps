import { type Collection } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import { FailedMintDlqRepoError, type FailedMintRecord } from "../failed-mint-dlq-repo";
import { MongodbFailedMintDlqRepo } from "./mongodb-failed-mint-dlq-repo";

const TEST_INVOICE_ID = "in_test_T32_001";

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

const _buildDoc = (overrides: Partial<FailedMintRecord> = {}) => ({
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  ...buildRecord(overrides),
});

/**
 * In-memory Collection stand-in. We model the unique compound index on
 * (saleorApiUrl, appId, stripeInvoiceId) so re-recording the same invoice id
 * collapses to a single row — exactly the property the cron retry job relies
 * on for idempotency.
 */
const buildFakeCollection = () => {
  type Doc = ReturnType<typeof _buildDoc> & { finalFailureAlertedAt?: number };
  const store: Doc[] = [];

  const matches = (doc: Doc, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([k, v]) => {
      if (k === "nextRetryAt" && v && typeof v === "object" && "$lte" in v) {
        return doc.nextRetryAt <= (v as { $lte: number }).$lte;
      }

      return (doc as unknown as Record<string, unknown>)[k] === v;
    });

  const collection = {
    createIndex: vi.fn().mockResolvedValue("idx"),
    replaceOne: vi.fn(async (filter: Record<string, unknown>, doc: Doc) => {
      const idx = store.findIndex((d) => matches(d, filter));

      if (idx >= 0) {
        store[idx] = doc;

        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      store.push(doc);

      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }),
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      return store.find((d) => matches(d, filter)) ?? null;
    }),
    find: vi.fn((filter: Record<string, unknown>) => ({
      toArray: async () => store.filter((d) => matches(d, filter)),
    })),
    deleteOne: vi.fn(async (filter: Record<string, unknown>) => {
      const idx = store.findIndex((d) => matches(d, filter));

      if (idx >= 0) {
        store.splice(idx, 1);

        return { deletedCount: 1 };
      }

      return { deletedCount: 0 };
    }),
    __store: store,
  };

  return collection as unknown as Collection<ReturnType<typeof _buildDoc>> & {
    __store: Doc[];
    replaceOne: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
};

describe("MongodbFailedMintDlqRepo", () => {
  let repo: MongodbFailedMintDlqRepo;
  let fake: ReturnType<typeof buildFakeCollection>;
  const access = { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId };

  beforeEach(() => {
    fake = buildFakeCollection();
    repo = new MongodbFailedMintDlqRepo({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collection: fake as unknown as Collection<any>,
    });
  });

  describe("record", () => {
    it("upserts a new entry and returns ok(null)", async () => {
      const result = await repo.record(access, buildRecord());

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
      expect(fake.__store).toHaveLength(1);
      expect(fake.__store[0].stripeInvoiceId).toBe(TEST_INVOICE_ID);
    });

    it("re-recording the same invoice id is idempotent — no duplicate row, attemptCount reflects latest write", async () => {
      await repo.record(access, buildRecord({ attemptCount: 1 }));
      await repo.record(access, buildRecord({ attemptCount: 2, lastAttemptAt: 1_715_000_900 }));
      await repo.record(access, buildRecord({ attemptCount: 3, lastAttemptAt: 1_715_001_500 }));

      expect(fake.__store).toHaveLength(1);
      expect(fake.__store[0].attemptCount).toBe(3);
      expect(fake.__store[0].lastAttemptAt).toBe(1_715_001_500);
    });

    it("returns PersistenceFailedError when the driver throws", async () => {
      fake.replaceOne.mockRejectedValueOnce(new Error("mongo down"));

      const result = await repo.record(access, buildRecord());

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });

  describe("getById", () => {
    it("returns ok(null) when no document exists", async () => {
      const result = await repo.getById(access, "in_does_not_exist");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns the persisted record after record() round-trip", async () => {
      await repo.record(access, buildRecord());

      const result = await repo.getById(access, TEST_INVOICE_ID);

      const value = result._unsafeUnwrap();

      expect(value).not.toBeNull();
      expect(value!.stripeInvoiceId).toBe(TEST_INVOICE_ID);
      expect(value!.attemptCount).toBe(1);
      expect(value!.errorClass).toBe("DraftOrderCreateFailedError");
    });
  });

  describe("listPendingRetries", () => {
    it("returns only entries whose nextRetryAt is at or before the cutoff", async () => {
      await repo.record(access, buildRecord({ stripeInvoiceId: "in_due_1", nextRetryAt: 100 }));
      await repo.record(access, buildRecord({ stripeInvoiceId: "in_due_2", nextRetryAt: 500 }));
      await repo.record(access, buildRecord({ stripeInvoiceId: "in_future", nextRetryAt: 9_999 }));

      const result = await repo.listPendingRetries(access, 1_000);

      const records = result._unsafeUnwrap();

      expect(records).toHaveLength(2);
      expect(records.map((r) => r.stripeInvoiceId).sort()).toStrictEqual(["in_due_1", "in_due_2"]);
    });

    it("returns ok([]) when nothing is due yet", async () => {
      await repo.record(access, buildRecord({ nextRetryAt: 9_999 }));

      const result = await repo.listPendingRetries(access, 1_000);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual([]);
    });
  });

  describe("delete", () => {
    it("removes the entry and subsequent getById returns null", async () => {
      await repo.record(access, buildRecord());

      const del = await repo.delete(access, TEST_INVOICE_ID);

      expect(del.isOk()).toBe(true);
      expect(fake.__store).toHaveLength(0);

      const got = await repo.getById(access, TEST_INVOICE_ID);

      expect(got._unsafeUnwrap()).toBeNull();
    });
  });

  describe("markFinalFailure", () => {
    it("sets finalFailureAlertedAt to current epoch seconds and preserves all other fields", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-09T12:00:00.000Z"));

      await repo.record(access, buildRecord());

      const result = await repo.markFinalFailure(access, TEST_INVOICE_ID);

      expect(result.isOk()).toBe(true);

      const got = await repo.getById(access, TEST_INVOICE_ID);
      const value = got._unsafeUnwrap();

      expect(value!.finalFailureAlertedAt).toBe(Math.floor(Date.UTC(2026, 4, 9, 12, 0, 0) / 1000));
      // Surrounding fields untouched.
      expect(value!.attemptCount).toBe(1);
      expect(value!.stripeSubscriptionId).toBe("sub_test_T32");

      vi.useRealTimers();
    });

    it("returns PersistenceFailedError when the entry does not exist", async () => {
      const result = await repo.markFinalFailure(access, "in_missing");

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        FailedMintDlqRepoError.PersistenceFailedError,
      );
    });
  });
});
