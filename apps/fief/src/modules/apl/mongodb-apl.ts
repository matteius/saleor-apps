import {
  type APL,
  type AplConfiguredResult,
  type AplReadyResult,
  type AuthData,
} from "@saleor/app-sdk/APL";
import { type Collection } from "mongodb";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { appInternalTracer } from "@/lib/tracing";
import { closeMongoClient, getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";

/*
 * T3 — MongoDB-backed Auth Persistence Layer (APL).
 *
 * Implements the `@saleor/app-sdk/APL` contract on top of the shared
 * `MongoClient` singleton from `mongo-client.ts`. Ported from
 * `apps/stripe/src/modules/apl/mongodb-apl.ts`; the structural difference is
 * that the client lifetime is delegated entirely to the singleton module so
 * multiple APL instances (and other Mongo-using modules — T8 connection
 * repo, T11 webhook log, T32 reconciliation runner) all share one pool.
 *
 * Storage layout:
 *   - Database: `MONGODB_DATABASE` env (default `saleor_app_fief`).
 *   - Collection: `apl_auth_data`.
 *   - Index: unique on `{ saleorApiUrl: 1 }` — ensured lazily on first
 *     access; idempotent across processes (Mongo's `createIndex` is a no-op
 *     when the index already exists with the same spec).
 *
 * Errors are typed via `BaseError.subclass` so call sites can `match()` on
 * them; original driver errors are preserved as `cause`.
 */

interface MongoAuthData extends AuthData {
  _id?: string;
}

const COLLECTION_NAME = "apl_auth_data";

export class MongoAPL implements APL {
  static GetAuthDataError = BaseError.subclass("GetAuthDataError", {
    props: { _brand: "FiefApp.MongoAPL.GetAuthDataError" as const },
  });
  static SetAuthDataError = BaseError.subclass("SetAuthDataError", {
    props: { _brand: "FiefApp.MongoAPL.SetAuthDataError" as const },
  });
  static DeleteAuthDataError = BaseError.subclass("DeleteAuthDataError", {
    props: { _brand: "FiefApp.MongoAPL.DeleteAuthDataError" as const },
  });
  static GetAllAuthDataError = BaseError.subclass("GetAllAuthDataError", {
    props: { _brand: "FiefApp.MongoAPL.GetAllAuthDataError" as const },
  });
  static MissingEnvVariablesError = BaseError.subclass("MissingEnvVariablesError", {
    props: { _brand: "FiefApp.MongoAPL.MissingEnvVariablesError" as const },
  });
  static ConnectionError = BaseError.subclass("ConnectionError", {
    props: { _brand: "FiefApp.MongoAPL.ConnectionError" as const },
  });

  private tracer = appInternalTracer;

  /*
   * Cache the `Collection` handle once obtained so repeat accesses skip the
   * `getMongoClient()` await + `db().collection()` lookup. Wiped on
   * `close()` so subsequent calls rebuild the singleton path cleanly.
   */
  private collectionPromise: Promise<Collection<MongoAuthData>> | null = null;

  private async getCollection(): Promise<Collection<MongoAuthData>> {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());
        const collection = db.collection<MongoAuthData>(COLLECTION_NAME);

        /*
         * `createIndex` is idempotent on identical specs, so it's safe to run
         * on every cold-start. We do it lazily (not on construction) so the
         * APL can be instantiated synchronously without forcing a connect.
         */
        await collection.createIndex({ saleorApiUrl: 1 }, { unique: true });

        return collection;
      } catch (cause) {
        /*
         * Reset so the next caller retries from scratch rather than re-await
         * the failed promise.
         */
        this.collectionPromise = null;
        throw new MongoAPL.ConnectionError("Failed to access MongoDB collection", { cause });
      }
    })();

    return this.collectionPromise;
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    return this.tracer.startActiveSpan("MongoAPL.get", async (span) => {
      try {
        const collection = await this.getCollection();
        const result = await collection.findOne({ saleorApiUrl });

        span.end();

        if (!result) {
          return undefined;
        }

        // Strip Mongo's internal `_id` so we honor the `AuthData` contract.
        const { _id, ...authData } = result;

        return authData;
      } catch (cause) {
        span.end();
        throw new MongoAPL.GetAuthDataError("Failed to get APL entry", { cause });
      }
    });
  }

  async set(authData: AuthData): Promise<void> {
    return this.tracer.startActiveSpan("MongoAPL.set", async (span) => {
      try {
        const collection = await this.getCollection();

        await collection.replaceOne({ saleorApiUrl: authData.saleorApiUrl }, authData, {
          upsert: true,
        });

        span.end();
      } catch (cause) {
        span.end();
        throw new MongoAPL.SetAuthDataError("Failed to set APL entry", { cause });
      }
    });
  }

  async delete(saleorApiUrl: string): Promise<void> {
    return this.tracer.startActiveSpan("MongoAPL.delete", async (span) => {
      try {
        const collection = await this.getCollection();

        await collection.deleteOne({ saleorApiUrl });

        span.end();
      } catch (cause) {
        span.end();
        throw new MongoAPL.DeleteAuthDataError("Failed to delete APL entry", { cause });
      }
    });
  }

  async getAll(): Promise<AuthData[]> {
    return this.tracer.startActiveSpan("MongoAPL.getAll", async (span) => {
      try {
        const collection = await this.getCollection();
        const results = await collection.find({}).toArray();

        span.end();

        return results.map(({ _id, ...authData }) => authData);
      } catch (cause) {
        span.end();
        throw new MongoAPL.GetAllAuthDataError("Failed to get all APL entries", { cause });
      }
    });
  }

  async isReady(): Promise<AplReadyResult> {
    try {
      const client = await getMongoClient();

      await client.db(getMongoDatabaseName()).admin().ping();

      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error : new MongoAPL.ConnectionError("Unknown error"),
      };
    }
  }

  async isConfigured(): Promise<AplConfiguredResult> {
    return this.envVariablesRequiredByMongoDBExist()
      ? { configured: true }
      : {
          configured: false,
          error: new MongoAPL.MissingEnvVariablesError("Missing MongoDB env variables"),
        };
  }

  private envVariablesRequiredByMongoDBExist(): boolean {
    return typeof env.MONGODB_URL === "string" && env.MONGODB_URL.length > 0;
  }

  /**
   * Tear down the shared `MongoClient`. Note: this affects EVERY caller of
   * `getMongoClient()` in the process — call this only from a graceful-
   * shutdown handler or from test teardown.
   */
  async close(): Promise<void> {
    this.collectionPromise = null;
    await closeMongoClient();
  }
}
