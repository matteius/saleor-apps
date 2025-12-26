import { Entity, map, number, string } from "dynamodb-toolbox";
import { item } from "dynamodb-toolbox/schema/item";

import { DynamoMainTable, getDynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";

class AccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificItem({ paymentIntentId }: { paymentIntentId: StripePaymentIntentId }) {
    return `TRANSACTION#${paymentIntentId}` as const;
  }
}

const Schema = item({
  PK: string().key(),
  SK: string().key(),
  paymentIntentId: string(),
  saleorTransactionId: string(),
  // TODO: Do we want to use DynamoDB enums?
  saleorTransactionFlow: string(),
  resolvedTransactionFlow: string(),
  selectedPaymentMethod: string(),
  saleorSchemaVersion: map({
    major: number(),
    minor: number(),
  }),
});

const createEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "RecordedTransaction",
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

let _entity: ReturnType<typeof createEntity> | null = null;

const getEntity = () => {
  if (!_entity) {
    _entity = createEntity(getDynamoMainTable());
  }

  return _entity;
};

export type DynamoDbRecordedTransactionEntity = ReturnType<typeof createEntity>;

export const DynamoDbRecordedTransaction = {
  accessPattern: {
    getPK: AccessPattern.getPK,
    getSKforSpecificItem: AccessPattern.getSKforSpecificItem,
  },
  entitySchema: Schema,
  createEntity,
  get entity() {
    return getEntity();
  },
};
