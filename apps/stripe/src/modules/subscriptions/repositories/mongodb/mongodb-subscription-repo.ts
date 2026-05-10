/**
 * MongoDB implementation of `SubscriptionRepo`.
 *
 * Sibling of `dynamodb/dynamodb-subscription-repo.ts`. Selected at runtime when
 * `APL=mongodb` so the app no longer crashes with "Region is missing" outside
 * AWS-provisioned environments.
 *
 * Connection management mirrors `MongodbTransactionRecorderRepo` verbatim
 * (lazy `connect()` / `ensureConnection()` with a memoised connection promise).
 *
 * Indexes:
 *   - `{ saleorApiUrl, appId, stripeSubscriptionId }` UNIQUE — equivalent to
 *     the DynamoDB PK+SK and the natural identity of a record.
 *   - `{ saleorApiUrl, appId, saleorUserId }` — webhook routing / lookup-by-user.
 *   - `{ saleorApiUrl, appId, stripeCustomerId }` — webhook routing for
 *     `customer.subscription.*` and `invoice.*` events.
 *
 * T31 Layer A `markInvoiceProcessed` is implemented as a conditional update
 * (`updateOne` with `lastInvoiceId: { $ne: newInvoiceId }`). When the update
 * matches zero documents the record already has the same `lastInvoiceId` and we
 * resolve `Ok('already_processed')` — equivalent to DynamoDB's
 * `ConditionalCheckFailedException` arm.
 */
import { type Collection, type Db, MongoClient } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  createFiefUserId,
  createSaleorChannelSlug,
  createSaleorEntityId,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  type FiefUserId,
  type StripeCustomerId,
  type StripeSubscriptionId,
  SubscriptionRecord,
  type SubscriptionStatus,
} from "../subscription-record";
import {
  type MarkInvoiceProcessedOutcome,
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
  SubscriptionRepoError,
} from "../subscription-repo";

interface MongoSubscriptionRecord {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  saleorChannelSlug: string;
  saleorUserId: string;
  fiefUserId: string;
  saleorEntityId: string | null;
  stripePriceId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  lastInvoiceId: string | null;
  lastSaleorOrderId: string | null;
  planName: string | null;
  createdAt: string;
  modifiedAt: string;
}

const mapDocToRecord = (doc: MongoSubscriptionRecord): SubscriptionRecord => {
  return new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId(doc.stripeSubscriptionId),
    stripeCustomerId: createStripeCustomerId(doc.stripeCustomerId),
    saleorChannelSlug: createSaleorChannelSlug(doc.saleorChannelSlug),
    saleorUserId: doc.saleorUserId,
    fiefUserId: createFiefUserId(doc.fiefUserId),
    saleorEntityId: doc.saleorEntityId ? createSaleorEntityId(doc.saleorEntityId) : null,
    stripePriceId: createStripePriceId(doc.stripePriceId),
    status: doc.status as SubscriptionStatus,
    currentPeriodStart: new Date(doc.currentPeriodStart),
    currentPeriodEnd: new Date(doc.currentPeriodEnd),
    cancelAtPeriodEnd: doc.cancelAtPeriodEnd,
    lastInvoiceId: doc.lastInvoiceId ?? null,
    lastSaleorOrderId: doc.lastSaleorOrderId ?? null,
    planName: doc.planName ?? null,
    createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
    updatedAt: doc.modifiedAt ? new Date(doc.modifiedAt) : new Date(),
  });
};

export class MongodbSubscriptionRepo implements SubscriptionRepo {
  private logger = createLogger("MongodbSubscriptionRepo");
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoSubscriptionRecord> | null = null;
  private connectionPromise: Promise<void> | null = null;

  static ConnectionError = BaseError.subclass("ConnectionError");

