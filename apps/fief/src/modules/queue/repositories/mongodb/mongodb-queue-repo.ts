import { randomUUID } from "node:crypto";

import { type Collection, MongoServerError } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";

import { OUTBOUND_QUEUE_COLLECTION } from "../../migrations";
import {
  createQueueJobId,
  type EnqueueJobInput,
  type QueueJob,
  type QueueJobId,
  type QueuePeekFilters,
} from "../../queue";
import { type OutboundQueueRepo, QueueJobNotFoundError, QueueRepoError } from "../../queue-repo";

/*
 * T52 — Mongo-backed `OutboundQueueRepo`.
 *
 * Re-uses the shared `MongoClient` singleton (T3) and the lazy
 * `Collection<...>` caching pattern from T11's `MongodbWebhookLogRepo`.
 * Index assumptions are owned by `migrations.ts` (registered with T53's
 * runner under version `"006"`); this file does NOT call `createIndex`
 * on its own.
 *
 * Lease implementation:
 *   `findOneAndUpdate` with the filter
 *     `nextAttemptAt <= now AND (lockedUntil missing OR lockedUntil < now)`
 *   plus `sort: { nextAttemptAt: 1 }` and `returnDocument: "after"`.
 *   Mongo guarantees the operation is atomic — concurrent `lease()`
 *   calls on the same single eligible row see exactly one winner; the
 *   loser sees `null`.
 *
 * Enqueue idempotency:
 *   `insertOne` followed by E11000 catch + `findOne({ eventId })`. The
 *   unique index on `eventId` is the source of truth; the catch path
 *   re-reads so the producer always gets a fully-formed `QueueJob`
 *   back (whether it just inserted or someone else did).
 */

const logger = createLogger("modules.queue.MongodbOutboundQueueRepo");

interface MongoQueueDoc {
  _id?: string;
  id: string;
  saleorApiUrl: string;
  connectionId: string;
  eventType: string;
  eventId: string;
  payload: unknown;
  attempts: number;
  nextAttemptAt: Date;
  lockedBy?: string;
  lockedUntil?: Date;
  createdAt: Date;
}

const MAX_PEEK_LIMIT = 1000;

const docToDomain = (doc: MongoQueueDoc): QueueJob => ({
  id: doc.id as unknown as QueueJob["id"],
  saleorApiUrl: doc.saleorApiUrl as QueueJob["saleorApiUrl"],
  connectionId: doc.connectionId as QueueJob["connectionId"],
  eventType: doc.eventType,
  eventId: doc.eventId as QueueJob["eventId"],
  payload: doc.payload,
  attempts: doc.attempts,
  nextAttemptAt: doc.nextAttemptAt,
  lockedBy: doc.lockedBy,
  lockedUntil: doc.lockedUntil,
  createdAt: doc.createdAt,
});

export class MongodbOutboundQueueRepo implements OutboundQueueRepo {
  private tracer = appInternalTracer;
  private collectionPromise: Promise<Collection<MongoQueueDoc>> | null = null;

  private async getCollection() {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());

