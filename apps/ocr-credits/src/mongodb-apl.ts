import { APL, AplConfiguredResult, AplReadyResult, AuthData } from "@saleor/app-sdk/APL";
import { Collection, Db, MongoClient } from "mongodb";

import { env } from "./env";
import { BaseError } from "./errors";

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

  constructor() {
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongoAPL.MissingEnvVariablesError("MONGODB_URL is required");
      }

      // eslint-disable-next-line no-console
      console.log("MongoAPL: Attempting to connect to MongoDB...");
      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();
      // eslint-disable-next-line no-console
      console.log("MongoAPL: Successfully connected to MongoDB");

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_ocr_credits");
      this.collection = this.db.collection<MongoAuthData>("apl_auth_data");

      await this.collection.createIndex({ saleorApiUrl: 1 }, { unique: true });
      // eslint-disable-next-line no-console
      console.log("MongoAPL: Index created successfully");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("MongoAPL: Connection failed:", error);

      if (this.client) {
        try {
          await this.client.close();
        } catch (closeError) {
          // eslint-disable-next-line no-console
          console.error("MongoAPL: Error closing client after connection failure:", closeError);
        }
        this.client = null;
      }
      this.db = null;
      this.collection = null;
      this.connectionPromise = null;

      throw new MongoAPL.ConnectionError("Failed to connect to MongoDB", { cause: error });
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

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    try {
      await this.ensureConnection();
      const result = await this.collection!.findOne({ saleorApiUrl });

      if (!result) {
        return undefined;
      }

      const { _id, ...authData } = result;

      return authData;
    } catch (error) {
      throw new MongoAPL.GetAuthDataError("Failed to get APL entry", { cause: error });
    }
  }

  async set(authData: AuthData): Promise<void> {
    try {
      // eslint-disable-next-line no-console
      console.log("MongoAPL: Setting auth data for:", authData.saleorApiUrl);
      await this.ensureConnection();

      await this.collection!.replaceOne(
        { saleorApiUrl: authData.saleorApiUrl },
        authData,
        { upsert: true },
      );

      // eslint-disable-next-line no-console
      console.log("MongoAPL: Auth data set successfully");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("MongoAPL: Failed to set auth data:", error);

      throw new MongoAPL.SetAuthDataError("Failed to set APL entry", { cause: error });
    }
  }

  async delete(saleorApiUrl: string): Promise<void> {
    try {
      await this.ensureConnection();
      await this.collection!.deleteOne({ saleorApiUrl });
    } catch (error) {
      throw new MongoAPL.DeleteAuthDataError("Failed to delete APL entry", { cause: error });
    }
  }

  async getAll(): Promise<AuthData[]> {
    try {
      await this.ensureConnection();
      const results = await this.collection!.find({}).toArray();

      return results.map(({ _id, ...authData }) => authData);
    } catch (error) {
      throw new MongoAPL.GetAllAuthDataError("Failed to get all APL entries", { cause: error });
    }
  }

  async isReady(): Promise<AplReadyResult> {
    try {
      await this.ensureConnection();
      await this.db!.admin().ping();

      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error : new MongoAPL.ConnectionError("Unknown error"),
      };
    }
  }

  async isConfigured(): Promise<AplConfiguredResult> {
    const configured = typeof env.MONGODB_URL === "string" && env.MONGODB_URL.length > 0;

    return configured
      ? { configured: true }
      : { configured: false, error: new MongoAPL.MissingEnvVariablesError("Missing MONGODB_URL") };
  }
}

