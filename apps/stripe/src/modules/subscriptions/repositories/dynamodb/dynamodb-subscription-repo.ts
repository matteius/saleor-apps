/**
 * DynamoDB implementation of `SubscriptionRepo`.
 *
 * Mirrors `dynamodb-transaction-recorder-repo.ts`. Concrete implementation
 * (entity wiring, conditional writes, lookups) lands in T8.
 *
 * To be fully implemented in T8.
 */
import { err, type Result } from "neverthrow";

import { type SubscriptionRecord } from "../subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
  SubscriptionRepoError,
} from "../subscription-repo";

export const TODO_T8_DYNAMODB_SUBSCRIPTION_REPO = "implement in T8";

export class DynamoDbSubscriptionRepo implements SubscriptionRepo {
  async upsert(
    _accessPattern: SubscriptionRepoAccess,
    _subscription: SubscriptionRecord,
  ): Promise<Result<null, SubscriptionRepoError>> {
    return err(new SubscriptionRepoError.FailedWritingSubscriptionError("T8 not implemented"));
  }

  async getBySubscriptionId(
    _accessPattern: SubscriptionRepoAccess,
    _stripeSubscriptionId: string,
  ): Promise<Result<SubscriptionRecord, SubscriptionRepoError>> {
    return err(new SubscriptionRepoError.FailedFetchingSubscriptionError("T8 not implemented"));
  }

  async getByCustomerId(
    _accessPattern: SubscriptionRepoAccess,
    _stripeCustomerId: string,
  ): Promise<Result<SubscriptionRecord, SubscriptionRepoError>> {
    return err(new SubscriptionRepoError.FailedFetchingSubscriptionError("T8 not implemented"));
  }

  async getByFiefUserId(
    _accessPattern: SubscriptionRepoAccess,
    _fiefUserId: string,
  ): Promise<Result<SubscriptionRecord, SubscriptionRepoError>> {
    return err(new SubscriptionRepoError.FailedFetchingSubscriptionError("T8 not implemented"));
  }
}
