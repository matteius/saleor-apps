/**
 * DynamoDB implementation of {@link RefundDlqRepo} (T17).
 *
 * Mirrors `dynamodb-price-variant-map-repo.ts` and uses the shared
 * `DynamoMainTable` via the entities from `refund-dlq-db-model.ts`.
 *
 * Both writes are PutItem operations keyed by `stripeChargeId` — duplicate
 * deliveries simply overwrite the prior attempt with a refreshed timestamp.
 */
import { PutItemCommand } from "dynamodb-toolbox";
import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  type FailedRefundEntry,
  type PendingRefundReviewEntry,
  type RefundDlqAccess,
  type RefundDlqRepo,
  RefundDlqRepoError,
} from "../refund-dlq-repo";
import {
  DynamoDbFailedRefund,
  type DynamoDbFailedRefundEntity,
  DynamoDbPendingRefundReview,
  type DynamoDbPendingRefundReviewEntity,
} from "./refund-dlq-db-model";

export class DynamoDbRefundDlqRepo implements RefundDlqRepo {
  private failedRefundEntity: DynamoDbFailedRefundEntity;
  private pendingReviewEntity: DynamoDbPendingRefundReviewEntity;
  private logger = createLogger("DynamoDbRefundDlqRepo");

  constructor(
    params = {
      failedRefundEntity: DynamoDbFailedRefund.entity,
      pendingReviewEntity: DynamoDbPendingRefundReview.entity,
    },
  ) {
    this.failedRefundEntity = params.failedRefundEntity;
    this.pendingReviewEntity = params.pendingReviewEntity;
  }

  async recordFailedRefund(
    access: RefundDlqAccess,
    entry: FailedRefundEntry,
  ): Promise<Result<null, RefundDlqRepoError>> {
    try {
      const operation = this.failedRefundEntity.build(PutItemCommand).item({
        PK: DynamoDbFailedRefund.accessPattern.getPK(access),
        SK: DynamoDbFailedRefund.accessPattern.getSKforSpecificItem({
          stripeChargeId: entry.stripeChargeId,
        }),
        stripeChargeId: entry.stripeChargeId,
        invoiceId: entry.invoiceId,
        refundAmountCents: entry.refundAmountCents,
        currency: entry.currency,
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode === 200) {
        return ok(null);
      }

      throw new BaseError("Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode, {
        cause: result,
      });
    } catch (e) {
      this.logger.error("Failed to write failed-refund DLQ entry to DynamoDB", { error: e });

      return err(
        new RefundDlqRepoError.PersistenceFailedError(
          "Failed to write failed-refund DLQ entry to DynamoDB",
          { cause: e },
        ),
      );
    }
  }

  async recordPendingReview(
    access: RefundDlqAccess,
    entry: PendingRefundReviewEntry,
  ): Promise<Result<null, RefundDlqRepoError>> {
    try {
      const operation = this.pendingReviewEntity.build(PutItemCommand).item({
        PK: DynamoDbPendingRefundReview.accessPattern.getPK(access),
        SK: DynamoDbPendingRefundReview.accessPattern.getSKforSpecificItem({
          stripeChargeId: entry.stripeChargeId,
        }),
        stripeChargeId: entry.stripeChargeId,
        invoiceId: entry.invoiceId,
        saleorOrderId: entry.saleorOrderId,
        refundAmountCents: entry.refundAmountCents,
        capturedAmountCents: entry.capturedAmountCents,
        currency: entry.currency,
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode === 200) {
        return ok(null);
      }

      throw new BaseError("Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode, {
        cause: result,
      });
    } catch (e) {
      this.logger.error("Failed to write pending-refund-review entry to DynamoDB", { error: e });

      return err(
        new RefundDlqRepoError.PersistenceFailedError(
          "Failed to write pending-refund-review entry to DynamoDB",
          { cause: e },
        ),
      );
    }
  }
}