  constructor(
    params: {
      collection?: Collection<MongoSubscriptionRecord>;
    } = {},
  ) {
    this.connectionPromise = null;

    /*
     * Test seam: allow injecting a pre-built collection (e.g. a vitest mock or
     * an in-memory mongodb-memory-server collection) so tests don't need to
     * reach for `vi.mock("mongodb")`. Production callers always go through
     * the lazy `connect()` path.
     */
    if (params.collection) {
      this.collection = params.collection;
      this.connectionPromise = Promise.resolve();
    }
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongodbSubscriptionRepo.ConnectionError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.collection = this.db.collection<MongoSubscriptionRecord>("subscription_records");

      // Unique index on the natural identity (DynamoDB PK+SK equivalent).
      await this.collection.createIndex(
        { saleorApiUrl: 1, appId: 1, stripeSubscriptionId: 1 },
        { unique: true },
      );
      // Lookup-by-user (webhook routing for OwlBooks /api/public/* and Saleor user-scoped reads).
      await this.collection.createIndex({ saleorApiUrl: 1, appId: 1, saleorUserId: 1 });
      // Lookup-by-customer (webhook routing for Stripe `customer.*` / `invoice.*` events).
      await this.collection.createIndex({ saleorApiUrl: 1, appId: 1, stripeCustomerId: 1 });
    } catch (error) {
      throw new MongodbSubscriptionRepo.ConnectionError("Failed to connect to MongoDB", {
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
      throw new MongodbSubscriptionRepo.ConnectionError("MongoDB connection not established");
    }
  }

  private toMongoDoc(args: {
    accessPattern: SubscriptionRepoAccess;
    subscription: SubscriptionRecord;
    nowIso: string;
    createdAtIso?: string;
  }): MongoSubscriptionRecord {
    const { accessPattern, subscription, nowIso, createdAtIso } = args;

    return {
      saleorApiUrl: accessPattern.saleorApiUrl,
      appId: accessPattern.appId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripeCustomerId: subscription.stripeCustomerId,
      saleorChannelSlug: subscription.saleorChannelSlug,
      saleorUserId: subscription.saleorUserId,
      fiefUserId: subscription.fiefUserId,
      saleorEntityId: subscription.saleorEntityId ?? null,
      stripePriceId: subscription.stripePriceId,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      lastInvoiceId: subscription.lastInvoiceId ?? null,
      lastSaleorOrderId: subscription.lastSaleorOrderId ?? null,
      planName: subscription.planName ?? null,
      createdAt: createdAtIso ?? nowIso,
      modifiedAt: nowIso,
    };
  }

  async upsert(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<null, SubscriptionRepoError>> {
    try {
      await this.ensureConnection();

      this.logger.debug("Upserting subscription record to MongoDB", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      });

      const nowIso = new Date().toISOString();
      const filter = {
        saleorApiUrl: accessPattern.saleorApiUrl,
        appId: accessPattern.appId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      };

      /*
       * Preserve the original createdAt across upserts (DynamoDB-toolbox does
       * this via its `created` timestamp; we replicate by reading first).
       */
      const existing = await this.collection!.findOne(filter, {
        projection: { createdAt: 1 },
      });
      const createdAtIso = existing?.createdAt ?? nowIso;

      const doc = this.toMongoDoc({ accessPattern, subscription, nowIso, createdAtIso });

      await this.collection!.replaceOne(filter, doc, { upsert: true });

      this.logger.debug("Successfully upserted subscription to MongoDB", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      });

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to upsert subscription to MongoDB", { error: e });

      return err(
        new SubscriptionRepoError.FailedWritingSubscriptionError(
          "Failed to upsert subscription to MongoDB",
          { cause: e },
        ),
      );
    }
  }

  /**
   * T31 Layer A — race-safe `lastInvoiceId` claim.
   *
   * Mongo equivalent of the DynamoDB conditional Put
   * (`attribute_not_exists(lastInvoiceId) OR lastInvoiceId <> :new`):
   * we issue an `updateOne` whose filter requires either the field to be null
   * or different from the incoming value. If `matchedCount === 0` we either
   * (a) lost the race — another delivery already wrote the same invoice id —
   * or (b) the record does not yet exist. In case (a) we surface
   * `Ok('already_processed')`; in case (b) we fall back to a normal upsert
   * (`updated` arm) so first-time invoice claims still succeed.
   */
  async markInvoiceProcessed(
    accessPattern: SubscriptionRepoAccess,
    subscription: SubscriptionRecord,
  ): Promise<Result<MarkInvoiceProcessedOutcome, SubscriptionRepoError>> {
    if (!subscription.lastInvoiceId) {
      return err(
        new SubscriptionRepoError.FailedWritingSubscriptionError(
          "markInvoiceProcessed called without lastInvoiceId on the record",
        ),
      );
    }

    try {
      await this.ensureConnection();

      this.logger.debug("markInvoiceProcessed: attempting conditional claim", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        lastInvoiceId: subscription.lastInvoiceId,
      });

      const nowIso = new Date().toISOString();
      const baseFilter = {
        saleorApiUrl: accessPattern.saleorApiUrl,
        appId: accessPattern.appId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      };

      /*
       * Read the existing doc first so we can distinguish "record absent" (must
       * create) from "race lost" (already_processed) without depending on a
       * second update.
       */
      const existing = await this.collection!.findOne(baseFilter);

      if (existing && existing.lastInvoiceId === subscription.lastInvoiceId) {
        this.logger.info(
          "markInvoiceProcessed: invoice already processed by concurrent delivery (idempotent)",
          {
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            lastInvoiceId: subscription.lastInvoiceId,
          },
        );

        return ok("already_processed");
      }

      const createdAtIso = existing?.createdAt ?? nowIso;
      const doc = this.toMongoDoc({ accessPattern, subscription, nowIso, createdAtIso });

      /*
       * Conditional write: only proceed if the lastInvoiceId is still NOT the
       * new one. Concurrent delivery is the race we're guarding against here.
       */
      const conditionalFilter = {
        ...baseFilter,
        $or: [
          { lastInvoiceId: { $exists: false } },
          { lastInvoiceId: null },
          { lastInvoiceId: { $ne: subscription.lastInvoiceId } },
        ],
      };

      const updateResult = await this.collection!.replaceOne(conditionalFilter, doc, {
        upsert: !existing,
      });

      if (updateResult.matchedCount === 0 && !updateResult.upsertedId) {
        // Another writer beat us between our read and our update.
        this.logger.info("markInvoiceProcessed: lost race to concurrent writer (idempotent)", {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          lastInvoiceId: subscription.lastInvoiceId,
        });

        return ok("already_processed");
      }

      this.logger.debug("markInvoiceProcessed: claim succeeded", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        lastInvoiceId: subscription.lastInvoiceId,
      });

