/**
 * DynamoDB schema for the subscription cache record.
 *
 * Mirrors `transactions-recording/repositories/dynamodb/recorded-transaction-db-model.ts`.
 *
 * Single-table design:
 *   PK = saleorApiUrl#appId (installation scope)
 *   SK = SUBSCRIPTION#${stripeSubscriptionId}
 *
 * GSI strategy: the shared `DynamoMainTable` declares only the base PK/SK and
 * provides no GSI infrastructure (`scripts/setup-dynamodb.ts` creates the
 * table with no GlobalSecondaryIndexes). Adding GSI definitions to the entity
 * here without an underlying table-level GSI would silently fail at runtime.
 *
 * Per T8 plan-spec ("scan-with-filter fallback for v1 (acceptable since record
 * count will be low for OwlBooks)"), `getByCustomerId` and `getByFiefUserId`
 * use a partition-scoped Query + filter on the cached attributes
 * `stripeCustomerId` / `fiefUserId`. Switching to real GSIs later is additive:
 * declare the index in `DynamoMainTable`, add `AttributeDefinitions` +
 * `GlobalSecondaryIndexes` to setup-dynamodb, and replace the scan in the repo.
 */
import { boolean, Entity, item, string } from "dynamodb-toolbox";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type StripeSubscriptionId } from "../subscription-record";

class AccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificItem({
    stripeSubscriptionId,
  }: {
    stripeSubscriptionId: StripeSubscriptionId;
  }) {
    return `SUBSCRIPTION#${stripeSubscriptionId}` as const;
  }

  /**
   * SK prefix for partition-scoped Query when scanning all subscriptions for an
   * installation (used by lookup-by-customerId / lookup-by-fiefUserId fallback).
   */
  static getSKforAllSubscriptions() {
    return `SUBSCRIPTION#` as const;
  }
}

const Schema = item({
  PK: string().key(),
  SK: string().key(),
  stripeSubscriptionId: string(),
  stripeCustomerId: string(),
  saleorChannelSlug: string(),
  saleorUserId: string(),
  fiefUserId: string(),
  saleorEntityId: string().optional(),
  stripePriceId: string(),
  status: string(),
  currentPeriodStart: string(),
  currentPeriodEnd: string(),
  cancelAtPeriodEnd: boolean(),
  lastInvoiceId: string().optional(),
  lastSaleorOrderId: string().optional(),
  /**
   * Cached plan display name (T23). Optional so existing rows continue to
   * parse; readers fall back to `stripePriceId` when absent.
   */
  planName: string().optional(),
});

const createEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "SubscriptionRecord",
    schema: Schema,
    timestamps: {
      created: {
        name: "createdAt",
        savedAs: "createdAt",
      },
      modified: {
        name: "modifiedAt",
        savedAs: "modifiedAt",
      },
    },
  });
};

const entity = createEntity(dynamoMainTable);

export type DynamoDbSubscriptionEntity = typeof entity;

export const DynamoDbSubscription = {
  accessPattern: {
    getPK: AccessPattern.getPK,
    getSKforSpecificItem: AccessPattern.getSKforSpecificItem,
    getSKforAllSubscriptions: AccessPattern.getSKforAllSubscriptions,
  },
  entitySchema: Schema,
  createEntity,
  entity,
};
