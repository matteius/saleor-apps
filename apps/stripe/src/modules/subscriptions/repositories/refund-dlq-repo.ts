/**
 * Refund operational-queue repository (T17).
 *
 * Two queues with intentionally narrow surfaces — the dispatcher only ever
 * needs to **write** to them on the webhook hot path. A future ops-dashboard
 * task will add list/delete operations.
 *
 * - {@link RefundDlqRepo.recordFailedRefund}: cache miss path. The
 *   `charge.refunded` arrived but no `SaleorOrderImport` is yet known for
 *   the underlying invoice; record the charge id + refund amount so the
 *   later `invoice.paid` (or a manual ops sweep) can resolve it.
 *
 * - {@link RefundDlqRepo.recordPendingReview}: partial-refund path. We
 *   intentionally do NOT auto-void on partial subscription refunds; record
 *   the order id + amount so ops can decide what to do (issue a credit
 *   memo, prorate the next invoice, etc.).
 */
import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

export const RefundDlqRepoError = {
  PersistenceFailedError: BaseError.subclass("RefundDlqRepo.PersistenceFailedError", {
    props: {
      _internalName: "RefundDlqRepo.PersistenceFailedError" as const,
    },
  }),
};

export type RefundDlqRepoError = InstanceType<typeof RefundDlqRepoError.PersistenceFailedError>;

export interface RefundDlqAccess {
  saleorApiUrl: SaleorApiUrl;
  appId: string;
}

export interface FailedRefundEntry {
  stripeChargeId: string;
  invoiceId: string;
  refundAmountCents: number;
  currency: string;
}

export interface PendingRefundReviewEntry {
  stripeChargeId: string;
  invoiceId: string;
  saleorOrderId: string;
  refundAmountCents: number;
  capturedAmountCents: number;
  currency: string;
}

export interface RefundDlqRepo {
  recordFailedRefund(
    access: RefundDlqAccess,
    entry: FailedRefundEntry,
  ): Promise<Result<null, RefundDlqRepoError>>;

  recordPendingReview(
    access: RefundDlqAccess,
    entry: PendingRefundReviewEntry,
  ): Promise<Result<null, RefundDlqRepoError>>;
}
