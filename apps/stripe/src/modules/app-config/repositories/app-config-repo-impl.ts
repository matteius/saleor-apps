import { env } from "@/lib/env";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { DynamodbAppConfigRepo } from "@/modules/app-config/repositories/dynamodb/dynamodb-app-config-repo";
import { MongodbAppConfigRepo } from "@/modules/app-config/repositories/mongodb/mongodb-app-config-repo";

/*
 * Replace this implementation with custom DB (Redis, Metadata etc) to drop DynamoDB and bring something else
 */
const createAppConfigRepo = (): AppConfigRepo => {
  if (env.APL === "mongodb") {
    return new MongodbAppConfigRepo();
  }

  return new DynamodbAppConfigRepo();
};

export const appConfigRepoImpl = createAppConfigRepo();
