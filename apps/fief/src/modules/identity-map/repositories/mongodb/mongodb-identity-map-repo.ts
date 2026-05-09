import { type Collection, MongoServerError } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { appInternalTracer } from "@/lib/tracing";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";

import { type IdentityMapRow, IdentityMapRowSchema } from "../../identity-map";
import {
  type DeleteInput,
  type GetByFiefUserInput,
  type GetBySaleorUserInput,
  type IdentityMapRepo,
  IdentityMapRepoError,
  type UpsertIdentityMapInput,
  type UpsertIdentityMapResult,
} from "../../identity-map-repo";
import { IDENTITY_MAP_COLLECTION } from "./constants";

/*
 * T10 — Mongo-backed `identity_map` repository.
 *
 * This implementation is the **synchronization point** for the auth-plane
 * race documented in T19/T23 of the plan. Every design decision here is
 * subordinate to "make `upsert` race-safe and monotonic".
 *
 * ─────────────────────────────────────────────────────────────────────
 * `upsert` algorithm (atomic, two-step)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Step 1 — Race-resolving insert:
 *
 *     findOneAndUpdate(
 *       filter:  { saleorApiUrl, fiefUserId },
 *       update:  { $setOnInsert: { saleorApiUrl, saleorUserId,
 *                                  fiefUserId, lastSyncSeq, lastSyncedAt } },
 *       options: { upsert: true,
 *                  returnDocument: "after",
 *                  includeResultMetadata: true },
 *     )
 *
 *   - The unique index `{ saleorApiUrl: 1, fiefUserId: 1 }` (created in T10's
 *     migration) serializes concurrent upsert calls at the storage engine level.
 *     Exactly one writer's upsert lands as an insert; every other concurrent
 *     writer's upsert observes the inserted row and resolves the operation
 *     as a no-op modification (because `$setOnInsert` is empty for an
 *     existing row).
 *
 *   - `lastErrorObject.upserted` is the ObjectId of the inserted document
 *     when (and only when) the call performed the insert. We use it to
 *     compute `wasInserted`. (This is more reliable than checking
 *     `updatedExisting` against a freshly upserted row, because the latter
 *     would be `false` for the inserter and could be `true` for a
 *     concurrent loser if Mongo racing semantics evolve — `upserted` is
 *     the unambiguous signal.)
 *
 *   - `returnDocument: "after"` returns the post-state. For the inserter,
 *     this is the row they just wrote. For a loser, this is the WINNER's
 *     row — including the winner's `saleorUserId` (which may differ from
 *     the loser's input). T19's first-login flow keys off this to avoid
 *     creating a duplicate Saleor customer.
 *
 * Step 2 — Monotonic seq advance (only if Step 1 was NOT an insert):
 *
 *     updateOne(
 *       filter:  { saleorApiUrl, fiefUserId,
 *                  lastSyncSeq: { $lt: incomingSeq } },
 *       update:  { $set: { lastSyncSeq: incomingSeq, lastSyncedAt: now } },
 *     )
 *
 *   - The `lastSyncSeq: { $lt: incomingSeq }` filter is the monotonic guard:
 *     the update only matches if our seq strictly exceeds the persisted
 *     value. Out-of-order writes (incoming < existing) and equal writes
 *     (incoming == existing) match nothing and are silent no-ops.
 *
 *   - We re-fetch after the conditional update so the returned row reflects
 *     the actual storage state — important when a third writer with a yet-
 *     higher seq lands between our update and our read.
 *
 * Step 3 — Re-parse through the domain schema:
 *
 *     IdentityMapRowSchema.parse(stripMongoId(rawDoc))
 *
 *   - Strict re-parse on the way out fails loudly on schema drift (PRD R6).
 *     Mongo doesn't enforce schemas; this gives us a single choke point.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Why not a single `findOneAndUpdate` with `$max` for seq?
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - A combined `{ $setOnInsert: {...identityFields}, $max: { lastSyncSeq },
 *     $set: { lastSyncedAt } }` would advance `lastSyncedAt` even when
 *     `lastSyncSeq` did NOT advance — violating the "no-op if seq <=
 *     existing" requirement (the test checks `lastSyncedAt` is unchanged
 *     for an equal-seq upsert so loop-guard / observability stays clean).
 *
 *   - A single op with conditional `$set` on lastSyncedAt requires Mongo's
 *     pipeline-style update which is verbose and harder to reason about.
 *     Two ops with the unique index serializing the first one is simpler
 *     and atomically correct because no caller can change the *identity*
 *     of the row between Step 1 and Step 2 (the binding is immutable
 *     once written).
 */

