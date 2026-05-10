import { env } from "@/lib/env";

import { DynamoDbSubscriptionRepo } from "./dynamodb/dynamodb-subscription-repo";
import { MongodbSubscriptionRepo } from "./mongodb/mongodb-subscription-repo";
import { type SubscriptionRepo } from "./subscription-repo";

export const subscriptionRepo: SubscriptionRepo =
  env.APL === "mongodb" ? new MongodbSubscriptionRepo() : new DynamoDbSubscriptionRepo();
