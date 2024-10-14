import {
  type APL,
  type AplConfiguredResult,
  type AplReadyResult,
  type AuthData,
} from "@saleor/app-sdk/APL";
import { createClient, type RedisClientType } from "redis";

export class RedisAPL implements APL {
  private client: RedisClientType;
  private connectionPromise: Promise<void>;

  constructor({ url }: { url: string }) {
    this.client = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error("Redis connection failed after 10 retries");
            return new Error("Redis connection failed");
          }
          return Math.min(retries * 100, 3000);
        },
      },
    }) as RedisClientType;

    this.client.on("error", (err) => console.error("Redis Client Error", err));

    this.connectionPromise = this.connect();
  }

  private async connect() {
    try {
      await this.client.connect();
      console.log("Connected to Redis");
    } catch (error) {
      console.error("Failed to connect to Redis", error);
      throw error;
    }
  }

  private prepareAuthDataKey(apiUrl: string): string {
    return `APP_SMTP:${apiUrl}`;
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    await this.connectionPromise;
    try {
      const response = await this.client.get(this.prepareAuthDataKey(saleorApiUrl));

      if (response) {
        return JSON.parse(response) as AuthData;
      }
      return undefined;
    } catch (error) {
      console.error("Error getting auth data from Redis", error);
      throw error;
    }
  }

  async set(authData: AuthData): Promise<void> {
    await this.connectionPromise;
    try {
      await this.client.set(
        this.prepareAuthDataKey(authData.saleorApiUrl),
        JSON.stringify(authData),
      );
    } catch (error) {
      console.error("Error setting auth data in Redis", error);
      throw error;
    }
  }

  async delete(saleorApiUrl: string): Promise<void> {
    await this.connectionPromise;
    try {
      await this.client.del(this.prepareAuthDataKey(saleorApiUrl));
    } catch (error) {
      console.error("Error deleting auth data from Redis", error);
      throw error;
    }
  }

  async getAll(): Promise<AuthData[]> {
    throw new Error("Not implemented.");
  }

  async isReady(): Promise<AplReadyResult> {
    try {
      await this.connectionPromise;
      await this.client.ping();
      return { ready: true };
    } catch (error) {
      return { ready: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async isConfigured(): Promise<AplConfiguredResult> {
    /*
     * This method should be implemented based on your configuration logic
     * For now, we'll assume it's always configured if we can create a client
     */
    return { configured: true };
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
