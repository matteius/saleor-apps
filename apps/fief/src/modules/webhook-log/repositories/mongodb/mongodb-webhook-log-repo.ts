import { randomUUID } from "node:crypto";

import { type Collection, MongoServerError } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";
import { type DlqEntry, projectWebhookLogToDlqEntry } from "@/modules/dlq/dlq";

import { DLQ_COLLECTION, WEBHOOK_LOG_COLLECTION } from "../../migrations";
import {
  computeWebhookLogTtl,
  createWebhookLogId,
  type WebhookDirection,
  type WebhookEventId,
  type WebhookLog,
  type WebhookLogConnectionId,
  type WebhookLogId,
  type WebhookStatus,
} from "../../webhook-log";
import {
  type RecordAttemptResult,
  type RecordWebhookLogInput,
  type WebhookLogFilters,
  WebhookLogNotFoundError,
  type WebhookLogRepo,
  WebhookLogRepoError,
} from "../../webhook-log-repo";

/*
 * T11 — Mongo-backed implementation of `WebhookLogRepo`.
 *
 * Re-uses the shared `MongoClient` singleton (T3) so we don't double up
 * connection pools with the APL / T8 connections repo / T10 identity-map
 * repo / T32 reconciliation runner. The same lazy `Collection<...>`
 * caching pattern as `MongoAPL`: instantiate cheap, await the first
 * `getCollection()` once per process, reuse forever.
 *
 * Index assumptions are owned by `migrations.ts` (registered with T53's
 * runner under version `"005"`). This file does NOT call `createIndex`
 * on its own — the migration runner is the single point of schema
 * authority. Booting against an un-migrated database will surface a
 * clear "duplicate key on (saleorApiUrl,direction,eventId)" path
 * because the unique index is missing; production boot is expected to
 * call `runMigrations()` first.
 */

const logger = createLogger("modules.webhook-log.MongodbWebhookLogRepo");

interface MongoWebhookLogDoc {
  _id?: string;
  id: string;
  saleorApiUrl: string;
  connectionId: string;
  direction: WebhookDirection;
  eventId: string;
  eventType: string;
  status: WebhookStatus;
  attempts: number;
  lastError?: string;
  payloadRedacted: unknown;
  ttl: Date;
  createdAt: Date;
}

interface MongoDlqDoc {
  _id?: string;
  id: string;
  saleorApiUrl: string;
  connectionId: string;
  direction: WebhookDirection;
  eventId: string;
  eventType: string;
  status: WebhookStatus;
  attempts: number;
  lastError?: string;
  payloadRedacted: unknown;
  createdAt: Date;
  movedToDlqAt: Date;
}

const MAX_LIST_LIMIT = 1000;

const docToDomain = (doc: MongoWebhookLogDoc): WebhookLog => ({
  id: doc.id as unknown as WebhookLogId,
  saleorApiUrl: doc.saleorApiUrl as WebhookLog["saleorApiUrl"],
  connectionId: doc.connectionId as WebhookLogConnectionId,
  direction: doc.direction,
  eventId: doc.eventId as WebhookEventId,
  eventType: doc.eventType,
  status: doc.status,
  attempts: doc.attempts,
  lastError: doc.lastError,
  payloadRedacted: doc.payloadRedacted,
  ttl: doc.ttl,
  createdAt: doc.createdAt,
});

const domainToDoc = (row: WebhookLog): MongoWebhookLogDoc => ({
  id: String(row.id),
  saleorApiUrl: String(row.saleorApiUrl),
  connectionId: String(row.connectionId),
  direction: row.direction,
  eventId: String(row.eventId),
  eventType: row.eventType,
  status: row.status,
  attempts: row.attempts,
  lastError: row.lastError,
  payloadRedacted: row.payloadRedacted,
  ttl: row.ttl,
  createdAt: row.createdAt,
});

const dlqDomainToDoc = (entry: DlqEntry): MongoDlqDoc => ({
  id: String(entry.id),
  saleorApiUrl: String(entry.saleorApiUrl),
  connectionId: String(entry.connectionId),
  direction: entry.direction,
  eventId: String(entry.eventId),
  eventType: entry.eventType,
  status: entry.status,
  attempts: entry.attempts,
  lastError: entry.lastError,
  payloadRedacted: entry.payloadRedacted,
  createdAt: entry.createdAt,
  movedToDlqAt: entry.movedToDlqAt,
});

