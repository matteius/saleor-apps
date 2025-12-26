import { Entity, item, string } from "dynamodb-toolbox";

import { DynamoMainTable, getDynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

class DynamoDbChannelConfigMappingAccessPattern {
  static getPK({ saleorApiUrl, appId }: { saleorApiUrl: SaleorApiUrl; appId: string }) {
    return DynamoMainTable.getPrimaryKeyScopedToInstallation({ saleorApiUrl, appId });
  }

  static getSKforSpecificChannel({ channelId }: { channelId: string }) {
    return `CHANNEL_ID#${channelId}` as const;
  }

  static getSKforAllChannels() {
    return `CHANNEL_ID#` as const;
  }
}

const DynamoDbChannelConfigMappingEntrySchema = item({
  PK: string().key(),
  SK: string().key(),
  channelId: string(),
  configId: string().optional(),
});

const createChannelConfigMappingEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "ChannelConfigMapping",
    schema: DynamoDbChannelConfigMappingEntrySchema,
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

let _dynamoDbChannelConfigMappingEntity: ReturnType<
  typeof createChannelConfigMappingEntity
> | null = null;

const getEntity = () => {
  if (!_dynamoDbChannelConfigMappingEntity) {
    _dynamoDbChannelConfigMappingEntity = createChannelConfigMappingEntity(getDynamoMainTable());
  }

  return _dynamoDbChannelConfigMappingEntity;
};

export type DynamoDbChannelConfigMappingEntity = ReturnType<
  typeof createChannelConfigMappingEntity
>;

export const DynamoDbChannelConfigMapping = {
  accessPattern: {
    getPK: DynamoDbChannelConfigMappingAccessPattern.getPK,
    getSKforSpecificChannel: DynamoDbChannelConfigMappingAccessPattern.getSKforSpecificChannel,
    getSKforAllChannels: DynamoDbChannelConfigMappingAccessPattern.getSKforAllChannels,
  },
  entitySchema: DynamoDbChannelConfigMappingEntrySchema,
  createEntity: createChannelConfigMappingEntity,
  get entity() {
    return getEntity();
  },
};
