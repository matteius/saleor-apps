/**
 * DynamoDB implementation of {@link FailedMintDlqRepo} (T32).
 *
 * Mirrors the existing T17 `dynamodb-refund-dlq-repo.ts` pattern and uses the
 * shared `DynamoMainTable` via the entity from `failed-mint-dlq-db-model.ts`.
 *
 * - `record`: PutItem upsert (initial write OR retry-update).
 * - `getById`: direct PK+SK GetItem (O(1)).
 * - `listPendingRetries`: partition-scoped Query with SK begins-with
 *   `failed-mint#`, filtered to `nextRetryAt <= cutoff`. The DLQ is expected
 *   to be empty 99% of the time so a Scan-equivalent is acceptable here.
 * - `delete`: PutItem-style DeleteItemCommand by the same key.
 * - `markFinalFailure`: read-then-PutItem (PutItem replaces; we preserve all
 *   fields and add `finalFailureAlertedAt`).
 */
import { DeleteItemCommand, GetItemCommand, Parser, PutItemCommand } from "dynamodb-toolbox";
import { QueryCommand } from "dynamodb-toolbox/table/actions/query";
import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  type FailedMintDlqAccess,
  type FailedMintDlqRepo,
  FailedMintDlqRepoError,
  type FailedMintRecord,
} from "../failed-mint-dlq-repo";
import { DynamoDbFailedMint, type DynamoDbFailedMintEntity } from "./failed-mint-dlq-db-model";

type ParsedRow = {
  PK: string;
  SK: string;
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  fiefUserId: string;
  saleorChannelSlug: string;
  saleorVariantId: string;
  amountCents: number;
  currency: string;
  taxCents: number;
  errorMessage: string;
  errorClass: string;
  attemptCount: number;
  nextRetryAt: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  invoicePayload: string;
  finalFailureAlertedAt?: number;
  createdAt?: string;
  modifiedAt?: string;
};

const mapRowToRecord = (row: ParsedRow): FailedMintRecord => ({
  stripeInvoiceId: row.stripeInvoiceId,
  stripeSubscriptionId: row.stripeSubscriptionId,
  stripeCustomerId: row.stripeCustomerId,
  fiefUserId: row.fiefUserId,
  saleorChannelSlug: row.saleorChannelSlug,
  saleorVariantId: row.saleorVariantId,
  amountCents: row.amountCents,
  currency: row.currency,
  taxCents: row.taxCents,
  errorMessage: row.errorMessage,
  errorClass: row.errorClass,
  attemptCount: row.attemptCount,
  nextRetryAt: row.nextRetryAt,
  firstAttemptAt: row.firstAttemptAt,
  lastAttemptAt: row.lastAttemptAt,
  invoicePayload: row.invoicePayload,
  finalFailureAlertedAt: row.finalFailureAlertedAt,
});

const recordToItem = (access: FailedMintDlqAccess, record: FailedMintRecord) => ({
  PK: DynamoDbFailedMint.accessPattern.getPK(access),
  SK: DynamoDbFailedMint.accessPattern.getSKforSpecificItem({
    stripeInvoiceId: record.stripeInvoiceId,
  }),
  stripeInvoiceId: record.stripeInvoiceId,
  stripeSubscriptionId: record.stripeSubscriptionId,
  stripeCustomerId: record.stripeCustomerId,
  fiefUserId: record.fiefUserId,
  saleorChannelSlug: record.saleorChannelSlug,
  saleorVariantId: record.saleorVariantId,
  amountCents: record.amountCents,
  currency: record.currency,
  taxCents: record.taxCents,
  errorMessage: record.errorMessage,
  errorClass: record.errorClass,
  attemptCount: record.attemptCount,
  nextRetryAt: record.nextRetryAt,
  firstAttemptAt: record.firstAttemptAt,
  lastAttemptAt: record.lastAttemptAt,
  invoicePayload: record.invoicePayload,
  ...(record.finalFailureAlertedAt !== undefined && {
    finalFailureAlertedAt: record.finalFailureAlertedAt,
  }),
});

export class DynamoDbFailedMintDlqRepo implements FailedMintDlqRepo {
  private entity: DynamoDbFailedMintEntity;
  private logger = createLogger("DynamoDbFailedMintDlqRepo");

  constructor(
    params = {
      entity: DynamoDbFailedMint.entity,
    },
  ) {
    this.entity = params.entity;
  }

