/**
 * DynamoDB schemas for the two refund operational queues introduced by T17.
 *
 * Both share the single-table `DynamoMainTable` design used by every other
 * subscription cache row (T8, T10).
 *
 * 1. **failed-refund DLQ** — written when a `charge.refunded` webhook arrives
 *    but no `SaleorOrderImport`/cache record can be found for the underlying
 *    invoice. Out-of-order delivery: the corresponding `invoice.paid` likely
 *    landed after the refund, or never landed. A retry job (future task)
 *    sweeps this set after the matching `invoice.paid` lands. The plan
 *    intentionally keeps this minimal — just enough for ops to manually
 *    resolve.
 *
 *      PK = saleorApiUrl#appId
 *      SK = failed-refund#${stripeChargeId}
 *
 * 2. **pending-refund-review** — written for *partial* subscription refunds.
 *    We deliberately do NOT auto-void on partial refunds (that would cancel
 *    the entire Saleor order) and instead surface them for ops/CS review.
 *
 *      PK = saleorApiUrl#appId
 *      SK = pending-refund-review#${stripeChargeId}
 *
 * Both rows record `attemptedAt` via dynamodb-toolbox's automatic
 * `createdAt`/`modifiedAt` timestamps.
 *
 * GSI strategy: same as T8/T10 — none. Direct PK+SK lookups by chargeId or
 * partition-scoped Query for ops dashboards. No new table, no new GSI.
 */
import { Entity, item, number, string } from "dynamodb-toolbox";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

class FailedRefundAccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificItem({ stripeChargeId }: { stripeChargeId: string }) {
    return `failed-refund#${stripeChargeId}` as const;
  }

  static getSKforAllFailedRefunds() {
    return `failed-refund#` as const;
  }
}

class PendingRefundReviewAccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificItem({ stripeChargeId }: { stripeChargeId: string }) {
    return `pending-refund-review#${stripeChargeId}` as const;
  }

  static getSKforAllPendingReviews() {
    return `pending-refund-review#` as const;
  }
}

const FailedRefundSchema = item({
  PK: string().key(),
  SK: string().key(),
  stripeChargeId: string(),
  invoiceId: string(),
  refundAmountCents: number(),
  currency: string(),
});

const PendingRefundReviewSchema = item({
  PK: string().key(),
  SK: string().key(),
  stripeChargeId: string(),
  invoiceId: string(),
  saleorOrderId: string(),
  refundAmountCents: number(),
  capturedAmountCents: number(),
  currency: string(),
});

const createFailedRefundEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "FailedRefundDlq",
    schema: FailedRefundSchema,
    timestamps: {
      created: { name: "attemptedAt", savedAs: "attemptedAt" },
      modified: { name: "modifiedAt", savedAs: "modifiedAt" },
    },
  });
};

const createPendingRefundReviewEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "PendingRefundReview",
    schema: PendingRefundReviewSchema,
    timestamps: {
      created: { name: "attemptedAt", savedAs: "attemptedAt" },
      modified: { name: "modifiedAt", savedAs: "modifiedAt" },
    },
  });
};

const failedRefundEntity = createFailedRefundEntity(dynamoMainTable);
const pendingRefundReviewEntity = createPendingRefundReviewEntity(dynamoMainTable);

export type DynamoDbFailedRefundEntity = typeof failedRefundEntity;
export type DynamoDbPendingRefundReviewEntity = typeof pendingRefundReviewEntity;

export const DynamoDbFailedRefund = {
  accessPattern: {
    getPK: FailedRefundAccessPattern.getPK,
    getSKforSpecificItem: FailedRefundAccessPattern.getSKforSpecificItem,
    getSKforAllFailedRefunds: FailedRefundAccessPattern.getSKforAllFailedRefunds,
  },
  entitySchema: FailedRefundSchema,
  createEntity: createFailedRefundEntity,
  entity: failedRefundEntity,
};

export const DynamoDbPendingRefundReview = {
  accessPattern: {
    getPK: PendingRefundReviewAccessPattern.getPK,
    getSKforSpecificItem: PendingRefundReviewAccessPattern.getSKforSpecificItem,
    getSKforAllPendingReviews: PendingRefundReviewAccessPattern.getSKforAllPendingReviews,
  },
  entitySchema: PendingRefundReviewSchema,
  createEntity: createPendingRefundReviewEntity,
  entity: pendingRefundReviewEntity,
};
