/**
 * DynamoDB schema for the failed-mint DLQ (T32).
 *
 * Single-table design (shared `DynamoMainTable`):
 *   PK = saleorApiUrl#appId  (installation scope — see DynamoMainTable.getPrimaryKeyScopedToInstallation)
 *   SK = failed-mint#${stripeInvoiceId}
 *
 * Direct PK+SK lookup uniquely identifies a DLQ row, so `getById` is an O(1)
 * GetItem (no scan). `listPendingRetries` is a partition-scoped Query with
 * SK begins-with `failed-mint#` plus a `nextRetryAt <= cutoff` filter applied
 * via dynamodb-toolbox's `filters` option.
 *
 * GSI strategy: same as T8/T10/T17 — none. Direct PK+SK or partition-scoped
 * Query suffices for the small DLQ row count (DLQ is by definition expected to
 * be empty 99% of the time).
 */
import { Entity, item, number, string } from "dynamodb-toolbox";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

class FailedMintAccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificItem({ stripeInvoiceId }: { stripeInvoiceId: string }) {
    return `failed-mint#${stripeInvoiceId}` as const;
  }

  /** SK prefix for partition-scoped Query when sweeping pending retries. */
  static getSKforAllFailedMints() {
    return `failed-mint#` as const;
  }
}

const FailedMintSchema = item({
  PK: string().key(),
  SK: string().key(),
  stripeInvoiceId: string(),
  stripeSubscriptionId: string(),
  stripeCustomerId: string(),
  fiefUserId: string(),
  saleorChannelSlug: string(),
  saleorVariantId: string(),
  amountCents: number(),
  currency: string(),
  taxCents: number(),
  errorMessage: string(),
  errorClass: string(),
  attemptCount: number(),
  nextRetryAt: number(),
  firstAttemptAt: number(),
  lastAttemptAt: number(),
  invoicePayload: string(),
  finalFailureAlertedAt: number().optional(),
});

const createFailedMintEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "FailedMintDlq",
    schema: FailedMintSchema,
    timestamps: {
      created: { name: "createdAt", savedAs: "createdAt" },
      modified: { name: "modifiedAt", savedAs: "modifiedAt" },
    },
  });
};

const failedMintEntity = createFailedMintEntity(dynamoMainTable);

export type DynamoDbFailedMintEntity = typeof failedMintEntity;

export const DynamoDbFailedMint = {
  accessPattern: {
    getPK: FailedMintAccessPattern.getPK,
    getSKforSpecificItem: FailedMintAccessPattern.getSKforSpecificItem,
    getSKforAllFailedMints: FailedMintAccessPattern.getSKforAllFailedMints,
  },
  entitySchema: FailedMintSchema,
  createEntity: createFailedMintEntity,
  entity: failedMintEntity,
};
