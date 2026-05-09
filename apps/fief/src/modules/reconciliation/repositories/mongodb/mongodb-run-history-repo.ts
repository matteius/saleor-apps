import { randomUUID } from "node:crypto";

import { type Collection, MongoServerError } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";
import {
  createProviderConnectionId,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { RECONCILIATION_RUNS_COLLECTION } from "../../migrations";
import { type RepairPerRowError, type RepairSummary } from "../../repair.use-case";
import {
  type ClaimResult,
  type CompleteInput,
  type ListRecentInput,
  type ReconciliationRunHistoryRepo,
  ReconciliationRunHistoryRepoError,
  type ReconciliationRunRow,
  type ReconciliationRunStatus,
} from "../../run-history-repo";

/*
 * T32 — Mongo-backed reconciliation run-history repo.
 *
 * Concurrent-run guard implementation
 * -----------------------------------
 * The collection has a unique partial index on
 * `{ saleorApiUrl, connectionId, status: "running" }` (see `migrations.ts`,
 * version "007"). `claim(...)` does:
 *
 *   1. `insertOne({ status: "running", ... })` — atomic, single-document.
 *      If another runner has already inserted a `running` row for this
 *      `(saleorApiUrl, connectionId)`, the unique partial index trips
 *      E11000 and we observe `claimed: false`.
 *   2. On E11000, fetch the existing `running` row to surface its `id`
 *      back to the caller (the UI can use it to correlate "another run is
 *      in flight" UX).
 *
 * This is the Mongo translation of "find-or-create-running-row" without
 * needing multi-document transactions — `insertOne` against a unique
 * index is the strongest single-document atomicity Mongo provides.
 *
 * Why a partial filter? Without `partialFilterExpression: { status:
 * "running" }`, the unique constraint would also block legitimate
 * back-to-back completed runs from sharing `(saleorApiUrl, connectionId)`.
 * The partial filter only enforces uniqueness while a row is `"running"`.
 */

const logger = createLogger("modules.reconciliation.MongodbReconciliationRunHistoryRepo");

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

interface MongoRunDoc {
  _id?: string;
  id: string;
  saleorApiUrl: string;
  connectionId: string;
  startedAt: Date;
  completedAt: Date | null;
  status: ReconciliationRunStatus;
  summary: RepairSummary;
  perRowErrors: Array<{ row: unknown; error: string }>;
  runError?: string;
}

const docToDomain = (doc: MongoRunDoc): ReconciliationRunRow => ({
  id: doc.id,
  saleorApiUrl: doc.saleorApiUrl as SaleorApiUrl,
  connectionId: createProviderConnectionId(doc.connectionId),
  startedAt: doc.startedAt,
  completedAt: doc.completedAt,
  status: doc.status,
  summary: doc.summary,
  perRowErrors: doc.perRowErrors as RepairPerRowError[],
  runError: doc.runError,
});

const summaryZero = (): RepairSummary => ({
  total: 0,
  repaired: 0,
  skipped: 0,
  failed: 0,
});

export class MongodbReconciliationRunHistoryRepo implements ReconciliationRunHistoryRepo {
  private tracer = appInternalTracer;
  private collectionPromise: Promise<Collection<MongoRunDoc>> | null = null;

  private async getCollection(): Promise<Collection<MongoRunDoc>> {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());

        return db.collection<MongoRunDoc>(RECONCILIATION_RUNS_COLLECTION);
      } catch (cause) {
        this.collectionPromise = null;
        throw new ReconciliationRunHistoryRepoError(
          "Failed to access reconciliation_runs collection",
          { cause },
        );
      }
    })();

    return this.collectionPromise;
  }

  async claim(input: {
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
    startedAt: Date;
  }): Promise<Result<ClaimResult, InstanceType<typeof ReconciliationRunHistoryRepoError>>> {
    return this.tracer.startActiveSpan(
      "MongodbReconciliationRunHistoryRepo.claim",
      async (span) => {
        try {
          const collection = await this.getCollection();
          const id = randomUUID();
          const doc: MongoRunDoc = {
            id,
            saleorApiUrl: String(input.saleorApiUrl),
            connectionId: String(input.connectionId),
            startedAt: input.startedAt,
            completedAt: null,
            status: "running",
            summary: summaryZero(),
            perRowErrors: [],
          };

          try {
            await collection.insertOne(doc);
            span.end();

            return ok({ claimed: true, row: docToDomain(doc) });
          } catch (cause) {
            if (cause instanceof MongoServerError && cause.code === 11000) {
              /*
               * Another runner holds the lock. Surface the existing row so
               * the caller can correlate "already running" with the active
               * run id.
               */
              const existing = await collection.findOne({
                saleorApiUrl: String(input.saleorApiUrl),
                connectionId: String(input.connectionId),
                status: "running",
              });

              span.end();

              if (existing) {
                return ok({ claimed: false, row: docToDomain(existing) });
              }

              /*
               * Race: the duplicate-key fired but the row is gone (TTL or
               * concurrent complete). Retry once.
               */
              try {
                await collection.insertOne({
                  ...doc,
                  id: randomUUID(),
                });

                return ok({ claimed: true, row: docToDomain(doc) });
              } catch (retryCause) {
                return err(
                  new ReconciliationRunHistoryRepoError(
                    "Claim failed: duplicate-key but no running row found",
                    { cause: retryCause },
                  ),
                );
              }
            }

            throw cause;
          }
        } catch (cause) {
          logger.error("claim failed", { error: cause });

          return err(
            new ReconciliationRunHistoryRepoError("Failed to claim reconciliation run", {
              cause,
            }),
          );
        }
      },
    );
  }

  async complete(
    input: CompleteInput,
  ): Promise<Result<ReconciliationRunRow, InstanceType<typeof ReconciliationRunHistoryRepoError>>> {
    return this.tracer.startActiveSpan(
      "MongodbReconciliationRunHistoryRepo.complete",
      async (span) => {
        try {
          const collection = await this.getCollection();
          const update: Partial<MongoRunDoc> = {
            status: input.status,
            completedAt: input.completedAt,
            summary: input.summary,
            perRowErrors: input.perRowErrors,
          };

          if (input.runError !== undefined) {
            update.runError = input.runError;
          }

          const result = await collection.findOneAndUpdate(
            { id: input.id },
            { $set: update },
            { returnDocument: "after" },
          );

          span.end();

          if (!result) {
            return err(
              new ReconciliationRunHistoryRepoError(
                `Reconciliation run ${input.id} not found on complete`,
              ),
            );
          }

          return ok(docToDomain(result));
        } catch (cause) {
          span.end();
          logger.error("complete failed", { error: cause });

          return err(
            new ReconciliationRunHistoryRepoError("Failed to complete reconciliation run", {
              cause,
            }),
          );
        }
      },
    );
  }

  async listRecent(
    input: ListRecentInput,
  ): Promise<
    Result<ReconciliationRunRow[], InstanceType<typeof ReconciliationRunHistoryRepoError>>
  > {
    return this.tracer.startActiveSpan(
      "MongodbReconciliationRunHistoryRepo.listRecent",
      async (span) => {
        try {
          const collection = await this.getCollection();
          const query: Record<string, unknown> = {
            saleorApiUrl: String(input.saleorApiUrl),
          };

          if (input.connectionId !== undefined) {
            query.connectionId = String(input.connectionId);
          }

          const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
          const docs = await collection.find(query).sort({ startedAt: -1 }).limit(limit).toArray();

          span.end();

          return ok(docs.map(docToDomain));
        } catch (cause) {
          span.end();
          logger.error("listRecent failed", { error: cause });

          return err(
            new ReconciliationRunHistoryRepoError("Failed to list reconciliation runs", {
              cause,
            }),
          );
        }
      },
    );
  }
}
