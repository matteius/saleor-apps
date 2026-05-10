/**
 * MongoDB implementation of `PriceVariantMapRepo` (T10).
 *
 * Mirrors `MongodbTransactionRecorderRepo` — lazy `connect()` / `ensureConnection()`
 * pattern with a single shared `MongoClient`, structured logging, and neverthrow
 * `Result` returns wrapping `PriceVariantMapError` subclasses.
 *
 * Storage:
 *   - Database:   `env.MONGODB_DATABASE` (defaults to `"saleor_stripe"`).
 *   - Collection: `price_variant_mappings`.
 *   - Compound unique index on `(saleorApiUrl, appId, stripePriceId)` so an
 *     installation can only have one variant mapped to any given Stripe price.
 *
 * Contract reminders (see `saleor-bridge/price-variant-map.ts`):
 *   - `get` returns `Ok(null)` for unknown price IDs (not an error). T14's
 *     `invoice.paid` handler uses that to log+alert+skip-mint rather than
 *     unwrapping a "missing" error case.
 *   - `set` is upsert semantics — uses `replaceOne({ ... }, { upsert: true })`.
 *   - `list` returns every mapping for an installation; used by T25's admin UI.
 *   - `delete` returns `Ok(null)` whether or not the row existed.
 */
import { type Collection, type Db, MongoClient } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  type PriceVariantMapAccess,
  PriceVariantMapError,
  type PriceVariantMapping,
  type PriceVariantMapRepo,
  type StripePriceId,
} from "../../saleor-bridge/price-variant-map";

interface MongoPriceVariantMapping {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  stripePriceId: string;
  saleorVariantId: string;
  saleorChannelSlug: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLLECTION_NAME = "price_variant_mappings";

const mapDocToMapping = (doc: MongoPriceVariantMapping): PriceVariantMapping => ({
  stripePriceId: createStripePriceId(doc.stripePriceId),
  saleorVariantId: createSaleorVariantId(doc.saleorVariantId),
  saleorChannelSlug: createSaleorChannelSlug(doc.saleorChannelSlug),
  createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt),
  updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt),
});

export class MongodbPriceVariantMapRepo implements PriceVariantMapRepo {
  private logger = createLogger("MongodbPriceVariantMapRepo");
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoPriceVariantMapping> | null = null;
  private connectionPromise: Promise<void> | null = null;

  static ConnectionError = BaseError.subclass("ConnectionError");

  constructor() {
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongodbPriceVariantMapRepo.ConnectionError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.collection = this.db.collection<MongoPriceVariantMapping>(COLLECTION_NAME);

      // Compound unique index — one mapping per (installation, stripePriceId).
      await this.collection.createIndex(
        { saleorApiUrl: 1, appId: 1, stripePriceId: 1 },
        { unique: true },
      );
    } catch (error) {
      throw new MongodbPriceVariantMapRepo.ConnectionError("Failed to connect to MongoDB", {
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
      throw new MongodbPriceVariantMapRepo.ConnectionError("MongoDB connection not established");
    }
  }

  async set(
    access: PriceVariantMapAccess,
    mapping: PriceVariantMapping,
  ): Promise<Result<null, PriceVariantMapError>> {
    try {
      await this.ensureConnection();

      const filter = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        stripePriceId: mapping.stripePriceId as unknown as string,
      };

      const doc: MongoPriceVariantMapping = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        stripePriceId: mapping.stripePriceId as unknown as string,
        saleorVariantId: mapping.saleorVariantId as unknown as string,
        saleorChannelSlug: mapping.saleorChannelSlug as unknown as string,
        createdAt: mapping.createdAt,
        updatedAt: mapping.updatedAt,
      };

      await this.collection!.replaceOne(filter, doc, { upsert: true });

      this.logger.debug("Upserted price-variant mapping to MongoDB", {
        stripePriceId: mapping.stripePriceId,
        saleorVariantId: mapping.saleorVariantId,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to upsert price-variant mapping to MongoDB", { cause: error });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to upsert price-variant mapping to MongoDB",
          {
            cause: error,
          },
        ),
      );
    }
  }

  async get(
    access: PriceVariantMapAccess,
    stripePriceId: StripePriceId,
  ): Promise<Result<PriceVariantMapping | null, PriceVariantMapError>> {
    try {
      await this.ensureConnection();

      const doc = await this.collection!.findOne({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        stripePriceId: stripePriceId as unknown as string,
      });

      if (!doc) {
        // Contract: unknown priceId is a normal lookup outcome, not an error.
        return ok(null);
      }

      return ok(mapDocToMapping(doc));
    } catch (error) {
      this.logger.error("Failed to fetch price-variant mapping from MongoDB", { cause: error });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to fetch price-variant mapping from MongoDB",
          {
            cause: error,
          },
        ),
      );
    }
  }

  async delete(
    access: PriceVariantMapAccess,
    stripePriceId: StripePriceId,
  ): Promise<Result<null, PriceVariantMapError>> {
    try {
      await this.ensureConnection();

      await this.collection!.deleteOne({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        stripePriceId: stripePriceId as unknown as string,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to delete price-variant mapping from MongoDB", { cause: error });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to delete price-variant mapping from MongoDB",
          {
            cause: error,
          },
        ),
      );
    }
  }

  async list(
    access: PriceVariantMapAccess,
  ): Promise<Result<PriceVariantMapping[], PriceVariantMapError>> {
    try {
      await this.ensureConnection();

      const docs = await this.collection!.find({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
      }).toArray();

      return ok(docs.map(mapDocToMapping));
    } catch (error) {
      this.logger.error("Failed to list price-variant mappings from MongoDB", { cause: error });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to list price-variant mappings from MongoDB",
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
      this.connectionPromise = null;
    }
  }
}