        return db.collection<MongoQueueDoc>(OUTBOUND_QUEUE_COLLECTION);
      } catch (cause) {
        this.collectionPromise = null;
        throw new QueueRepoError("Failed to access outbound_queue collection", { cause });
      }
    })();

    return this.collectionPromise;
  }

  async enqueue(
    input: EnqueueJobInput,
  ): Promise<Result<QueueJob, InstanceType<typeof QueueRepoError>>> {
    return this.tracer.startActiveSpan("MongodbOutboundQueueRepo.enqueue", async (span) => {
      try {
        const collection = await this.getCollection();
        const now = new Date();
        const job: QueueJob = {
          id: createQueueJobId(randomUUID())._unsafeUnwrap(),
          saleorApiUrl: input.saleorApiUrl,
          connectionId: input.connectionId,
          eventType: input.eventType,
          eventId: input.eventId,
          payload: input.payload,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
        };

        try {
          await collection.insertOne({
            id: String(job.id),
            saleorApiUrl: String(job.saleorApiUrl),
            connectionId: String(job.connectionId),
            eventType: job.eventType,
            eventId: String(job.eventId),
            payload: job.payload,
            attempts: job.attempts,
            nextAttemptAt: job.nextAttemptAt,
            createdAt: job.createdAt,
          });

          span.end();

          return ok(job);
        } catch (cause) {
          /*
           * Producer de-duplication race: another enqueue with the
           * same eventId landed first. Re-read by eventId and return
           * the existing row so the producer can short-circuit safely
           * without re-asking what the persisted job looks like.
           */
          if (cause instanceof MongoServerError && cause.code === 11000) {
            const existing = await collection.findOne({ eventId: String(input.eventId) });

            span.end();

            if (existing) {
              return ok(docToDomain(existing));
            }

            return err(
              new QueueRepoError("Duplicate-key on enqueue but row not found on subsequent read", {
                cause,
              }),
            );
          }

          span.end();
          throw cause;
        }
      } catch (cause) {
        logger.error("enqueue failed", { error: cause });

        return err(new QueueRepoError("Failed to enqueue job", { cause }));
      }
    });
  }

  async lease(
    workerId: string,
    leaseMs: number,
  ): Promise<Result<QueueJob | null, InstanceType<typeof QueueRepoError>>> {
    return this.tracer.startActiveSpan("MongodbOutboundQueueRepo.lease", async (span) => {
      try {
        const collection = await this.getCollection();
        const now = new Date();
        const lockedUntil = new Date(now.getTime() + leaseMs);

        /*
         * Atomic lease: `findOneAndUpdate` with sort gives us "next
         * eligible row, locked in one shot". Filter:
         *
         *   - `nextAttemptAt <= now` — job is due.
         *   - either `lockedUntil` is missing (never leased / cleanly
         *     released) or `lockedUntil < now` (lease expired, e.g.
         *     because a previous worker crashed).
         */
        const updated = await collection.findOneAndUpdate(
          {
            nextAttemptAt: { $lte: now },
            $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }],
          },
          {
            $set: {
              lockedBy: workerId,
              lockedUntil,
            },
          },
          {
            sort: { nextAttemptAt: 1 },
            returnDocument: "after",
          },
        );

        span.end();

        return ok(updated ? docToDomain(updated) : null);
      } catch (cause) {
        span.end();
        logger.error("lease failed", { error: cause });

        return err(new QueueRepoError("Failed to lease job", { cause }));
      }
    });
  }

  async complete(
    jobId: QueueJobId,
  ): Promise<Result<void, InstanceType<typeof QueueRepoError | typeof QueueJobNotFoundError>>> {
    return this.tracer.startActiveSpan("MongodbOutboundQueueRepo.complete", async (span) => {
      try {
        const collection = await this.getCollection();
        const result = await collection.deleteOne({ id: String(jobId) });

        span.end();

        if (result.deletedCount === 0) {
          /*
           * Already gone — idempotent path. The worker may complete a
           * job whose row was removed by an out-of-band path (operator
           * intervention, test cleanup). Don't surface as an error.
           */
          return ok(undefined);
        }

        return ok(undefined);
      } catch (cause) {
        span.end();
        logger.error("complete failed", { error: cause });

        return err(new QueueRepoError("Failed to complete job", { cause }));
      }
    });
  }

  async releaseWithBackoff(
    jobId: QueueJobId,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<Result<void, InstanceType<typeof QueueRepoError | typeof QueueJobNotFoundError>>> {
    return this.tracer.startActiveSpan(
      "MongodbOutboundQueueRepo.releaseWithBackoff",
      async (span) => {
        try {
          const collection = await this.getCollection();
          const result = await collection.findOneAndUpdate(
            { id: String(jobId) },
            {
              $set: {
                attempts,
                nextAttemptAt,
              },
              $unset: {
                lockedBy: "",
                lockedUntil: "",
              },
            },
            { returnDocument: "after" },
          );

          span.end();

          if (!result) {
            return err(new QueueJobNotFoundError(`outbound_queue row ${String(jobId)} not found`));
          }

          return ok(undefined);
        } catch (cause) {
          span.end();
          logger.error("releaseWithBackoff failed", { error: cause });

          return err(new QueueRepoError("Failed to release job with backoff", { cause }));
        }
      },
    );
  }

  async peek(
    filters: QueuePeekFilters,
  ): Promise<Result<QueueJob[], InstanceType<typeof QueueRepoError>>> {
    return this.tracer.startActiveSpan("MongodbOutboundQueueRepo.peek", async (span) => {
      try {
        const collection = await this.getCollection();
        const query: Record<string, unknown> = {};

        if (filters.saleorApiUrl) {
          query.saleorApiUrl = String(filters.saleorApiUrl);
        }
        if (filters.eventType) {
          query.eventType = filters.eventType;
        }
        if (filters.createdAfter) {
          query.createdAt = { $gte: filters.createdAfter };
        }

        const limit = Math.min(filters.limit ?? 100, MAX_PEEK_LIMIT);
        const docs = await collection.find(query).sort({ nextAttemptAt: 1 }).limit(limit).toArray();

        span.end();

        return ok(docs.map(docToDomain));
      } catch (cause) {
        span.end();
        logger.error("peek failed", { error: cause });

        return err(new QueueRepoError("Failed to peek queue", { cause }));
      }
    });
  }
}
