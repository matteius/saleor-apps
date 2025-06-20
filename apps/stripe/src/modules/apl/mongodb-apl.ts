import { APL, AplConfiguredResult, AplReadyResult, AuthData } from "@saleor/app-sdk/APL";
import { Collection, Db, MongoClient } from "mongodb";

import { env } from "@/lib/env";
import { BaseError, ValueError } from "@/lib/errors";
import { appInternalTracer } from "@/lib/tracing";
import { createSaleorApiUrl, SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

interface MongoAuthData extends AuthData {
  _id?: string;
}

export class MongoAPL implements APL {
  static GetAuthDataError = BaseError.subclass("GetAuthDataError");
  static SetAuthDataError = BaseError.subclass("SetAuthDataError");
  static DeleteAuthDataError = BaseError.subclass("DeleteAuthDataError");
  static GetAllAuthDataError = BaseError.subclass("GetAllAuthDataError");
  static MissingEnvVariablesError = BaseError.subclass("MissingEnvVariablesError");
  static ConnectionError = BaseError.subclass("ConnectionError");

  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoAuthData> | null = null;
  private connectionPromise: Promise<void> | null = null;

  private tracer = appInternalTracer;

  constructor() {
    // Don't connect immediately - wait until first use
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongoAPL.MissingEnvVariablesError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.collection = this.db.collection<MongoAuthData>("apl_auth_data");

      // Create index on saleorApiUrl for faster queries
      await this.collection.createIndex({ saleorApiUrl: 1 }, { unique: true });
    } catch (error) {
      throw new MongoAPL.ConnectionError("Failed to connect to MongoDB", {
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
      throw new MongoAPL.ConnectionError("MongoDB connection not established");
    }
  }

  async get(saleorApiUrl: SaleorApiUrl | string): Promise<AuthData | undefined> {
    const saleorApiUrlParsed = createSaleorApiUrl(saleorApiUrl);

    if (saleorApiUrlParsed.isErr()) {
      throw new ValueError("Value Error: Provided saleorApiUrl is invalid.");
    }

    return this.tracer.startActiveSpan("MongoAPL.get", async (span) => {
      try {
        await this.ensureConnection();

        const result = await this.collection!.findOne({
          saleorApiUrl: saleorApiUrlParsed.value,
        });

        span.end();

        if (!result) {
          return undefined;
        }

        // Remove MongoDB _id field from the result
        const { _id, ...authData } = result;

        return authData;
      } catch (error) {
        span.end();

        throw new MongoAPL.GetAuthDataError("Failed to get APL entry", {
          cause: error,
        });
      }
    });
  }

  async set(authData: AuthData): Promise<void> {
    return this.tracer.startActiveSpan("MongoAPL.set", async (span) => {
      try {
        await this.ensureConnection();

        await this.collection!.replaceOne({ saleorApiUrl: authData.saleorApiUrl }, authData, {
          upsert: true,
        });

        span.end();
      } catch (error) {
        span.end();
        throw new MongoAPL.SetAuthDataError("Failed to set APL entry", {
          cause: error,
        });
      }
    });
  }

  async delete(saleorApiUrl: string): Promise<void> {
    const saleorApiUrlParsed = createSaleorApiUrl(saleorApiUrl);

    if (saleorApiUrlParsed.isErr()) {
      throw new ValueError("Value Error: Provided saleorApiUrl is invalid.");
    }

    return this.tracer.startActiveSpan("MongoAPL.delete", async (span) => {
      try {
        await this.ensureConnection();

        await this.collection!.deleteOne({
          saleorApiUrl: saleorApiUrlParsed.value,
        });

        span.end();
      } catch (error) {
        span.end();
        throw new MongoAPL.DeleteAuthDataError("Failed to delete APL entry", {
          cause: error,
        });
      }
    });
  }

  async getAll(): Promise<AuthData[]> {
    return this.tracer.startActiveSpan("MongoAPL.getAll", async (span) => {
      try {
        await this.ensureConnection();

        const results = await this.collection!.find({}).toArray();

        span.end();

        // Remove MongoDB _id field from all results
        return results.map(({ _id, ...authData }) => authData);
      } catch (error) {
        span.end();
        throw new MongoAPL.GetAllAuthDataError("Failed to get all APL entries", {
          cause: error,
        });
      }
    });
  }

  async isReady(): Promise<AplReadyResult> {
    try {
      await this.ensureConnection();
      // Test the connection by pinging the database
      await this.db!.admin().ping();

      return {
        ready: true,
      };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error : new MongoAPL.ConnectionError("Unknown error"),
      };
    }
  }

  async isConfigured(): Promise<AplConfiguredResult> {
    const configured = this.envVariablesRequiredByMongoDBExist();

    return configured
      ? {
          configured: true,
        }
      : {
          configured: false,
          error: new MongoAPL.MissingEnvVariablesError("Missing MongoDB env variables"),
        };
  }

  private envVariablesRequiredByMongoDBExist() {
    return typeof env.MONGODB_URL === "string" && env.MONGODB_URL.length > 0;
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
