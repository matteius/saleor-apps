import { type Collection } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";
import { DLQ_COLLECTION } from "@/modules/webhook-log/migrations";

import {
  type DlqEntry,
  type DlqEntryId,
  type WebhookDirection,
  type WebhookEventId,
  type WebhookLogConnectionId,
  type WebhookStatus,
} from "../../dlq";
import { type DlqFilters, DlqNotFoundError, type DlqRepo, DlqRepoError } from "../../dlq-repo";

/*
 * T11 — Mongo-backed implementation of `DlqRepo`.
 *
 * Read-mostly. Producer is `MongodbWebhookLogRepo.moveToDlq()` (which
 * calls `add(...)` here as part of its insert-then-delete dance). The
 * dashboard (T37) calls `list / getById / delete`; T51's replay
 * tooling reads via `list / getById`, then re-records via the upstream
 * receiver path (which goes back through `WebhookLogRepo.record`).
 *
 * No TTL on this collection — see `migrations.ts` and the design note
 * in `dlq.ts`. DLQ rows persist until manual operator action.
 */

const logger = createLogger("modules.dlq.MongodbDlqRepo");

interface MongoDlqDoc {
  _id?: string;
  id: string;
  saleorApiUrl: string;
  connectionId: string;
  direction: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  lastError?: string;
  payloadRedacted: unknown;
  createdAt: Date;
  movedToDlqAt: Date;
}

const MAX_LIST_LIMIT = 1000;

const docToDomain = (doc: MongoDlqDoc): DlqEntry => ({
  id: doc.id as unknown as DlqEntryId,
  saleorApiUrl: doc.saleorApiUrl as DlqEntry["saleorApiUrl"],
  connectionId: doc.connectionId as WebhookLogConnectionId,
  direction: doc.direction as WebhookDirection,
  eventId: doc.eventId as WebhookEventId,
  eventType: doc.eventType,
  status: doc.status as WebhookStatus,
  attempts: doc.attempts,
  lastError: doc.lastError,
  payloadRedacted: doc.payloadRedacted,
  createdAt: doc.createdAt,
  movedToDlqAt: doc.movedToDlqAt,
});

export class MongodbDlqRepo implements DlqRepo {
  private tracer = appInternalTracer;
  private collectionPromise: Promise<Collection<MongoDlqDoc>> | null = null;

  private async getCollection() {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());

        return db.collection<MongoDlqDoc>(DLQ_COLLECTION);
      } catch (cause) {
        this.collectionPromise = null;
        throw new DlqRepoError("Failed to access DLQ collection", { cause });
      }
    })();

    return this.collectionPromise;
  }

  async add(entry: DlqEntry): Promise<Result<void, InstanceType<typeof DlqRepoError>>> {
    return this.tracer.startActiveSpan("MongodbDlqRepo.add", async (span) => {
      try {
        const collection = await this.getCollection();

        await collection.insertOne({
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

        span.end();

        return ok(undefined);
      } catch (cause) {
        span.end();
        logger.error("add failed", { error: cause });

        return err(new DlqRepoError("Failed to add DLQ row", { cause }));
      }
    });
  }

  async list(filters: DlqFilters): Promise<Result<DlqEntry[], InstanceType<typeof DlqRepoError>>> {
    return this.tracer.startActiveSpan("MongodbDlqRepo.list", async (span) => {
      try {
        const collection = await this.getCollection();
        const query: Record<string, unknown> = {};

        if (filters.saleorApiUrl) {
          query.saleorApiUrl = String(filters.saleorApiUrl);
        }
        if (filters.movedAfter) {
          query.movedToDlqAt = { $gte: filters.movedAfter };
        }

        const limit = Math.min(filters.limit ?? 50, MAX_LIST_LIMIT);
        const docs = await collection.find(query).sort({ movedToDlqAt: -1 }).limit(limit).toArray();

        span.end();

        return ok(docs.map(docToDomain));
      } catch (cause) {
        span.end();
        logger.error("list failed", { error: cause });

        return err(new DlqRepoError("Failed to list DLQ rows", { cause }));
      }
    });
  }

  async getById(
    id: DlqEntryId,
  ): Promise<Result<DlqEntry | null, InstanceType<typeof DlqRepoError>>> {
    return this.tracer.startActiveSpan("MongodbDlqRepo.getById", async (span) => {
      try {
        const collection = await this.getCollection();
        const doc = await collection.findOne({ id: String(id) });

        span.end();

        return ok(doc ? docToDomain(doc) : null);
      } catch (cause) {
        span.end();
        logger.error("getById failed", { error: cause });

        return err(new DlqRepoError("Failed to get DLQ row", { cause }));
      }
    });
  }

  async delete(
    id: DlqEntryId,
  ): Promise<Result<void, InstanceType<typeof DlqRepoError | typeof DlqNotFoundError>>> {
    return this.tracer.startActiveSpan("MongodbDlqRepo.delete", async (span) => {
      try {
        const collection = await this.getCollection();
        const result = await collection.deleteOne({ id: String(id) });

        span.end();

        if (result.deletedCount === 0) {
          return err(new DlqNotFoundError(`DLQ row ${String(id)} not found`));
        }

        return ok(undefined);
      } catch (cause) {
        span.end();
        logger.error("delete failed", { error: cause });

        return err(new DlqRepoError("Failed to delete DLQ row", { cause }));
      }
    });
  }
}
