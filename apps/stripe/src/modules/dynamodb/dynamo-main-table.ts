import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Table } from "dynamodb-toolbox";

import { env } from "@/lib/env";
import {
  createDynamoDBClient,
  createDynamoDBDocumentClient,
} from "@/modules/dynamodb/dynamodb-client";

type PartitionKey = { name: "PK"; type: "string" };
type SortKey = { name: "SK"; type: "string" };

/**
 * This table is used to store all relevant data for the Segment application meaning: APL, configuration, etc.
 */
export class DynamoMainTable extends Table<PartitionKey, SortKey> {
  private constructor(args: ConstructorParameters<typeof Table<PartitionKey, SortKey>>[number]) {
    super(args);
  }

  static create({
    documentClient,
    tableName,
  }: {
    documentClient: DynamoDBDocumentClient;
    tableName: string;
  }): DynamoMainTable {
    return new DynamoMainTable({
      documentClient,
      name: tableName,
      partitionKey: { name: "PK", type: "string" },
      sortKey: {
        name: "SK",
        type: "string",
      },
    });
  }

  /**
   * These PKs will be scoped per installation, so reinstalling the app will not access this data.
   * Use Case: Logs, config, transactions.
   */
  static getPrimaryKeyScopedToInstallation({
    saleorApiUrl,
    appId,
  }: {
    saleorApiUrl: string;
    appId: string;
  }): `${string}#${string}` {
    return `${saleorApiUrl}#${appId}` as const;
  }

  /**
   * These PKs will be scoped tenant, so even after reinstalling they will be accessible
   * Use case: APL
   */
  static getPrimaryKeyScopedToSaleorApiUrl({
    saleorApiUrl,
  }: {
    saleorApiUrl: string;
  }): `${string}` {
    return `${saleorApiUrl}` as const;
  }
}

let _dynamoMainTable: DynamoMainTable | null = null;

export const getDynamoMainTable = (): DynamoMainTable => {
  if (!_dynamoMainTable) {
    if (!env.DYNAMODB_MAIN_TABLE_NAME) {
      throw new Error("DYNAMODB_MAIN_TABLE_NAME is required when using DynamoDB");
    }
    const client = createDynamoDBClient();
    const documentClient = createDynamoDBDocumentClient(client);

    _dynamoMainTable = DynamoMainTable.create({
      documentClient: documentClient,
      tableName: env.DYNAMODB_MAIN_TABLE_NAME,
    });
  }

  return _dynamoMainTable;
};

/**
 * @deprecated Use getDynamoMainTable() instead - this will be removed in a future version
 */
export const dynamoMainTable = new Proxy({} as DynamoMainTable, {
  get(_target, prop) {
    return (getDynamoMainTable() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