  async record(
    access: FailedMintDlqAccess,
    record: FailedMintRecord,
  ): Promise<Result<null, FailedMintDlqRepoError>> {
    try {
      const operation = this.entity.build(PutItemCommand).item(recordToItem(access, record));

      const result = await operation.send();

      if (result.$metadata.httpStatusCode === 200) {
        return ok(null);
      }

      throw new BaseError("Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode, {
        cause: result,
      });
    } catch (e) {
      this.logger.error("Failed to write failed-mint DLQ entry to DynamoDB", { error: e });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to write failed-mint DLQ entry to DynamoDB",
          { cause: e },
        ),
      );
    }
  }

  async getById(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<FailedMintRecord | null, FailedMintDlqRepoError>> {
    try {
      const operation = this.entity.build(GetItemCommand).key({
        PK: DynamoDbFailedMint.accessPattern.getPK(access),
        SK: DynamoDbFailedMint.accessPattern.getSKforSpecificItem({ stripeInvoiceId }),
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode !== 200) {
        return err(
          new FailedMintDlqRepoError.PersistenceFailedError(
            "Failed to read failed-mint DLQ entry. HTTP status code: " +
              result.$metadata.httpStatusCode,
            { cause: result },
          ),
        );
      }

      if (!result.Item) {
        return ok(null);
      }

      return ok(mapRowToRecord(result.Item as ParsedRow));
    } catch (e) {
      this.logger.error("Failed to fetch failed-mint DLQ entry by stripeInvoiceId", { error: e });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to fetch failed-mint DLQ entry from DynamoDB",
          { cause: e },
        ),
      );
    }
  }

  async listPendingRetries(
    access: FailedMintDlqAccess,
    beforeUnixSeconds: number,
  ): Promise<Result<FailedMintRecord[], FailedMintDlqRepoError>> {
    try {
      const queryCmd = this.entity.table
        .build(QueryCommand)
        .entities(this.entity)
        .query({
          partition: DynamoDbFailedMint.accessPattern.getPK(access),
          range: {
            beginsWith: DynamoDbFailedMint.accessPattern.getSKforAllFailedMints(),
          },
        })
        .options({
          maxPages: Infinity,
          filters: {
            FailedMintDlq: { attr: "nextRetryAt", lte: beforeUnixSeconds },
          },
        });

      const result = await queryCmd.send();

      const items = result.Items ?? [];

      const records = items.map((row) => {
        const parsed = DynamoDbFailedMint.entitySchema.build(Parser).parse(row) as ParsedRow;

        return mapRowToRecord(parsed);
      });

      return ok(records);
    } catch (e) {
      this.logger.error("Failed to list pending failed-mint DLQ entries", { error: e });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to list pending failed-mint DLQ entries from DynamoDB",
          { cause: e },
        ),
      );
    }
  }

  async delete(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<null, FailedMintDlqRepoError>> {
    try {
      const operation = this.entity.build(DeleteItemCommand).key({
        PK: DynamoDbFailedMint.accessPattern.getPK(access),
        SK: DynamoDbFailedMint.accessPattern.getSKforSpecificItem({ stripeInvoiceId }),
      });

      const result = await operation.send();

      if (result.$metadata.httpStatusCode !== 200) {
        throw new BaseError(
          "Unexpected response from DynamoDB: " + result.$metadata.httpStatusCode,
          { cause: result },
        );
      }

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to delete failed-mint DLQ entry from DynamoDB", { error: e });

      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          "Failed to delete failed-mint DLQ entry from DynamoDB",
          { cause: e },
        ),
      );
    }
  }

  async markFinalFailure(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<null, FailedMintDlqRepoError>> {
    /*
     * Read-then-PutItem (vs UpdateItemCommand) so the rest of the row remains
     * dynamodb-toolbox-validated. The DLQ has at most O(failed mints) entries
     * so the extra round-trip is negligible.
     */
    const existing = await this.getById(access, stripeInvoiceId);

    if (existing.isErr()) {
      return err(existing.error);
    }

    if (!existing.value) {
      return err(
        new FailedMintDlqRepoError.PersistenceFailedError(
          `Cannot markFinalFailure on missing DLQ entry stripeInvoiceId=${stripeInvoiceId}`,
        ),
      );
    }

    const updated: FailedMintRecord = {
      ...existing.value,
      finalFailureAlertedAt: Math.floor(Date.now() / 1000),
    };

    return this.record(access, updated);
  }
}
