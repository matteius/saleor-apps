import { env } from "@/lib/env";
import { DynamodbAppConfigRepo } from "@/modules/app-config/repositories/dynamodb/dynamodb-app-config-repo";
import { MongodbAppConfigRepo } from "@/modules/app-config/repositories/mongodb/mongodb-app-config-repo";

/*
 * Replace this implementation with custom DB (Redis, Metadata etc) to drop DynamoDB and bring something else
 */
export const appConfigRepoImpl =
  env.APL === "mongodb" ? new MongodbAppConfigRepo() : new DynamodbAppConfigRepo();
