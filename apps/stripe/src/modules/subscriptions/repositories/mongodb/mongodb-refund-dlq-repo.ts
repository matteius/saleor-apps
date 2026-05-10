/**
 * MongoDB implementation of {@link RefundDlqRepo} (T17).
 *
 * Mirrors {@link MongodbTransactionRecorderRepo} for connection lifecycle
 * (lazy `connect()` / `ensureConnection()`, single shared `MongoClient`) and
 * follows the same upsert pattern used elsewhere in this app.
 *
 * The DynamoDB sibling stores the two queues in the shared single table by
 * prefixing the sort key (`failed-refund#…` vs `pending-refund-review#…`).
 * Mongo gets a single `refund_dlq` collection with a `kind` discriminator and
 * a unique compound index on `(saleorApiUrl, appId, kind, stripeChargeId)`.
 *
 * Both write methods are PutItem-style upserts in the Dynamo impl —
 * duplicate webhook deliveries simply overwrite the prior row with a fresh
 * `attemptedAt`. Replicated here via `replaceOne(..., { upsert: true })`.
 */
import { type Collection, type Db, MongoClient } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  type FailedRefundEntry,
  type PendingRefundReviewEntry,
  type RefundDlqAccess,
  type RefundDlqRepo,
  RefundDlqRepoError,
} from "../refund-dlq-repo";

type RefundDlqKind = "failed-refund" | "pending-refund-review";

interface MongoRefundDlqBaseFields {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  kind: RefundDlqKind;
  stripeChargeId: string;
  invoiceId: string;
  refundAmountCents: number;
  currency: string;
  attemptedAt: string;
  modifiedAt: string;
}

interface MongoFailedRefundDoc extends MongoRefundDlqBaseFields {
  kind: "failed-refund";
}

interface MongoPendingRefundReviewDoc extends MongoRefundDlqBaseFields {
  kind: "pending-refund-review";
  saleorOrderId: string;
  capturedAmountCents: number;
}

type MongoRefundDlqDoc = MongoFailedRefundDoc | MongoPendingRefundReviewDoc;

export class MongodbRefundDlqRepo implements RefundDlqRepo {
  private logger = createLogger("MongodbRefundDlqRepo");
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoRefundDlqDoc> | null = null;
  private connectionPromise: Promise<void> | null = null;

  static ConnectionError = BaseError.subclass("ConnectionError");

  constructor() {
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongodbRefundDlqRepo.ConnectionError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.collection = this.db.collection<MongoRefundDlqDoc>("refund_dlq");

      /*
       * Unique per-installation+kind+chargeId — duplicate webhook deliveries
       * get upserted (overwriting the prior row) rather than creating dupes.
       */
      await this.collection.createIndex(
        { saleorApiUrl: 1, appId: 1, kind: 1, stripeChargeId: 1 },
        { unique: true },
      );
    } catch (error) {
      throw new MongodbRefundDlqRepo.ConnectionError("Failed to connect to MongoDB", {
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
      throw new MongodbRefundDlqRepo.ConnectionError("MongoDB connection not established");
    }
  }

  async recordFailedRefund(
    access: RefundDlqAccess,
    entry: FailedRefundEntry,
  ): Promise<Result<null, RefundDlqRepoError>> {
    try {
      await this.ensureConnection();

      const now = new Date().toISOString();
      const filter = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        kind: "failed-refund" as const,
        stripeChargeId: entry.stripeChargeId,
      };
      const doc: MongoFailedRefundDoc = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        kind: "failed-refund",
        stripeChargeId: entry.stripeChargeId,
        invoiceId: entry.invoiceId,
        refundAmountCents: entry.refundAmountCents,
        currency: entry.currency,
        attemptedAt: now,
        modifiedAt: now,
      };

      await this.collection!.replaceOne(filter, doc, { upsert: true });

      this.logger.info("Recorded failed-refund DLQ entry to MongoDB", {
        stripeChargeId: entry.stripeChargeId,
        invoiceId: entry.invoiceId,
      });

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to write failed-refund DLQ entry to MongoDB", { error: e });

      return err(
        new RefundDlqRepoError.PersistenceFailedError(
          "Failed to write failed-refund DLQ entry to MongoDB",
          { cause: e },
        ),
      );
    }
  }

  async recordPendingReview(
    access: RefundDlqAccess,
    entry: PendingRefundReviewEntry,
  ): Promise<Result<null, RefundDlqRepoError>> {
    try {
      await this.ensureConnection();

      const now = new Date().toISOString();
      const filter = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        kind: "pending-refund-review" as const,
        stripeChargeId: entry.stripeChargeId,
      };
      const doc: MongoPendingRefundReviewDoc = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        kind: "pending-refund-review",
        stripeChargeId: entry.stripeChargeId,
        invoiceId: entry.invoiceId,
        saleorOrderId: entry.saleorOrderId,
        refundAmountCents: entry.refundAmountCents,
        capturedAmountCents: entry.capturedAmountCents,
        currency: entry.currency,
        attemptedAt: now,
        modifiedAt: now,
      };

      await this.collection!.replaceOne(filter, doc, { upsert: true });

      this.logger.info("Recorded pending-refund-review entry to MongoDB", {
        stripeChargeId: entry.stripeChargeId,
        saleorOrderId: entry.saleorOrderId,
      });

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to write pending-refund-review entry to MongoDB", { error: e });

      return err(
        new RefundDlqRepoError.PersistenceFailedError(
          "Failed to write pending-refund-review entry to MongoDB",
          { cause: e },
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
