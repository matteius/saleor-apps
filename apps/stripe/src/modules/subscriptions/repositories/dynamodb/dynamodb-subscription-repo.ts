/**
 * DynamoDB implementation of `SubscriptionRepo`.
 *
 * Mirrors `dynamodb-transaction-recorder-repo.ts`. Uses the shared
 * `DynamoMainTable` via the entity from `subscription-db-model.ts`.
 *
 * Lookup strategy (see subscription-db-model.ts header for full rationale):
 *   - `getBySubscriptionId`: direct PK+SK GetItem (O(1))
 *   - `getByCustomerId`/`getByFiefUserId`: partition-scoped Query with a
 *     filter on the cached attribute (no GSI in the shared table; v1 fallback
 *     since OwlBooks subscription record count is low).
 */
import { GetItemCommand, Parser, PutItemCommand } from "dynamodb-toolbox";
import { QueryCommand } from "dynamodb-toolbox/table/actions/query";
import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  createFiefUserId,
  createSaleorChannelSlug,
  createSaleorEntityId,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  type FiefUserId,
  type StripeCustomerId,
  type StripeSubscriptionId,
  SubscriptionRecord,
  type SubscriptionStatus,
} from "../subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
  SubscriptionRepoError,
} from "../subscription-repo";
import { DynamoDbSubscription, type DynamoDbSubscriptionEntity } from "./subscription-db-model";

type ParsedRow = {
  PK: string;
  SK: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  saleorChannelSlug: string;
  saleorUserId: string;
  fiefUserId: string;
  saleorEntityId?: string;
  stripePriceId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  lastInvoiceId?: string;
  lastSaleorOrderId?: string;
  planName?: string;
  createdAt?: string;
  modifiedAt?: string;
};

const mapRowToRecord = (row: ParsedRow): SubscriptionRecord => {
  return new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId(row.stripeSubscriptionId),
    stripeCustomerId: createStripeCustomerId(row.stripeCustomerId),
    saleorChannelSlug: createSaleorChannelSlug(row.saleorChannelSlug),
    saleorUserId: row.saleorUserId,
    fiefUserId: createFiefUserId(row.fiefUserId),
    saleorEntityId: row.saleorEntityId ? createSaleorEntityId(row.saleorEntityId) : null,
    stripePriceId: createStripePriceId(row.stripePriceId),
    status: row.status as SubscriptionStatus,
    currentPeriodStart: new Date(row.currentPeriodStart),
    currentPeriodEnd: new Date(row.currentPeriodEnd),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    lastInvoiceId: row.lastInvoiceId ?? null,
    lastSaleorOrderId: row.lastSaleorOrderId ?? null,
    planName: row.planName ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    updatedAt: row.modifiedAt ? new Date(row.modifiedAt) : new Date(),
  });
};

export class DynamoDbSubscriptionRepo implements SubscriptionRepo {
  private entity: DynamoDbSubscriptionEntity;

  private logger = createLogger("DynamoDbSubscriptionRepo");

  constructor(
    params = {
      entity: DynamoDbSubscription.entity,
    },
  ) {
    this.entity = params.entity;
  }

  async upsert(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<null, SubscriptionRepoError>> {
    try {
      this.logger.debug("Upserting subscription record to DynamoDB", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      });

      const operation = this.entity.build(PutItemCommand).item({
        PK: DynamoDbSubscription.accessPattern.getPK(accessPattern),
        SK: DynamoDbSubscription.accessPattern.getSKforSpecificItem({
          stripeSubscriptionId: subscription.stripeSubscriptionId,
        }),
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        stripeCustomerId: subscription.stripeCustomerId,
        saleorChannelSlug: subscription.saleorChannelSlug,
        saleorUserId: subscription.saleorUserId,
        fiefUserId: subscription.fiefUserId,
        saleorEntityId: subscription.saleorEntityId ?? undefined,
        stripePriceId: subscription.stripePriceId,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart.toISOString(),
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        lastInvoiceId: subscription.lastInvoiceId ?? undefined,
        lastSaleorOrderId: subscription.lastSaleorOrderId ?? undefined,
        planName: subscription.planName ?? undefined,
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode === 200) {
        this.logger.debug("Successfully upserted subscription to DynamoDB", {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
        });

        return ok(null);
      }

      throw new BaseError("Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode, {
        cause: result,
      });
    } catch (e) {
      this.logger.error("Failed to upsert subscription to DynamoDB", {
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedWritingSubscriptionError(
          "Failed to upsert subscription to DynamoDB",
          {
            cause: e,
          },
        ),
      );
    }
  }

  async getBySubscriptionId(
    accessPattern: SubscriptionRepoAccess,
    stripeSubscriptionId: StripeSubscriptionId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    try {
      const operation = this.entity.build(GetItemCommand).key({
        PK: DynamoDbSubscription.accessPattern.getPK(accessPattern),
        SK: DynamoDbSubscription.accessPattern.getSKforSpecificItem({
          stripeSubscriptionId,
        }),
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode !== 200) {
        return err(
          new SubscriptionRepoError.FailedFetchingSubscriptionError(
            "Failed to read data from DynamoDB. HTTP status code: " +
              result.$metadata.httpStatusCode,
            {
              cause: result,
            },
          ),
        );
      }

      if (!result.Item) {
        return ok(null);
      }

      return ok(mapRowToRecord(result.Item as ParsedRow));
    } catch (e) {
      this.logger.error("Failed to fetch subscription by subscriptionId from DynamoDB", {
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedFetchingSubscriptionError(
          "Failed to fetch subscription from DynamoDB",
          {
            cause: e,
          },
        ),
      );
    }
  }

  async getByCustomerId(
    accessPattern: SubscriptionRepoAccess,
    stripeCustomerId: StripeCustomerId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    return this.findOneByAttribute(accessPattern, "stripeCustomerId", stripeCustomerId);
  }

  async getByFiefUserId(
    accessPattern: SubscriptionRepoAccess,
    fiefUserId: FiefUserId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    return this.findOneByAttribute(accessPattern, "fiefUserId", fiefUserId);
  }

  /**
   * Partition-scoped Query + filter fallback (no GSI on the shared table — see
   * subscription-db-model.ts header). Returns the first match — for OwlBooks
   * v1 there is exactly one subscription per Fief user / Stripe customer.
   */
  private async findOneByAttribute(
    accessPattern: SubscriptionRepoAccess,
    attr: "stripeCustomerId" | "fiefUserId",
    value: string,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    try {
      const queryCmd = this.entity.table
        .build(QueryCommand)
        .entities(this.entity)
        .query({
          partition: DynamoDbSubscription.accessPattern.getPK(accessPattern),
          range: {
            beginsWith: DynamoDbSubscription.accessPattern.getSKforAllSubscriptions(),
          },
        })
        .options({
          maxPages: Infinity,
          filters: {
            SubscriptionRecord: { attr, eq: value },
          },
        });

      const result = await queryCmd.send();

      const items = result.Items ?? [];

      if (items.length === 0) {
        return ok(null);
      }

      const parsed = DynamoDbSubscription.entitySchema.build(Parser).parse(items[0]) as ParsedRow;

      return ok(mapRowToRecord(parsed));
    } catch (e) {
      this.logger.error("Failed to fetch subscription by " + attr + " from DynamoDB", {
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedFetchingSubscriptionError(
          "Failed to fetch subscription from DynamoDB by " + attr,
          {
            cause: e,
          },
        ),
      );
    }
  }
}
