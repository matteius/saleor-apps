import { env } from "@/lib/env";

import { DynamoDbRefundDlqRepo } from "./dynamodb/dynamodb-refund-dlq-repo";
import { MongodbRefundDlqRepo } from "./mongodb/mongodb-refund-dlq-repo";
import { type RefundDlqRepo } from "./refund-dlq-repo";

export const refundDlqRepo: RefundDlqRepo =
  env.APL === "mongodb" ? new MongodbRefundDlqRepo() : new DynamoDbRefundDlqRepo();
