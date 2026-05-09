/**
 * DynamoDB implementation of `PriceVariantMapRepo` (T10).
 *
 * Mirrors `dynamodb-subscription-repo.ts`. Uses the shared `DynamoMainTable`
 * via the entity from `price-variant-map-db-model.ts`.
 *
 * Lookup strategy (see price-variant-map-db-model.ts header for full rationale):
 *   - `get`: direct PK+SK GetItem (O(1)) — SK encodes the stripePriceId.
 *   - `list`: partition-scoped Query with SK begins-with `price-variant-map#`
 *     (used by T25 admin UI). No GSI needed.
 *
 * Contract: `get` returns `Ok(null)` for unknown price IDs (NOT an error) so
 * T14's `invoice.paid` handler can log + alert + skip-mint without unwrapping
 * an error case for the normal "Stripe price not yet mapped" outcome.
 */
import { DeleteItemCommand, GetItemCommand, Parser, PutItemCommand } from "dynamodb-toolbox";
import { QueryCommand } from "dynamodb-toolbox/table/actions/query";
import { err, ok, type Result } from "neverthrow";

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
import {
  DynamoDbPriceVariantMap,
  type DynamoDbPriceVariantMapEntity,
} from "./price-variant-map-db-model";

type ParsedRow = {
  PK: string;
  SK: string;
  stripePriceId: string;
  saleorVariantId: string;
  saleorChannelSlug: string;
  createdAt?: string;
  modifiedAt?: string;
};

const mapRowToMapping = (row: ParsedRow): PriceVariantMapping => ({
  stripePriceId: createStripePriceId(row.stripePriceId),
  saleorVariantId: createSaleorVariantId(row.saleorVariantId),
  saleorChannelSlug: createSaleorChannelSlug(row.saleorChannelSlug),
  createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  updatedAt: row.modifiedAt ? new Date(row.modifiedAt) : new Date(),
});

export class DynamoDbPriceVariantMapRepo implements PriceVariantMapRepo {
  private entity: DynamoDbPriceVariantMapEntity;

  private logger = createLogger("DynamoDbPriceVariantMapRepo");

  constructor(
    params = {
      entity: DynamoDbPriceVariantMap.entity,
    },
  ) {
    this.entity = params.entity;
  }

  async set(
    access: PriceVariantMapAccess,
    mapping: PriceVariantMapping,
  ): Promise<Result<null, PriceVariantMapError>> {
    try {
      this.logger.debug("Upserting price-variant mapping to DynamoDB", {
        stripePriceId: mapping.stripePriceId,
        saleorVariantId: mapping.saleorVariantId,
      });

      const operation = this.entity.build(PutItemCommand).item({
        PK: DynamoDbPriceVariantMap.accessPattern.getPK(access),
        SK: DynamoDbPriceVariantMap.accessPattern.getSKforSpecificItem({
          stripePriceId: mapping.stripePriceId,
        }),
        stripePriceId: mapping.stripePriceId,
        saleorVariantId: mapping.saleorVariantId,
        saleorChannelSlug: mapping.saleorChannelSlug,
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode === 200) {
        this.logger.debug("Successfully upserted price-variant mapping to DynamoDB", {
          stripePriceId: mapping.stripePriceId,
        });

        return ok(null);
      }

      throw new BaseError("Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode, {
        cause: result,
      });
    } catch (e) {
      this.logger.error("Failed to upsert price-variant mapping to DynamoDB", {
        error: e,
      });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to upsert price-variant mapping to DynamoDB",
          {
            cause: e,
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
      const operation = this.entity.build(GetItemCommand).key({
        PK: DynamoDbPriceVariantMap.accessPattern.getPK(access),
        SK: DynamoDbPriceVariantMap.accessPattern.getSKforSpecificItem({
          stripePriceId,
        }),
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode !== 200) {
        return err(
          new PriceVariantMapError.PersistenceFailedError(
            "Failed to read data from DynamoDB. HTTP status code: " +
              result.$metadata.httpStatusCode,
            {
              cause: result,
            },
          ),
        );
      }

      if (!result.Item) {
        return ok(null);
      }

      return ok(mapRowToMapping(result.Item as ParsedRow));
    } catch (e) {
      this.logger.error("Failed to fetch price-variant mapping by stripePriceId from DynamoDB", {
        error: e,
      });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to fetch price-variant mapping from DynamoDB",
          {
            cause: e,
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
      const operation = this.entity.build(DeleteItemCommand).key({
        PK: DynamoDbPriceVariantMap.accessPattern.getPK(access),
        SK: DynamoDbPriceVariantMap.accessPattern.getSKforSpecificItem({
          stripePriceId,
        }),
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode !== 200) {
        throw new BaseError(
          "Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode,
          {
            cause: result,
          },
        );
      }

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to delete price-variant mapping from DynamoDB", {
        error: e,
      });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to delete price-variant mapping from DynamoDB",
          {
            cause: e,
          },
        ),
      );
    }
  }

  async list(
    access: PriceVariantMapAccess,
  ): Promise<Result<PriceVariantMapping[], PriceVariantMapError>> {
    try {
      const queryCmd = this.entity.table
        .build(QueryCommand)
        .entities(this.entity)
        .query({
          partition: DynamoDbPriceVariantMap.accessPattern.getPK(access),
          range: {
            beginsWith: DynamoDbPriceVariantMap.accessPattern.getSKforAllMappings(),
          },
        })
        .options({
          maxPages: Infinity,
        });

      const result = await queryCmd.send();

      const items = result.Items ?? [];

      const mappings = items.map((row) => {
        const parsed = DynamoDbPriceVariantMap.entitySchema.build(Parser).parse(row) as ParsedRow;

        return mapRowToMapping(parsed);
      });

      return ok(mappings);
    } catch (e) {
      this.logger.error("Failed to list price-variant mappings from DynamoDB", {
        error: e,
      });

      return err(
        new PriceVariantMapError.PersistenceFailedError(
          "Failed to list price-variant mappings from DynamoDB",
          {
            cause: e,
          },
        ),
      );
    }
  }
}
