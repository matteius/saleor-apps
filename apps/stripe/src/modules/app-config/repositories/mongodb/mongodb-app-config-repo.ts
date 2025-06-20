import { Collection, Db, MongoClient } from "mongodb";
import { err, ok, Result } from "neverthrow";

import { Encryptor } from "@/lib/encryptor";
import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { AppRootConfig } from "@/modules/app-config/domain/app-root-config";
import { StripeConfig } from "@/modules/app-config/domain/stripe-config";
import {
  AppConfigRepo,
  AppConfigRepoError,
  BaseAccessPattern,
  GetStripeConfigAccessPattern,
} from "@/modules/app-config/repositories/app-config-repo";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { createStripePublishableKey } from "@/modules/stripe/stripe-publishable-key";
import { createStripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";
import { createStripeWebhookSecret } from "@/modules/stripe/stripe-webhook-secret";

interface MongoStripeConfig {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  configId: string;
  configName: string;
  stripePk: string;
  stripeRk: string; // encrypted
  stripeWhId: string;
  stripeWhSecret: string; // encrypted
}

interface MongoChannelConfigMapping {
  _id?: string;
  saleorApiUrl: string;
  appId: string;
  channelId: string;
  configId?: string;
}

export class MongodbAppConfigRepo implements AppConfigRepo {
  private logger = createLogger("MongodbAppConfigRepo");
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private stripeConfigCollection: Collection<MongoStripeConfig> | null = null;
  private channelMappingCollection: Collection<MongoChannelConfigMapping> | null = null;
  private connectionPromise: Promise<void> | null = null;
  private encryptor: Encryptor;

  static ConnectionError = BaseError.subclass("ConnectionError");

  constructor(encryptor: Encryptor = new Encryptor()) {
    this.encryptor = encryptor;
    this.connectionPromise = null;
  }

  private async connect(): Promise<void> {
    try {
      if (!env.MONGODB_URL) {
        throw new MongodbAppConfigRepo.ConnectionError("MONGODB_URL is required");
      }

      this.client = new MongoClient(env.MONGODB_URL);
      await this.client.connect();

      this.db = this.client.db(env.MONGODB_DATABASE || "saleor_stripe");
      this.stripeConfigCollection = this.db.collection<MongoStripeConfig>("stripe_configs");
      this.channelMappingCollection =
        this.db.collection<MongoChannelConfigMapping>("channel_config_mappings");

      // Create indexes for faster queries
      await this.stripeConfigCollection.createIndex(
        { saleorApiUrl: 1, appId: 1, configId: 1 },
        { unique: true },
      );
      await this.channelMappingCollection.createIndex(
        { saleorApiUrl: 1, appId: 1, channelId: 1 },
        { unique: true },
      );
    } catch (error) {
      throw new MongodbAppConfigRepo.ConnectionError("Failed to connect to MongoDB", {
        cause: error,
      });
    }
  }

  private async ensureConnection(): Promise<void> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.connect();
    }
    await this.connectionPromise;
    if (!this.stripeConfigCollection || !this.channelMappingCollection) {
      throw new MongodbAppConfigRepo.ConnectionError("MongoDB connection not established");
    }
  }

  async saveStripeConfig({
    config,
    saleorApiUrl,
    appId,
  }: {
    config: StripeConfig;
    saleorApiUrl: SaleorApiUrl;
    appId: string;
  }): Promise<Result<void | null, InstanceType<typeof AppConfigRepoError.FailureSavingConfig>>> {
    try {
      await this.ensureConnection();

      const mongoConfig: MongoStripeConfig = {
        saleorApiUrl,
        appId,
        configId: config.id,
        configName: config.name,
        stripePk: config.publishableKey,
        stripeRk: this.encryptor.encrypt(config.restrictedKey),
        stripeWhId: config.webhookId,
        stripeWhSecret: this.encryptor.encrypt(config.webhookSecret),
      };

      await this.stripeConfigCollection!.replaceOne(
        { saleorApiUrl, appId, configId: config.id },
        mongoConfig,
        { upsert: true },
      );

      this.logger.info("Saved config to MongoDB", {
        configId: config.id,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to save config to MongoDB", { cause: error });

      return err(
        new AppConfigRepoError.FailureSavingConfig("Failed to save config to MongoDB", {
          cause: error,
        }),
      );
    }
  }

  async getStripeConfig(
    access: GetStripeConfigAccessPattern,
  ): Promise<
    Result<StripeConfig | null, InstanceType<typeof AppConfigRepoError.FailureFetchingConfig>>
  > {
    try {
      await this.ensureConnection();

      let configId: string | undefined;

      if ("configId" in access) {
        configId = access.configId;
      } else if ("channelId" in access) {
        // First, get the config ID from the channel mapping
        const mapping = await this.channelMappingCollection!.findOne({
          saleorApiUrl: access.saleorApiUrl,
          appId: access.appId,
          channelId: access.channelId,
        });

        if (!mapping || !mapping.configId) {
          return ok(null);
        }

        configId = mapping.configId;
      }

      if (!configId) {
        return ok(null);
      }

      const mongoConfig = await this.stripeConfigCollection!.findOne({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        configId,
      });

      if (!mongoConfig) {
        return ok(null);
      }

      // Decrypt and create StripeConfig
      const configResult = StripeConfig.create({
        name: mongoConfig.configName,
        restrictedKey: createStripeRestrictedKey(
          this.encryptor.decrypt(mongoConfig.stripeRk),
        )._unsafeUnwrap(),
        webhookId: mongoConfig.stripeWhId,
        id: mongoConfig.configId,
        publishableKey: createStripePublishableKey(mongoConfig.stripePk)._unsafeUnwrap(),
        webhookSecret: createStripeWebhookSecret(
          this.encryptor.decrypt(mongoConfig.stripeWhSecret),
        )._unsafeUnwrap(),
      });

      if (configResult.isErr()) {
        throw new BaseError("Failed to parse config from MongoDB", {
          cause: configResult.error,
        });
      }

      return ok(configResult.value);
    } catch (error) {
      this.logger.error("Failed to fetch config from MongoDB", { cause: error });

      return err(
        new AppConfigRepoError.FailureFetchingConfig(
          "Error fetching specific config from MongoDB",
          {
            cause: error,
          },
        ),
      );
    }
  }

  async getRootConfig(
    access: BaseAccessPattern,
  ): Promise<Result<AppRootConfig, InstanceType<typeof AppConfigRepoError.FailureFetchingConfig>>> {
    try {
      await this.ensureConnection();

      // Fetch all configs for this app
      const configs = await this.stripeConfigCollection!.find({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
      }).toArray();

      // Fetch all channel mappings for this app
      const mappings = await this.channelMappingCollection!.find({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
      }).toArray();

      // Build channel to config mapping
      const channelToConfigMapping = mappings.reduce(
        (record, mapping) => {
          if (mapping.configId) {
            record[mapping.channelId] = mapping.configId;
          }

          return record;
        },
        {} as Record<string, string>,
      );

      // Build config ID to config mapping
      const configIdToConfigMapping = configs.reduce(
        (record, mongoConfig) => {
          const configResult = StripeConfig.create({
            name: mongoConfig.configName,
            restrictedKey: createStripeRestrictedKey(
              this.encryptor.decrypt(mongoConfig.stripeRk),
            )._unsafeUnwrap(),
            webhookId: mongoConfig.stripeWhId,
            id: mongoConfig.configId,
            publishableKey: createStripePublishableKey(mongoConfig.stripePk)._unsafeUnwrap(),
            webhookSecret: createStripeWebhookSecret(
              this.encryptor.decrypt(mongoConfig.stripeWhSecret),
            )._unsafeUnwrap(),
          });

          if (configResult.isOk()) {
            record[mongoConfig.configId] = configResult.value;
          }

          return record;
        },
        {} as Record<string, StripeConfig>,
      );

      const rootConfig = new AppRootConfig(channelToConfigMapping, configIdToConfigMapping);

      return ok(rootConfig);
    } catch (error) {
      this.logger.error("Failed to fetch RootConfig from MongoDB", { cause: error });

      return err(
        new AppConfigRepoError.FailureFetchingConfig("Error fetching RootConfig from MongoDB", {
          cause: error,
        }),
      );
    }
  }

  async removeConfig(
    access: BaseAccessPattern,
    data: {
      configId: string;
    },
  ): Promise<Result<null, InstanceType<typeof AppConfigRepoError.FailureRemovingConfig>>> {
    try {
      await this.ensureConnection();

      await this.stripeConfigCollection!.deleteOne({
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        configId: data.configId,
      });

      return ok(null);
    } catch (error) {
      return err(
        new AppConfigRepoError.FailureRemovingConfig("Failed to remove config from MongoDB", {
          cause: error,
        }),
      );
    }
  }

  async updateMapping(
    access: BaseAccessPattern,
    data: {
      configId: string | null;
      channelId: string;
    },
  ): Promise<Result<void | null, InstanceType<typeof AppConfigRepoError.FailureSavingConfig>>> {
    try {
      await this.ensureConnection();

      const mapping: MongoChannelConfigMapping = {
        saleorApiUrl: access.saleorApiUrl,
        appId: access.appId,
        channelId: data.channelId,
        configId: data.configId || undefined,
      };

      await this.channelMappingCollection!.replaceOne(
        { saleorApiUrl: access.saleorApiUrl, appId: access.appId, channelId: data.channelId },
        mapping,
        { upsert: true },
      );

      this.logger.info("Updated mapping in MongoDB", {
        configId: data.configId,
        channelId: data.channelId,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to update mapping in MongoDB", {
        error,
      });

      return err(
        new AppConfigRepoError.FailureSavingConfig("Failed to update mapping in MongoDB", {
          cause: error,
        }),
      );
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.stripeConfigCollection = null;
      this.channelMappingCollection = null;
    }
  }
}
