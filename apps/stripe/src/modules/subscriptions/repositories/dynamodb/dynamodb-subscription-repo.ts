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
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
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
  type MarkInvoiceProcessedOutcome,
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

  /**
   * T31 Layer A — race-safe `lastInvoiceId` claim.
   *
   * Implements `attribute_not_exists(lastInvoiceId) OR lastInvoiceId <>
   * :newInvoiceId` via a dynamodb-toolbox conditional Put. Concurrent webhook
   * deliveries for the same `invoice.id` will see exactly one writer succeed
   * with `'updated'`; the loser sees `ConditionalCheckFailedException` and we
   * resolve `Ok('already_processed')` so the caller can short-circuit without
   * a second mint.
   *
   * The conditional translates to DynamoDB's wire-level
   * `ConditionExpression: attribute_not_exists(#x) OR #x <> :y`. dynamodb-
   * toolbox builds and escapes the names/values; we never hand-write the
   * expression string.
   */
  async markInvoiceProcessed(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<MarkInvoiceProcessedOutcome, SubscriptionRepoError>> {
    if (!subscription.lastInvoiceId) {
      /*
       * Defensive: caller must populate `lastInvoiceId` for the claim to make
       * any sense. Surface as a write error so on-call sees the misuse.
       */
      return err(
        new SubscriptionRepoError.FailedWritingSubscriptionError(
          "markInvoiceProcessed called without lastInvoiceId on the record",
        ),
      );
    }

    try {
      this.logger.debug("markInvoiceProcessed: attempting conditional claim", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        lastInvoiceId: subscription.lastInvoiceId,
      });

      const operation = this.entity
        .build(PutItemCommand)
        .item({
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
          lastInvoiceId: subscription.lastInvoiceId,
          lastSaleorOrderId: subscription.lastSaleorOrderId ?? undefined,
          planName: subscription.planName ?? undefined,
        })
        .options({
          condition: {
            or: [
              { attr: "lastInvoiceId", exists: false },
              { attr: "lastInvoiceId", ne: subscription.lastInvoiceId },
            ],
          },
        });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode === 200) {
        this.logger.debug("markInvoiceProcessed: claim succeeded", {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          lastInvoiceId: subscription.lastInvoiceId,
        });

        return ok("updated");
      }

      throw new BaseError(
        "Unexpected response from DynamoDB during markInvoiceProcessed: " +
          result.$metadata.httpStatusCode,
        { cause: result },
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        this.logger.info(
          "markInvoiceProcessed: conditional check failed — invoice already processed by concurrent delivery (idempotent)",
          {
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            lastInvoiceId: subscription.lastInvoiceId,
          },
        );

        return ok("already_processed");
      }

      this.logger.error("markInvoiceProcessed: unexpected DynamoDB failure", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        lastInvoiceId: subscription.lastInvoiceId,
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedWritingSubscriptionError(
          "Failed to mark invoice processed in DynamoDB",
          { cause: e },
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
