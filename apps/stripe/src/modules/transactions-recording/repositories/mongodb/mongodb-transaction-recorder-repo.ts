import { Collection, Db, MongoClient } from "mongodb";
import { err, ok, Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { ResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import { SaleorTransationFlow } from "@/modules/saleor/saleor-transaction-flow";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import { PaymentMethod } from "@/modules/stripe/payment-methods/types";
import {
  createStripePaymentIntentId,
  StripePaymentIntentId,
} from "@/modules/stripe/stripe-payment-intent-id";
import { RecordedTransaction } from "@/modules/transactions-recording/domain/recorded-transaction";
import {
  TransactionRecorderError,
  TransactionRecorderRepo,
  TransactionRecorderRepoAccess,
} from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

interface MongoRecordedTransaction {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  stripePaymentIntentId: string;
  saleorTransactionId: string;
  saleorTransactionFlow: string;
  resolvedTransactionFlow: string;
  selectedPaymentMethod: string | number;
}

export class MongodbTransactionRecorderRepo implements TransactionRecorderRepo {
  private logger = createLogger("MongodbTransactionRecorderRepo");
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoRecordedTransaction> | null = null;
  private connectionPromise: Promise<void> | null = null;

  static ConnectionError = BaseError.subclass("ConnectionError");

  constructor() {
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongodbTransactionRecorderRepo.ConnectionError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.collection = this.db.collection<MongoRecordedTransaction>("recorded_transactions");

      // Create indexes for faster queries
      await this.collection.createIndex(
        { saleorApiUrl: 1, appId: 1, stripePaymentIntentId: 1 },
        { unique: true },
      );
      await this.collection.createIndex({ saleorApiUrl: 1, appId: 1, saleorTransactionId: 1 });
    } catch (error) {
      throw new MongodbTransactionRecorderRepo.ConnectionError("Failed to connect to MongoDB", {
        cause: error,
      });
    }
  }

  private async ensureConnection(): Promise<void> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.connect();
    }
    await this.connectionPromise;
    if (!this.collection) {
      throw new MongodbTransactionRecorderRepo.ConnectionError(
        "MongoDB connection not established",
      );
    }
  }

  async recordTransaction(
    accessPattern: TransactionRecorderRepoAccess,
    transaction: RecordedTransaction,
  ): Promise<Result<null, TransactionRecorderError>> {
    try {
      await this.ensureConnection();

      const mongoTransaction: MongoRecordedTransaction = {
        saleorApiUrl: accessPattern.saleorApiUrl,
        appId: accessPattern.appId,
        stripePaymentIntentId: transaction.stripePaymentIntentId,
        saleorTransactionId: transaction.saleorTransactionId,
        saleorTransactionFlow: transaction.saleorTransactionFlow,
        resolvedTransactionFlow: transaction.resolvedTransactionFlow,
        selectedPaymentMethod: transaction.selectedPaymentMethod,
      };

      await this.collection!.replaceOne(
        {
          saleorApiUrl: accessPattern.saleorApiUrl,
          appId: accessPattern.appId,
          stripePaymentIntentId: transaction.stripePaymentIntentId,
        },
        mongoTransaction,
        { upsert: true },
      );

      this.logger.info("Recorded transaction to MongoDB", {
        stripePaymentIntentId: transaction.stripePaymentIntentId,
        saleorTransactionId: transaction.saleorTransactionId,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to record transaction to MongoDB", { cause: error });

      return err(
        new TransactionRecorderError.FailedWritingTransactionError(
          "Failed to record transaction to MongoDB",
          {
            cause: error,
          },
        ),
      );
    }
  }

  async getTransactionByStripePaymentIntentId(
    accessPattern: TransactionRecorderRepoAccess,
    id: StripePaymentIntentId,
  ): Promise<Result<RecordedTransaction, TransactionRecorderError>> {
    try {
      await this.ensureConnection();

      const mongoTransaction = await this.collection!.findOne({
        saleorApiUrl: accessPattern.saleorApiUrl,
        appId: accessPattern.appId,
        stripePaymentIntentId: id,
      });

      if (!mongoTransaction) {
        return err(
          new TransactionRecorderError.TransactionMissingError("Transaction not found in MongoDB", {
            props: {
              stripePaymentIntentId: id,
              saleorApiUrl: accessPattern.saleorApiUrl,
              appId: accessPattern.appId,
            },
          }),
        );
      }

      const recordedTransaction = new RecordedTransaction({
        stripePaymentIntentId: createStripePaymentIntentId(mongoTransaction.stripePaymentIntentId),
        saleorTransactionId: createSaleorTransactionId(mongoTransaction.saleorTransactionId),
        saleorTransactionFlow: mongoTransaction.saleorTransactionFlow as SaleorTransationFlow,
        resolvedTransactionFlow:
          mongoTransaction.resolvedTransactionFlow as ResolvedTransactionFlow,
        selectedPaymentMethod: mongoTransaction.selectedPaymentMethod as PaymentMethod["type"],
      });

      return ok(recordedTransaction);
    } catch (error) {
      this.logger.error("Failed to fetch transaction from MongoDB", { cause: error });

      return err(
        new TransactionRecorderError.FailedFetchingTransactionError(
          "Failed to fetch transaction from MongoDB",
          {
            cause: error,
          },
        ),
      );
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.collection = null;
    }
  }
}