const logger = createLogger("modules.identity-map.mongodb-identity-map-repo");

interface IdentityMapDoc {
  _id?: unknown;
  saleorApiUrl: string;
  saleorUserId: string;
  fiefUserId: string;
  lastSyncSeq: number;
  lastSyncedAt: Date;
}

function stripId(doc: IdentityMapDoc): Omit<IdentityMapDoc, "_id"> {
  const { _id, ...rest } = doc;

  // Reference _id to satisfy `noUnusedLocals`-style lints without altering behaviour.
  void _id;

  return rest;
}

function parseRow(doc: IdentityMapDoc): IdentityMapRow {
  return IdentityMapRowSchema.parse(stripId(doc));
}

export class MongoIdentityMapRepo implements IdentityMapRepo {
  private collectionPromise: Promise<Collection<IdentityMapDoc>> | null = null;

  /**
   * Resolve the `identity_map` collection handle. Lazily memoized so the
   * first call connects, subsequent calls reuse the pool.
   *
   * Note: this method does NOT create indexes — that's the migration runner's
   * job (T53). The collection is expected to already have its unique compound
   * indexes when this code runs in production. Tests must call
   * `runMigrations()` after registering the migration.
   */
  private async getCollection(): Promise<Collection<IdentityMapDoc>> {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      try {
        const client = await getMongoClient();
        const db = client.db(getMongoDatabaseName());

        return db.collection<IdentityMapDoc>(IDENTITY_MAP_COLLECTION);
      } catch (cause) {
        this.collectionPromise = null;
        throw new IdentityMapRepoError("Failed to access identity_map collection", { cause });
      }
    })();

    return this.collectionPromise;
  }

  async getBySaleorUser(
    input: GetBySaleorUserInput,
  ): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>> {
    return appInternalTracer.startActiveSpan(
      "MongoIdentityMapRepo.getBySaleorUser",
      async (span) => {
        try {
          const collection = await this.getCollection();
          const doc = await collection.findOne({
            saleorApiUrl: input.saleorApiUrl,
            saleorUserId: input.saleorUserId,
          });

          span.end();

          if (!doc) {
            return ok(null);
          }

          return ok(parseRow(doc));
        } catch (cause) {
          span.end();

          return err(
            new IdentityMapRepoError("Failed to get identity_map row by Saleor user", { cause }),
          );
        }
      },
    );
  }

  async getByFiefUser(
    input: GetByFiefUserInput,
  ): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>> {
    return appInternalTracer.startActiveSpan("MongoIdentityMapRepo.getByFiefUser", async (span) => {
      try {
        const collection = await this.getCollection();
        const doc = await collection.findOne({
          saleorApiUrl: input.saleorApiUrl,
          fiefUserId: input.fiefUserId,
        });

        span.end();

        if (!doc) {
          return ok(null);
        }

        return ok(parseRow(doc));
      } catch (cause) {
        span.end();

        return err(
          new IdentityMapRepoError("Failed to get identity_map row by Fief user", { cause }),
        );
      }
    });
  }

  async upsert(
    input: UpsertIdentityMapInput,
  ): Promise<Result<UpsertIdentityMapResult, InstanceType<typeof IdentityMapRepoError>>> {
    return appInternalTracer.startActiveSpan("MongoIdentityMapRepo.upsert", async (span) => {
      try {
        const collection = await this.getCollection();
        const now = new Date();

        /*
         * Step 1: race-resolving insert. Filter is the Fief-direction key
         * (the one the unique index serializes on for race detection); on
         * insert we set every field. On hit we touch nothing — we'll
         * compute the seq advance separately so `lastSyncedAt` only
         * changes when the seq does.
         */
        const insertResult = await collection.findOneAndUpdate(
          {
            saleorApiUrl: input.saleorApiUrl,
            fiefUserId: input.fiefUserId,
          },
          {
            $setOnInsert: {
              saleorApiUrl: input.saleorApiUrl as unknown as string,
              saleorUserId: input.saleorUserId as unknown as string,
              fiefUserId: input.fiefUserId as unknown as string,
              lastSyncSeq: input.syncSeq as unknown as number,
              lastSyncedAt: now,
            },
          },
          {
            upsert: true,
            returnDocument: "after",
            includeResultMetadata: true,
          },
        );

        // `value` is the post-update doc when `returnDocument: "after"` and the upsert succeeded.
        const postInsertDoc = insertResult.value;

        if (!postInsertDoc) {
          // Defensive — should never happen with `upsert: true` + `returnDocument: "after"`.
          return err(new IdentityMapRepoError("findOneAndUpdate returned no document on upsert"));
        }

        const upsertedId = insertResult.lastErrorObject?.upserted;
        const wasInserted = upsertedId !== undefined && upsertedId !== null;

        if (wasInserted) {
          // Winner of the race — return the just-inserted row.
          span.end();

          return ok({
            row: parseRow(postInsertDoc),
            wasInserted: true,
          });
        }

        /*
         * Step 2: row already existed (we're the loser of any concurrent
         * race, or this is a re-bind from a later sync event). Try to
         * advance lastSyncSeq monotonically. The `$lt` filter makes this
         * a no-op for equal or older incoming syncSeq values.
         */
        const incomingSeq = input.syncSeq as unknown as number;
        const advanceResult = await collection.findOneAndUpdate(
          {
            saleorApiUrl: input.saleorApiUrl,
            fiefUserId: input.fiefUserId,
            lastSyncSeq: { $lt: incomingSeq },
          },
          {
            $set: {
              lastSyncSeq: incomingSeq,
              lastSyncedAt: now,
            },
          },
          {
            returnDocument: "after",
            includeResultMetadata: true,
          },
        );

        // `value` is null when no doc matched the `$lt` predicate (older/equal incoming seq).
        const finalDoc = advanceResult.value ?? postInsertDoc;

        span.end();

        return ok({
          row: parseRow(finalDoc),
          wasInserted: false,
        });
      } catch (cause) {
        span.end();

        /*
         * E11000 here would indicate the OTHER unique index
         * `{ saleorApiUrl, saleorUserId }` was violated — i.e. the caller
         * is trying to bind a fief user to a saleor user id that's already
         * bound to a DIFFERENT fief user. That's a real domain conflict
         * (not a race we can resolve) so surface it as a typed repo error
         * rather than swallow.
         */
        if (cause instanceof MongoServerError && cause.code === 11000) {
          logger.warn("identity_map upsert rejected by unique index", {
            saleorApiUrl: input.saleorApiUrl,
            saleorUserId: input.saleorUserId,
            fiefUserId: input.fiefUserId,
            error: cause.message,
          });
        }

        return err(new IdentityMapRepoError("Failed to upsert identity_map row", { cause }));
      }
    });
  }

  async delete(
    input: DeleteInput,
  ): Promise<Result<void, InstanceType<typeof IdentityMapRepoError>>> {
    return appInternalTracer.startActiveSpan("MongoIdentityMapRepo.delete", async (span) => {
      try {
        const collection = await this.getCollection();

        await collection.deleteOne({
          saleorApiUrl: input.saleorApiUrl,
          saleorUserId: input.saleorUserId,
        });

        span.end();

        return ok(undefined);
      } catch (cause) {
        span.end();

        return err(new IdentityMapRepoError("Failed to delete identity_map row", { cause }));
      }
    });
  }
}