export class MongodbWebhookLogRepo implements WebhookLogRepo {
  private tracer = appInternalTracer;
  private collectionPromise: Promise<{
    webhookLog: Collection<MongoWebhookLogDoc>;
    dlq: Collection<MongoDlqDoc>;
  }> | null = null;

  private async getCollections() {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());

        return {
          webhookLog: db.collection<MongoWebhookLogDoc>(WEBHOOK_LOG_COLLECTION),
          dlq: db.collection<MongoDlqDoc>(DLQ_COLLECTION),
        };
      } catch (cause) {
        // Reset so the next caller retries from scratch.
        this.collectionPromise = null;
        throw new WebhookLogRepoError("Failed to access Mongo collections", { cause });
      }
    })();

    return this.collectionPromise;
  }

  async record(
    input: RecordWebhookLogInput,
  ): Promise<Result<WebhookLog, InstanceType<typeof WebhookLogRepoError>>> {
    return this.tracer.startActiveSpan("MongodbWebhookLogRepo.record", async (span) => {
      try {
        const { webhookLog } = await this.getCollections();
        const now = new Date();
        const row: WebhookLog = {
          id: createWebhookLogId(randomUUID())._unsafeUnwrap(),
          saleorApiUrl: input.saleorApiUrl,
          connectionId: input.connectionId,
          direction: input.direction,
          eventId: input.eventId,
          eventType: input.eventType,
          status: input.initialStatus ?? "retrying",
          attempts: 0,
          payloadRedacted: input.payloadRedacted,
          ttl: computeWebhookLogTtl(now),
          createdAt: now,
        };

        try {
          await webhookLog.insertOne(domainToDoc(row));
          span.end();

          return ok(row);
        } catch (cause) {
          /*
           * De-duplication race: another receiver inserted the same
           * (saleorApiUrl, direction, eventId) between our caller's
           * pre-flight check and our insertOne. Return the existing row
           * so the producer can short-circuit safely.
           */
          if (cause instanceof MongoServerError && cause.code === 11000) {
            const existing = await webhookLog.findOne({
              saleorApiUrl: String(input.saleorApiUrl),
              direction: input.direction,
              eventId: String(input.eventId),
            });

            span.end();

            if (existing) {
              return ok(docToDomain(existing));
            }

            return err(
              new WebhookLogRepoError(
                "Duplicate-key on insert but row not found on subsequent read",
                { cause },
              ),
            );
          }

          span.end();
          throw cause;
        }
      } catch (cause) {
        logger.error("record failed", { error: cause });

        return err(new WebhookLogRepoError("Failed to record webhook log", { cause }));
      }
    });
  }

  async dedupCheck(args: {
    saleorApiUrl: WebhookLog["saleorApiUrl"];
    direction: WebhookDirection;
    eventId: WebhookEventId;
  }): Promise<Result<boolean, InstanceType<typeof WebhookLogRepoError>>> {
    return this.tracer.startActiveSpan("MongodbWebhookLogRepo.dedupCheck", async (span) => {
      try {
        const { webhookLog } = await this.getCollections();
        const existing = await webhookLog.findOne(
          {
            saleorApiUrl: String(args.saleorApiUrl),
            direction: args.direction,
            eventId: String(args.eventId),
          },
          { projection: { _id: 1 } },
        );

        span.end();

        return ok(existing !== null);
      } catch (cause) {
        span.end();
        logger.error("de-duplication check failed", { error: cause });

        return err(new WebhookLogRepoError("Failed to de-duplicate webhook log", { cause }));
      }
    });
  }

  async recordAttempt(args: {
    id: WebhookLogId;
    maxAttempts: number;
    success?: boolean;
    error?: string;
  }): Promise<
    Result<
      RecordAttemptResult,
      InstanceType<typeof WebhookLogRepoError | typeof WebhookLogNotFoundError>
    >
  > {
    return this.tracer.startActiveSpan("MongodbWebhookLogRepo.recordAttempt", async (span) => {
      try {
        const { webhookLog } = await this.getCollections();
        const id = String(args.id);
        const current = await webhookLog.findOne({ id });

        if (!current) {
          span.end();

          return err(new WebhookLogNotFoundError(`webhook_log row ${id} not found`));
        }

        const newAttempts = current.attempts + 1;
        let newStatus: WebhookStatus;

        if (args.success === true) {
          newStatus = "ok";
        } else if (newAttempts >= args.maxAttempts) {
          newStatus = "dead";
        } else {
          newStatus = "retrying";
        }

        const update: Record<string, unknown> = {
          attempts: newAttempts,
          status: newStatus,
        };

        if (args.error !== undefined) {
          update.lastError = args.error;
        }

        const updated = await webhookLog.findOneAndUpdate(
          { id },
          { $set: update },
          { returnDocument: "after" },
        );

        span.end();

        if (!updated) {
          return err(new WebhookLogNotFoundError(`webhook_log row ${id} disappeared mid-update`));
        }

        return ok({
          row: docToDomain(updated),
          becameDead: newStatus === "dead",
        });
      } catch (cause) {
        span.end();
        logger.error("recordAttempt failed", { error: cause });

        return err(new WebhookLogRepoError("Failed to record attempt", { cause }));
      }
    });
  }

  async moveToDlq(
    id: WebhookLogId,
  ): Promise<
    Result<WebhookLogId, InstanceType<typeof WebhookLogRepoError | typeof WebhookLogNotFoundError>>
  > {
    return this.tracer.startActiveSpan("MongodbWebhookLogRepo.moveToDlq", async (span) => {
      try {
        const { webhookLog, dlq } = await this.getCollections();
        const idStr = String(id);
        const source = await webhookLog.findOne({ id: idStr });

        if (!source) {
          span.end();

          return err(new WebhookLogNotFoundError(`webhook_log row ${idStr} not found`));
        }

        const dlqEntry = projectWebhookLogToDlqEntry(docToDomain(source), new Date());

        /*
         * Insert-then-delete: a crash between the two leaves a duplicate
         * (one in dlq, one in webhook_log). The dashboard handles this
         * by de-duplicating on `id`, and the next dead-attempt sweep
         * will retry the move, which is a no-op because the dlq row's
         * `id` is the same. We deliberately do NOT use a session/txn
         * here — the memory-server doesn't support replica sets out of
         * the box, and the duplicate-on-crash is benign per the
         * analysis above.
         */
        try {
          await dlq.insertOne(dlqDomainToDoc(dlqEntry));
        } catch (cause) {
          if (cause instanceof MongoServerError && cause.code === 11000) {
            // DLQ row already exists (previous partial move) — fall through.
            logger.warn("moveToDlq: dlq row already present, skipping insert", { id: idStr });
          } else {
            throw cause;
          }
        }

        await webhookLog.deleteOne({ id: idStr });

        span.end();

        return ok(id);
      } catch (cause) {
        span.end();
        logger.error("moveToDlq failed", { error: cause });

        return err(new WebhookLogRepoError("Failed to move row to DLQ", { cause }));
      }
    });
  }

  async list(
    filters: WebhookLogFilters,
  ): Promise<Result<WebhookLog[], InstanceType<typeof WebhookLogRepoError>>> {
    return this.tracer.startActiveSpan("MongodbWebhookLogRepo.list", async (span) => {
      try {
        const { webhookLog } = await this.getCollections();
        const query: Record<string, unknown> = {};

        if (filters.saleorApiUrl) {
          query.saleorApiUrl = String(filters.saleorApiUrl);
        }
        if (filters.status) {
          query.status = filters.status;
        }
        if (filters.direction) {
          query.direction = filters.direction;
        }
        if (filters.eventType) {
          query.eventType = filters.eventType;
        }
        if (filters.createdAfter) {
          query.createdAt = { $gte: filters.createdAfter };
        }

        const limit = Math.min(filters.limit ?? 50, MAX_LIST_LIMIT);
        const docs = await webhookLog.find(query).sort({ createdAt: -1 }).limit(limit).toArray();

        span.end();

        return ok(docs.map(docToDomain));
      } catch (cause) {
        span.end();
        logger.error("list failed", { error: cause });

        return err(new WebhookLogRepoError("Failed to list webhook log rows", { cause }));
      }
    });
  }

  async getById(
    id: WebhookLogId,
  ): Promise<Result<WebhookLog | null, InstanceType<typeof WebhookLogRepoError>>> {
    return this.tracer.startActiveSpan("MongodbWebhookLogRepo.getById", async (span) => {
      try {
        const { webhookLog } = await this.getCollections();
        const doc = await webhookLog.findOne({ id: String(id) });

        span.end();

        return ok(doc ? docToDomain(doc) : null);
      } catch (cause) {
        span.end();
        logger.error("getById failed", { error: cause });

        return err(new WebhookLogRepoError("Failed to get webhook log row", { cause }));
      }
    });
  }
}
