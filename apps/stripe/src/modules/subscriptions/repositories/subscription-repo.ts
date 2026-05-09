/**
 * Subscription repository interface.
 *
 * Mirrors `transactions-recording/repositories/transaction-recorder-repo.ts`.
 *
 * To be fully implemented in T8.
 */
import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type SubscriptionRecord } from "./subscription-record";

export const TODO_T8_SUBSCRIPTION_REPO = "implement in T8";

export const SubscriptionRepoError = {
  PersistenceNotAvailable: BaseError.subclass("SubscriptionRepo.PersistenceNotAvailableError", {
    props: {
      _internalName: "SubscriptionRepo.PersistenceNotAvailableError",
    },
  }),
  SubscriptionMissingError: BaseError.subclass("SubscriptionRepo.SubscriptionMissingError", {
    props: {
      _internalName: "SubscriptionRepo.SubscriptionMissingError",
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
  | typeof SubscriptionRepoError.SubscriptionMissingError
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
    stripeSubscriptionId: string,
  ): Promise<Result<SubscriptionRecord, SubscriptionRepoError>>;

  getByCustomerId(
    accessPattern: SubscriptionRepoAccess,
    stripeCustomerId: string,
  ): Promise<Result<SubscriptionRecord, SubscriptionRepoError>>;

  getByFiefUserId(
    accessPattern: SubscriptionRepoAccess,
    fiefUserId: string,
  ): Promise<Result<SubscriptionRecord, SubscriptionRepoError>>;
}
