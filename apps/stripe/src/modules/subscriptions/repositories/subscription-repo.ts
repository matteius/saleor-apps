/**
 * Subscription repository interface.
 *
 * Mirrors `transactions-recording/repositories/transaction-recorder-repo.ts`.
 *
 * Methods return `Result<SubscriptionRecord | null, SubscriptionRepoError>` —
 * "missing" is a valid (non-error) lookup outcome for cache reads, distinct
 * from the transaction-recorder's invariant where missing implies an error.
 */
import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type FiefUserId,
  type StripeCustomerId,
  type StripeSubscriptionId,
  type SubscriptionRecord,
} from "./subscription-record";

export const SubscriptionRepoError = {
  PersistenceNotAvailable: BaseError.subclass("SubscriptionRepo.PersistenceNotAvailableError", {
    props: {
      _internalName: "SubscriptionRepo.PersistenceNotAvailableError",
    },
  }),
  FailedWritingSubscriptionError: BaseError.subclass(
    "SubscriptionRepo.FailedWritingSubscriptionError",
    {
      props: {
        _internalName: "SubscriptionRepo.FailedWritingSubscriptionError",
      },
    },
  ),
  FailedFetchingSubscriptionError: BaseError.subclass(
    "SubscriptionRepo.FailedFetchingSubscriptionError",
    {
      props: {
        _internalName: "SubscriptionRepo.FailedFetchingSubscriptionError",
      },
    },
  ),
};

export type SubscriptionRepoError = InstanceType<
  | typeof SubscriptionRepoError.PersistenceNotAvailable
  | typeof SubscriptionRepoError.FailedWritingSubscriptionError
  | typeof SubscriptionRepoError.FailedFetchingSubscriptionError
>;

export type SubscriptionRepoAccess = {
  saleorApiUrl: SaleorApiUrl;
  appId: string;
};

/**
 * Outcome of {@link SubscriptionRepo.markInvoiceProcessed}:
 *  - `'updated'`: the conditional Put succeeded; this caller "won" the race
 *    and should be the only one to mint the Saleor order for this invoice.
 *  - `'already_processed'`: the cache already had `lastInvoiceId === invoiceId`
 *    (a concurrent webhook delivery beat us to it). Caller MUST NOT re-mint.
 *
 * T31 Layer A — see invoice-handler.ts for the full layered defense narrative.
 */
export type MarkInvoiceProcessedOutcome = "updated" | "already_processed";

export interface SubscriptionRepo {
  upsert(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<null, SubscriptionRepoError>>;

  /**
   * Race-safe claim on `lastInvoiceId` for the given subscription record.
   * Implementation MUST use a DynamoDB conditional Put with the predicate
   * `attribute_not_exists(lastInvoiceId) OR lastInvoiceId <> :newInvoiceId`
   * (express in dynamodb-toolbox as `condition: { or: [{ attr: 'lastInvoiceId',
   * exists: false }, { attr: 'lastInvoiceId', ne: <new> }] }`). On
   * `ConditionalCheckFailedException` it MUST resolve `Ok('already_processed')`,
   * NOT `Err`.
   *
   * The `subscription` argument should be the FULL desired-post-state record
   * (typically: previous fields + new `lastInvoiceId` + new `lastSaleorOrderId`),
   * because Put overwrites the entire item. Pre-mint claim use the previous
   * `lastSaleorOrderId` value (or null) here, and follow up with a plain
   * `upsert` after mint succeeds to record the new Saleor order id.
   *
   * T31 Layer A. Layer 1 is the in-memory check on the read record;
   * Layer 2 is OwlBooks Postgres `SaleorOrderImport.stripeInvoiceId @unique`.
   */
  markInvoiceProcessed(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<MarkInvoiceProcessedOutcome, SubscriptionRepoError>>;

  getBySubscriptionId(
    accessPattern: SubscriptionRepoAccess,
    stripeSubscriptionId: StripeSubscriptionId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>>;

  getByCustomerId(
    accessPattern: SubscriptionRepoAccess,
    stripeCustomerId: StripeCustomerId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>>;

  getByFiefUserId(
    accessPattern: SubscriptionRepoAccess,
    fiefUserId: FiefUserId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>>;
}
