/**
 * MongoDB implementation of {@link FailedMintDlqRepo} (T32).
 *
 * Sibling to {@link DynamoDbFailedMintDlqRepo}; used when the deployment runs
 * with `APL=mongodb`. Mirrors the Mongo repo conventions established by
 * {@link MongodbTransactionRecorderRepo}: lazy `connect()`, `ensureConnection()`
 * gate, structured logging, neverthrow `Result` returns, errors wrapped in
 * `FailedMintDlqRepoError.PersistenceFailedError`.
 *
 * Storage shape: one document per (saleorApiUrl, appId, stripeInvoiceId)
 * triple. The compound unique index is what guarantees `record` is idempotent
 * across retries — re-recording the same invoice id replaces the row in place
 * (the caller is responsible for incrementing `attemptCount`, matching the
 * Dynamo impl's PutItem-replaces-row semantics).
 */
import { type Collection, type Db, MongoClient } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  type FailedMintDlqAccess,
  type FailedMintDlqRepo,
  FailedMintDlqRepoError,
  type FailedMintRecord,
} from "../failed-mint-dlq-repo";

interface MongoFailedMintRecord {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  fiefUserId: string;
  saleorChannelSlug: string;
  saleorVariantId: string;
  amountCents: number;
  currency: string;
  taxCents: number;
  errorMessage: string;
  errorClass: string;
  attemptCount: number;
  nextRetryAt: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  invoicePayload: string;
  finalFailureAlertedAt?: number;
}

const COLLECTION_NAME = "failed_mint_dlq";

const mapDocToRecord = (doc: MongoFailedMintRecord): FailedMintRecord => ({
  stripeInvoiceId: doc.stripeInvoiceId,
  stripeSubscriptionId: doc.stripeSubscriptionId,
  stripeCustomerId: doc.stripeCustomerId,
  fiefUserId: doc.fiefUserId,
  saleorChannelSlug: doc.saleorChannelSlug,
  saleorVariantId: doc.saleorVariantId,
  amountCents: doc.amountCents,
  currency: doc.currency,
  taxCents: doc.taxCents,
  errorMessage: doc.errorMessage,
  errorClass: doc.errorClass,
  attemptCount: doc.attemptCount,
  nextRetryAt: doc.nextRetryAt,
  firstAttemptAt: doc.firstAttemptAt,
  lastAttemptAt: doc.lastAttemptAt,
  invoicePayload: doc.invoicePayload,
  finalFailureAlertedAt: doc.finalFailureAlertedAt,
});

const recordToDoc = (
  access: FailedMintDlqAccess,
  record: FailedMintRecord,
): MongoFailedMintRecord => ({
  saleorApiUrl: access.saleorApiUrl,
  appId: access.appId,
  stripeInvoiceId: record.stripeInvoiceId,
  stripeSubscriptionId: record.stripeSubscriptionId,
  stripeCustomerId: record.stripeCustomerId,
  fiefUserId: record.fiefUserId,
  saleorChannelSlug: record.saleorChannelSlug,
  saleorVariantId: record.saleorVariantId,
  amountCents: record.amountCents,
  currency: record.currency,
  taxCents: record.taxCents,
  errorMessage: record.errorMessage,
  errorClass: record.errorClass,
  attemptCount: record.attemptCount,
  nextRetryAt: record.nextRetryAt,
  firstAttemptAt: record.firstAttemptAt,
  lastAttemptAt: record.lastAttemptAt,
  invoicePayload: record.invoicePayload,
  ...(record.finalFailureAlertedAt !== undefined && {
    finalFailureAlertedAt: record.finalFailureAlertedAt,
  }),
});

export class MongodbFailedMintDlqRepo implements FailedMintDlqRepo {
  private logger = createLogger("MongodbFailedMintDlqRepo");
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoFailedMintRecord> | null = null;
  private connectionPromise: Promise<void> | null = null;

  static ConnectionError = BaseError.subclass("ConnectionError");

