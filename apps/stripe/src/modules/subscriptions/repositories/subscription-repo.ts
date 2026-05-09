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

export interface SubscriptionRepo {
  upsert(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<null, SubscriptionRepoError>>;

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