      return ok("updated");
    } catch (e) {
      /*
       * Mongo throws a duplicate-key error (code 11000) on the unique
       * `(saleorApiUrl, appId, stripeSubscriptionId)` index when our
       * `upsert: !existing` races with another writer's create. That race is
       * semantically the same as "concurrent delivery already did the work".
       */
      const errCode = (e as { code?: number } | null)?.code;

      if (errCode === 11000) {
        this.logger.info("markInvoiceProcessed: duplicate-key on concurrent insert (idempotent)", {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          lastInvoiceId: subscription.lastInvoiceId,
        });

        return ok("already_processed");
      }

      this.logger.error("markInvoiceProcessed: unexpected MongoDB failure", {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        lastInvoiceId: subscription.lastInvoiceId,
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedWritingSubscriptionError(
          "Failed to mark invoice processed in MongoDB",
          { cause: e },
        ),
      );
    }
  }

  async getBySubscriptionId(
    accessPattern: SubscriptionRepoAccess,
    stripeSubscriptionId: StripeSubscriptionId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    try {
      await this.ensureConnection();

      const doc = await this.collection!.findOne({
        saleorApiUrl: accessPattern.saleorApiUrl,
        appId: accessPattern.appId,
        stripeSubscriptionId,
      });

      if (!doc) {
        return ok(null);
      }

      return ok(mapDocToRecord(doc));
    } catch (e) {
      this.logger.error("Failed to fetch subscription by subscriptionId from MongoDB", {
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedFetchingSubscriptionError(
          "Failed to fetch subscription from MongoDB",
          { cause: e },
        ),
      );
    }
  }

  async getByCustomerId(
    accessPattern: SubscriptionRepoAccess,
    stripeCustomerId: StripeCustomerId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    return this.findOneByAttribute(accessPattern, "stripeCustomerId", stripeCustomerId);
  }

  async getByFiefUserId(
    accessPattern: SubscriptionRepoAccess,
    fiefUserId: FiefUserId,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    return this.findOneByAttribute(accessPattern, "fiefUserId", fiefUserId);
  }

  /**
   * Indexed point-lookup on the GSI-equivalent compound index. Returns the
   * first match — for OwlBooks v1 there is exactly one subscription per
   * Fief user / Stripe customer per installation.
   */
  private async findOneByAttribute(
    accessPattern: SubscriptionRepoAccess,
    attr: "stripeCustomerId" | "fiefUserId",
    value: string,
  ): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> {
    try {
      await this.ensureConnection();

      const doc = await this.collection!.findOne({
        saleorApiUrl: accessPattern.saleorApiUrl,
        appId: accessPattern.appId,
        [attr]: value,
      });

      if (!doc) {
        return ok(null);
      }

      return ok(mapDocToRecord(doc));
    } catch (e) {
      this.logger.error("Failed to fetch subscription by " + attr + " from MongoDB", {
        error: e,
      });

      return err(
        new SubscriptionRepoError.FailedFetchingSubscriptionError(
          "Failed to fetch subscription from MongoDB by " + attr,
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
