import { env } from "@/lib/env";
import { type PriceVariantMapRepo } from "@/modules/subscriptions/saleor-bridge/price-variant-map";

import { DynamoDbPriceVariantMapRepo } from "./dynamodb/dynamodb-price-variant-map-repo";
import { MongodbPriceVariantMapRepo } from "./mongodb/mongodb-price-variant-map-repo";

export const priceVariantMapRepo: PriceVariantMapRepo =
  env.APL === "mongodb" ? new MongodbPriceVariantMapRepo() : new DynamoDbPriceVariantMapRepo();
