import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import {
  type FailedRefundEntry,
  type PendingRefundReviewEntry,
  RefundDlqRepoError,
} from "../refund-dlq-repo";

/*
 * In-memory mock of the parts of the `mongodb` driver this repo touches.
 * Keeps tests deterministic and free of external infra — mirrors the strategy
 * used by the dynamodb sibling tests via `aws-sdk-client-mock`, but for Mongo.
 */
const collectionStore = new Map<string, Record<string, unknown>>();

const keyFor = (filter: Record<string, unknown>) =>
  [filter.saleorApiUrl, filter.appId, filter.kind, filter.stripeChargeId].join("::");

const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>) =>
  Object.entries(filter).every(([k, v]) => doc[k] === v);

const createIndexImpl = async () => "index_created";
const replaceOneImpl = async (
  filter: Record<string, unknown>,
  replacement: Record<string, unknown>,
  _options?: unknown,
) => {
  collectionStore.set(keyFor(filter), { ...replacement });

  return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
};
const findOneImpl = async (filter: Record<string, unknown>) => {
  for (const doc of collectionStore.values()) {
    if (matches(doc, filter)) return doc;
  }

  return null;
};

const createIndex = vi.fn(createIndexImpl);
const replaceOne = vi.fn(replaceOneImpl);
const findOne = vi.fn(findOneImpl);

const collection = { createIndex, replaceOne, findOne };
const db = { collection: vi.fn(() => collection) };
const mongoClientInstance = {
  connect: vi.fn(async () => undefined),
  db: vi.fn(() => db),
  close: vi.fn(async () => undefined),
};

vi.mock("mongodb", () => ({
  MongoClient: vi.fn(() => mongoClientInstance),
}));

vi.stubEnv("MONGODB_URL", "mongodb://localhost:27017/test");
vi.stubEnv("MONGODB_DATABASE", "saleor_stripe_test");

// Import after the mock + env stubs so the module sees the patched mongodb.
const { MongodbRefundDlqRepo } = await import("./mongodb-refund-dlq-repo");
const mongodbModule = await import("mongodb");
const MongoClientMock = mongodbModule.MongoClient as unknown as ReturnType<typeof vi.fn>;

const access = { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId };

const failedEntry: FailedRefundEntry = {
  stripeChargeId: "ch_test_failed_001",
  invoiceId: "in_test_failed_001",
  refundAmountCents: 4900,
  currency: "usd",
};

const pendingEntry: PendingRefundReviewEntry = {
  stripeChargeId: "ch_test_pending_001",
  invoiceId: "in_test_pending_001",
  saleorOrderId: "T3JkZXI6MQ==",
  refundAmountCents: 1000,
  capturedAmountCents: 4900,
  currency: "usd",
};

describe("MongodbRefundDlqRepo", () => {
  let repo: InstanceType<typeof MongodbRefundDlqRepo>;

  beforeEach(() => {
    collectionStore.clear();
    /*
     * setup.units.ts uses `mockReset: true` which strips implementations from
     * every vi.fn() between tests; rebind ours so the in-memory store works.
     */
    createIndex.mockImplementation(createIndexImpl);
    replaceOne.mockImplementation(replaceOneImpl);
    findOne.mockImplementation(findOneImpl);
    db.collection.mockImplementation(() => collection);
    mongoClientInstance.connect.mockImplementation(async () => undefined);
    mongoClientInstance.db.mockImplementation(() => db);
    mongoClientInstance.close.mockImplementation(async () => undefined);
    MongoClientMock.mockImplementation(() => mongoClientInstance);
    repo = new MongodbRefundDlqRepo();
  });

  it("recordFailedRefund writes the entry under kind=failed-refund and is round-trippable", async () => {
    const result = await repo.recordFailedRefund(access, failedEntry);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();

    const stored = await findOne({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      kind: "failed-refund",
      stripeChargeId: failedEntry.stripeChargeId,
    });

    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      kind: "failed-refund",
      stripeChargeId: failedEntry.stripeChargeId,
      invoiceId: failedEntry.invoiceId,
      refundAmountCents: 4900,
      currency: "usd",
    });
  });

  it("recordPendingReview writes the entry under kind=pending-refund-review with order/captured fields", async () => {
    const result = await repo.recordPendingReview(access, pendingEntry);

    expect(result.isOk()).toBe(true);

    const stored = await findOne({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      kind: "pending-refund-review",
      stripeChargeId: pendingEntry.stripeChargeId,
    });

    expect(stored).toMatchObject({
      kind: "pending-refund-review",
      stripeChargeId: pendingEntry.stripeChargeId,
      saleorOrderId: pendingEntry.saleorOrderId,
      refundAmountCents: 1000,
      capturedAmountCents: 4900,
      currency: "usd",
    });
  });

  it("duplicate recordFailedRefund overwrites the prior row (PutItem-style upsert)", async () => {
    await repo.recordFailedRefund(access, failedEntry);
    const secondResult = await repo.recordFailedRefund(access, {
      ...failedEntry,
      refundAmountCents: 5000,
    });

    expect(secondResult.isOk()).toBe(true);

    // Same compound key -> single row.
    const allFailed = [...collectionStore.values()].filter(
      (d) => d.kind === "failed-refund" && d.stripeChargeId === failedEntry.stripeChargeId,
    );

    expect(allFailed).toHaveLength(1);
    expect(allFailed[0].refundAmountCents).toBe(5000);
  });

  it("duplicate recordPendingReview overwrites the prior row", async () => {
    await repo.recordPendingReview(access, pendingEntry);
    await repo.recordPendingReview(access, {
      ...pendingEntry,
      refundAmountCents: 1234,
    });

    const allPending = [...collectionStore.values()].filter(
      (d) => d.kind === "pending-refund-review" && d.stripeChargeId === pendingEntry.stripeChargeId,
    );

    expect(allPending).toHaveLength(1);
    expect(allPending[0].refundAmountCents).toBe(1234);
  });

  it("the two queues coexist in the same collection segregated by kind", async () => {
    /*
     * Same stripeChargeId on both kinds — the (kind, chargeId) compound key
     * means they live as two separate rows.
     */
    const sharedChargeId = "ch_test_shared";

    await repo.recordFailedRefund(access, { ...failedEntry, stripeChargeId: sharedChargeId });
    await repo.recordPendingReview(access, { ...pendingEntry, stripeChargeId: sharedChargeId });

    expect(collectionStore.size).toBe(2);

    const failed = await findOne({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      kind: "failed-refund",
      stripeChargeId: sharedChargeId,
    });
    const pending = await findOne({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      kind: "pending-refund-review",
      stripeChargeId: sharedChargeId,
    });

    expect(failed?.kind).toBe("failed-refund");
    expect(pending?.kind).toBe("pending-refund-review");
  });

  it("returns PersistenceFailedError when the underlying replaceOne throws", async () => {
    replaceOne.mockRejectedValueOnce(new Error("mongo down"));

    const result = await repo.recordFailedRefund(access, failedEntry);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(RefundDlqRepoError.PersistenceFailedError);
  });
});
