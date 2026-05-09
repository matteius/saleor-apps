/**
 * DynamoDB schema for the Stripe price ↔ Saleor variant mapping (T10).
 *
 * Single-table design (shared `DynamoMainTable`):
 *   PK = saleorApiUrl#appId  (installation scope — see DynamoMainTable.getPrimaryKeyScopedToInstallation)
 *   SK = price-variant-map#${stripePriceId}
 *
 * Direct PK+SK lookup uniquely identifies a mapping, so `get` is an O(1)
 * GetItem (no scan). `list` is a partition-scoped Query with SK begins-with
 * `price-variant-map#` (used by T25's admin dashboard).
 *
 * GSI strategy: like T8's subscription-db-model, the shared table has no
 * GSIs (`scripts/setup-dynamodb.ts` creates the table without
 * GlobalSecondaryIndexes). We do not need any here — every access path is
 * either direct (PK+SK) or partition-scoped (PK + SK begins-with).
 */
import { Entity, item, string } from "dynamodb-toolbox";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type StripePriceId } from "../../saleor-bridge/price-variant-map";

class AccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificItem({ stripePriceId }: { stripePriceId: StripePriceId }) {
    return `price-variant-map#${stripePriceId}` as const;
  }

  /**
   * SK prefix for partition-scoped Query when listing all mappings for an
   * installation (used by T25 admin UI via `PriceVariantMapRepo.list`).
   */
  static getSKforAllMappings() {
    return `price-variant-map#` as const;
  }
}

const Schema = item({
  PK: string().key(),
  SK: string().key(),
  stripePriceId: string(),
  saleorVariantId: string(),
  saleorChannelSlug: string(),
});

const createEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "PriceVariantMap",
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

export type DynamoDbPriceVariantMapEntity = typeof entity;

export const DynamoDbPriceVariantMap = {
  accessPattern: {
    getPK: AccessPattern.getPK,
    getSKforSpecificItem: AccessPattern.getSKforSpecificItem,
    getSKforAllMappings: AccessPattern.getSKforAllMappings,
  },
  entitySchema: Schema,
  createEntity,
  entity,
};
