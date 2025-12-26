import { env } from "@/lib/env";
import { DynamoDBTransactionRecorderRepo } from "@/modules/transactions-recording/repositories/dynamodb/dynamodb-transaction-recorder-repo";
import { MongodbTransactionRecorderRepo } from "@/modules/transactions-recording/repositories/mongodb/mongodb-transaction-recorder-repo";
import { TransactionRecorderRepo } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

/**
 * When forking, you can replace this only file with custom implementation, to replace DynamoDB with another storage
 */
const createTransactionRecorder = (): TransactionRecorderRepo => {
  if (env.APL === "mongodb") {
    return new MongodbTransactionRecorderRepo();
  }

  return new DynamoDBTransactionRecorderRepo();
};

export const transactionRecorder: TransactionRecorderRepo = createTransactionRecorder();