  constructor(params?: { collection?: Collection<MongoFailedMintRecord> }) {
    if (params?.collection) {
      // Test seam: bypass real Mongo connect, use the supplied collection directly.
      this.collection = params.collection;
      this.connectionPromise = Promise.resolve();
    } else {
      this.connectionPromise = null;
    }
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongodbFailedMintDlqRepo.ConnectionError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.collection = this.db.collection<MongoFailedMintRecord>(COLLECTION_NAME);

      /*
       * Compound unique index — guarantees idempotency of `record` upserts and
       * anchors the cron sweeper's per-installation queries.
       */
      await this.collection.createIndex(
        { saleorApiUrl: 1, appId: 1, stripeInvoiceId: 1 },
        { unique: true },
      );
      // Secondary index for the cron sweeper which sorts/filters by nextRetryAt.
      await this.collection.createIndex({ saleorApiUrl: 1, appId: 1, nextRetryAt: 1 });
    } catch (error) {
      throw new MongodbFailedMintDlqRepo.ConnectionError("Failed to connect to MongoDB", {
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
      throw new MongodbFailedMintDlqRepo.ConnectionError("MongoDB connection not established");
    }
  }

  async record(
    access: FailedMintDlqAccess,
    record: FailedMintRecord,
  ): Promise<Result<null, FailedMintDlqRepoError>> {
    try {
      await this.ensureConnection();

      const doc = recordToDoc(access, record);

      await this.collection!.replaceOne(
        {
          saleorApiUrl: access.saleorApiUrl,
          appId: access.appId,
          stripeInvoiceId: record.stripeInvoiceId,
        },
        doc,
        { upsert: true },
      );

      this.logger.info("Recorded failed-mint DLQ entry to MongoDB", {
        stripeInvoiceId: record.stripeInvoiceId,
        attemptCount: record.attemptCount,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to write failed-mint DLQ entry to MongoDB", { error });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to write failed-mint DLQ entry to MongoDB",
          { cause: error },
        ),
      );
    }
  }

  async getById(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<FailedMintRecord | null, FailedMintDlqRepoError>> {
    try {
      await this.ensureConnection();

      const doc = await this.collection!.findOne({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        stripeInvoiceId,
      });

      if (!doc) {
        return ok(null);
      }

      return ok(mapDocToRecord(doc));
    } catch (error) {
      this.logger.error("Failed to fetch failed-mint DLQ entry from MongoDB", { error });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to fetch failed-mint DLQ entry from MongoDB",
          { cause: error },
        ),
      );
    }
  }

  async listPendingRetries(
    access: FailedMintDlqAccess,
    beforeUnixSeconds: number,
  ): Promise<Result<FailedMintRecord[], FailedMintDlqRepoError>> {
    try {
      await this.ensureConnection();

      const docs = await this.collection!.find({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        nextRetryAt: { $lte: beforeUnixSeconds },
      }).toArray();

      return ok(docs.map(mapDocToRecord));
    } catch (error) {
      this.logger.error("Failed to list pending failed-mint DLQ entries from MongoDB", { error });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to list pending failed-mint DLQ entries from MongoDB",
          { cause: error },
        ),
      );
    }
  }

  async delete(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<null, FailedMintDlqRepoError>> {
    try {
      await this.ensureConnection();

      await this.collection!.deleteOne({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        stripeInvoiceId,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to delete failed-mint DLQ entry from MongoDB", { error });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to delete failed-mint DLQ entry from MongoDB",
          { cause: error },
        ),
      );
    }
  }

  async markFinalFailure(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<null, FailedMintDlqRepoError>> {
    /*
     * Read-then-replace, mirroring the DynamoDB impl: we want every other field
     * preserved, and we want any subsequent `record` to see the alert flag.
     */
    const existing = await this.getById(access, stripeInvoiceId);

    if (existing.isErr()) {
      return err(existing.error);
    }

    if (!existing.value) {
      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          `Cannot markFinalFailure on missing DLQ entry stripeInvoiceId=${stripeInvoiceId}`,
        ),
      );
    }

    const updated: FailedMintRecord = {
      ...existing.value,
      finalFailureAlertedAt: Math.floor(Date.now() / 1000),
    };

    return this.record(access, updated);
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
