import { env } from "@/lib/env";

import { DynamoDbFailedMintDlqRepo } from "./dynamodb/dynamodb-failed-mint-dlq-repo";
import { type FailedMintDlqRepo } from "./failed-mint-dlq-repo";
import { MongodbFailedMintDlqRepo } from "./mongodb/mongodb-failed-mint-dlq-repo";

export const failedMintDlqRepo: FailedMintDlqRepo =
  env.APL === "mongodb" ? new MongodbFailedMintDlqRepo() : new DynamoDbFailedMintDlqRepo();
