import { APL, AplConfiguredResult, AplReadyResult, AuthData } from "@saleor/app-sdk/APL";
import { Collection, Db, MongoClient } from "mongodb";

import { env, isMongoDBConfigured } from "../../lib/env";

interface MongoAuthData extends AuthData {
  _id?: string;
}

export class MongoAPL implements APL {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<MongoAuthData> | null = null;
  private connectionPromise: Promise<void> | null = null;

  constructor() {
    // Don't connect immediately - wait until first use
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      const mongoUrl = env.MONGODB_URL;

      if (!mongoUrl) {
        throw new Error("MONGODB_URL is required");
      }

      this.client = new MongoClient(mongoUrl);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_smtp");
      this.collection = this.db.collection<MongoAuthData>("apl_auth_data");

      // Create index on saleorApiUrl for faster queries
      await this.collection.createIndex({ saleorApiUrl: 1 }, { unique: true });
    } catch (error) {
      throw new Error(`Failed to connect to MongoDB: ${error}`);
    }
  }

  private async ensureConnection(): Promise<void> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.connect();
    }
    await this.connectionPromise;
    if (!this.collection) {
      throw new Error("MongoDB connection not established");
    }
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    try {
      await this.ensureConnection();

      const result = await this.collection!.findOne({
        saleorApiUrl: saleorApiUrl,
      });

      if (!result) {
        return undefined;
      }

      // Remove MongoDB _id field from the result
      const { _id, ...authData } = result;

      return authData;
    } catch (error) {
      throw new Error(`Failed to get APL entry: ${error}`);
    }
  }

  async set(authData: AuthData): Promise<void> {
    try {
      await this.ensureConnection();

      await this.collection!.replaceOne({ saleorApiUrl: authData.saleorApiUrl }, authData, {
        upsert: true,
      });
    } catch (error) {
      throw new Error(`Failed to set APL entry: ${error}`);
    }
  }

  async delete(saleorApiUrl: string): Promise<void> {
    try {
      await this.ensureConnection();

      await this.collection!.deleteOne({
        saleorApiUrl: saleorApiUrl,
      });
    } catch (error) {
      throw new Error(`Failed to delete APL entry: ${error}`);
    }
  }

  async getAll(): Promise<AuthData[]> {
    try {
      await this.ensureConnection();

      const results = await this.collection!.find({}).toArray();

      // Remove MongoDB _id field from all results
      return results.map(({ _id, ...authData }) => authData);
    } catch (error) {
      throw new Error(`Failed to get all APL entries: ${error}`);
    }
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
        error: error instanceof Error ? error : new Error("Unknown error"),
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
          error: new Error("Missing MongoDB env variables"),
        };
  }

  private envVariablesRequiredByMongoDBExist() {
    return isMongoDBConfigured();
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
