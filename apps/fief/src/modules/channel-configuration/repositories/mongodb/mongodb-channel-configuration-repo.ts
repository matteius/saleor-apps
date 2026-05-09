import { type Collection } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type ChannelConfiguration, channelConfigurationSchema } from "../../channel-configuration";
import {
  ChannelConfigurationRepoError,
  type ChannelConfigurationRepoErrorInstance,
  type IChannelConfigurationRepo,
} from "../../channel-configuration-repo";

/*
 * T9 — MongoDB implementation of the channel-configuration repo.
 *
 * One document per `saleorApiUrl`. Uniqueness is enforced by the
 * `{ saleorApiUrl: 1 }` unique index registered through T53 in
 * `../migrations.ts` — this class deliberately does NOT create indexes
 * lazily on first access (the pattern T3's APL uses). By the time storage
 * repos exist, the migration runner is the canonical schema owner.
 *
 * Reads strip Mongo's internal `_id` and re-parse via the Zod schema so the
 * domain type discipline holds end-to-end (a manual edit in Compass that
 * left `defaultConnectionId` as `""` will surface as a parse error rather
 * than a silent type-lie).
 */

const COLLECTION_NAME = "channel_configuration";

const logger = createLogger("modules.channel-configuration.mongodb-repo");

interface ChannelConfigurationDocument {
  _id?: unknown;
  saleorApiUrl: string;
  defaultConnectionId: string | null;
  overrides: Array<{
    channelSlug: string;
    connectionId: string;
  }>;
}

export class MongoChannelConfigurationRepo implements IChannelConfigurationRepo {
  private tracer = appInternalTracer;

  /*
   * Cache the `Collection` handle once obtained so repeat accesses skip the
   * `getMongoClient()` await + `db().collection()` lookup. Same pattern as
   * the APL repo; wiped per-instance lifetime, the Mongo singleton handles
   * pool reuse across instances.
   */
  private collectionPromise: Promise<Collection<ChannelConfigurationDocument>> | null = null;

  private async getCollection(): Promise<Collection<ChannelConfigurationDocument>> {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());

        return db.collection<ChannelConfigurationDocument>(COLLECTION_NAME);
      } catch (cause) {
        // Reset so next caller retries from scratch instead of awaiting a rejected promise.
        this.collectionPromise = null;
        throw cause;
      }
    })();

    return this.collectionPromise;
  }

  async get(
    saleorApiUrl: SaleorApiUrl,
  ): Promise<Result<ChannelConfiguration | null, ChannelConfigurationRepoErrorInstance>> {
    return this.tracer.startActiveSpan("MongoChannelConfigurationRepo.get", async (span) => {
      try {
        const collection = await this.getCollection();
        const doc = await collection.findOne({ saleorApiUrl });

        span.end();

        if (!doc) {
          return ok(null);
        }

        // Strip Mongo internals before re-parsing through the Zod schema.
        const { _id, ...rest } = doc;
        const parsed = channelConfigurationSchema.safeParse(rest);

        if (!parsed.success) {
          logger.error("channel_configuration document failed schema parse on read", {
            saleorApiUrl,
            issues: parsed.error.issues,
          });

          return err(
            new ChannelConfigurationRepoError(
              "Stored channel-configuration document does not match schema",
              { cause: parsed.error },
            ),
          );
        }

        return ok(parsed.data);
      } catch (cause) {
        span.end();

        return err(
          new ChannelConfigurationRepoError("Failed to read channel configuration", { cause }),
        );
      }
    });
  }

  async upsert(
    config: ChannelConfiguration,
  ): Promise<Result<void, ChannelConfigurationRepoErrorInstance>> {
    return this.tracer.startActiveSpan("MongoChannelConfigurationRepo.upsert", async (span) => {
      try {
        const collection = await this.getCollection();

        /*
         * Re-validate before write so a programmatic mistake in a calling
         * use-case (e.g. building the shape by hand from a tRPC payload)
         * fails fast with a parse error rather than silently writing junk.
         */
        const parsed = channelConfigurationSchema.parse(config);

        const document: ChannelConfigurationDocument = {
          saleorApiUrl: parsed.saleorApiUrl,
          defaultConnectionId: parsed.defaultConnectionId,
          overrides: parsed.overrides.map((override) => ({
            channelSlug: override.channelSlug,
            connectionId: override.connectionId,
          })),
        };

        await collection.replaceOne({ saleorApiUrl: parsed.saleorApiUrl }, document, {
          upsert: true,
        });

        span.end();

        return ok(undefined);
      } catch (cause) {
        span.end();

        return err(
          new ChannelConfigurationRepoError("Failed to upsert channel configuration", { cause }),
        );
      }
    });
  }
}
