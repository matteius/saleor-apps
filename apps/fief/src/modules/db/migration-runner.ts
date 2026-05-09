import { type Db, MongoServerError } from "mongodb";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import { getMongoClient, getMongoDatabaseName } from "./mongo-client";

/*
 * T53 — Idempotent Mongo schema-migration runner.
 *
 * Storage repos (T8 provider_connections, T9 channel_configuration,
 * T10 identity_map, T11 webhook_log + dlq) and the APL (T3) all need to
 * ensure their indexes exist on app boot. Doing that as a side-effect on
 * module load is two things at once: a race (multiple modules calling
 * `collection.createIndex` against the same logical migration on cold-start)
 * and a layering violation (consumer code shouldn't be talking to the
 * driver before the runner has had a chance to apply schema changes).
 *
 * This module gives those callers a single registry-based API:
 *
 *   1. Each module exports a `MIGRATIONS` array (or registers from a
 *      colocated `migrations.ts`) and calls `registerMigration(entry)`
 *      at module load — no I/O happens, just an in-process push.
 *   2. App boot (instrumentation hook, follow-up wiring) calls
 *      `runMigrations()` once.
 *   3. The runner sorts by `version`, takes a brief distributed lock on
 *      `_schema_lock` (Mongo `findAndModify` with TTL fallback so a
 *      crashed holder can't strand the system), and applies each
 *      not-yet-recorded migration. After successful run, it writes
 *      `{ name: "<version>:<name>", appliedAt: Date }` into
 *      `_schema_versions`. Subsequent boots skip recorded names.
 *
 * Why a distributed lock and not just rely on `_schema_versions` reads?
 *
 *   - On rolling deploy two replicas can both observe "migration 003 not
 *     applied" simultaneously, both run it, both attempt the same
 *     `createIndex`. With identical specs Mongo serializes — no error —
 *     but if a migration writes data (backfill), running it twice is
 *     non-idempotent. The lock makes the runner safe to extend with
 *     write-bearing migrations later (T31 reconciliation hooks).
 *   - The lock is acquired+released around the entire batch. A 5-minute
 *     TTL means a crashed holder can't deadlock the system longer than
 *     one redeploy cycle.
 *
 * `registerMigration` is the API the storage-repo agents (T8/T9/T10/T11)
 * will use to wire their indexes in. They should:
 *
 *     // src/modules/provider-connections/migrations.ts
 *     import { registerMigration } from "@/modules/db/migration-runner";
 *     import { createIndex } from "@/modules/db/create-index";
 *
 *     registerMigration({
 *       version: "002",
 *       name: "provider-connections-indexes",
 *       async run(db) {
 *         const coll = db.collection("provider_connections");
 *         await createIndex(coll, { saleorApiUrl: 1 });
 *         await createIndex(coll, { saleorApiUrl: 1, id: 1 }, { unique: true });
 *       },
 *     });
 *
 * Then the storage-repo's index-side-effect goes away — the migration
 * runs on next boot of the runner.
 */

const logger = createLogger("modules.db.migration-runner");

export const MigrationError = BaseError.subclass("MigrationError", {
  props: {
    _brand: "FiefApp.MigrationError" as const,
  },
});

export const MigrationLockTimeoutError = BaseError.subclass("MigrationLockTimeoutError", {
  props: {
    _brand: "FiefApp.MigrationLockTimeoutError" as const,
  },
});

export interface MigrationEntry {
  /**
   * Sortable version identifier — typically a zero-padded numeric string
   * (`"001"`, `"002"`) or an ISO date prefix. The runner sorts entries
   * lexicographically by `version` before applying.
   */
  version: string;
  /**
   * Human-readable name. Combined with `version` to form the
   * `_schema_versions.name` key used to track applied migrations.
   * Must be stable across deploys; renaming a migration causes it to
   * re-run.
   */
  name: string;
  /**
   * Apply the migration. Receives the configured Mongo `Db` handle.
   * Use `createIndex` from `./create-index` for index work — it handles
   * concurrent-boot races cleanly.
   */
  run(db: Db): Promise<void>;
}

const SCHEMA_VERSIONS_COLLECTION = "_schema_versions";
const SCHEMA_LOCK_COLLECTION = "_schema_lock";
const LOCK_DOC_ID = "migration-runner";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 min — long enough for any reasonable migration batch.
const LOCK_ACQUIRE_TIMEOUT_MS = 30 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;

/*
 * Registry is module-scoped. `registerMigration` pushes entries; the runner
 * snapshots + sorts on each `runMigrations()` call so late registration
 * works (a migration registered after a first boot will be applied on the
 * next boot).
 */
const registry: MigrationEntry[] = [];

/**
 * Register a migration entry. Safe to call from module-load — does no I/O.
 * Duplicate `version + name` pairs are ignored (idempotent across module
 * reloads, e.g. in tests).
 */
export const registerMigration = (entry: MigrationEntry): void => {
  const id = `${entry.version}:${entry.name}`;

  if (registry.some((existing) => `${existing.version}:${existing.name}` === id)) {
    return;
  }

  registry.push(entry);
};

/**
 * Test-only: clear the registry between tests. Production code should
 * never call this.
 */
export const resetMigrationRegistryForTests = (): void => {
  registry.length = 0;
};

interface LockDoc {
  _id: string;
  ownerId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire the schema-runner lock. Implementation:
 *
 *   - Atomic upsert via `findOneAndUpdate` with the filter
 *     `{ _id, expiresAt: { $lt: now } }`. If no doc exists, the upsert
 *     wins and we own the lock. If a stale doc exists (TTL expired), the
 *     filter matches, we overwrite ownership and the previous holder's
 *     work is abandoned (acceptable — the migrations are idempotent on
 *     `_schema_versions`).
 *   - If an active lock exists, the upsert fails with a duplicate-key
 *     error (E11000); we sleep and retry up to LOCK_ACQUIRE_TIMEOUT_MS.
 */
async function acquireLock(db: Db, ownerId: string): Promise<void> {
  const collection = db.collection<LockDoc>(SCHEMA_LOCK_COLLECTION);
  const startedAt = Date.now();

  while (true) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    try {
      const result = await collection.findOneAndUpdate(
        {
          _id: LOCK_DOC_ID,
          expiresAt: { $lt: now },
        },
        {
          $set: {
            ownerId,
            acquiredAt: now,
            expiresAt,
          },
        },
        { upsert: true, returnDocument: "after" },
      );

      if (result?.ownerId === ownerId) {
        logger.debug("acquired migration lock (replaced expired)", { ownerId });

        return;
      }
    } catch (cause) {
      /*
       * E11000 duplicate key — another process holds an active lock.
       * Try inserting fresh in case the doc didn't exist; if THAT also
       * fails with E11000, fall through to the wait loop.
       */
      if (cause instanceof MongoServerError && cause.code === 11000) {
        try {
          await collection.insertOne({
            _id: LOCK_DOC_ID,
            ownerId,
            acquiredAt: now,
            expiresAt,
          });

          logger.debug("acquired migration lock (fresh insert)", { ownerId });

          return;
        } catch (innerCause) {
          if (
            !(
              innerCause instanceof MongoServerError &&
              (innerCause as MongoServerError).code === 11000
            )
          ) {
            throw new MigrationError("Failed to acquire migration lock", { cause: innerCause });
          }
          // else fall through and retry below
        }
      } else {
        throw new MigrationError("Failed to acquire migration lock", { cause });
      }
    }

    // No upsert match (active lock held) and we didn't insert. Try a fresh insert.
    try {
      await collection.insertOne({
        _id: LOCK_DOC_ID,
        ownerId,
        acquiredAt: now,
        expiresAt,
      });

      logger.debug("acquired migration lock (fresh insert)", { ownerId });

      return;
    } catch (cause) {
      if (cause instanceof MongoServerError && cause.code === 11000) {
        // Active lock held by another process.
        if (Date.now() - startedAt > LOCK_ACQUIRE_TIMEOUT_MS) {
          throw new MigrationLockTimeoutError(
            `Could not acquire migration lock within ${LOCK_ACQUIRE_TIMEOUT_MS}ms`,
          );
        }

        await sleep(LOCK_POLL_INTERVAL_MS);
        continue;
      }

      throw new MigrationError("Failed to acquire migration lock", { cause });
    }
  }
}

async function releaseLock(db: Db, ownerId: string): Promise<void> {
  try {
    await db.collection<LockDoc>(SCHEMA_LOCK_COLLECTION).deleteOne({ _id: LOCK_DOC_ID, ownerId });
  } catch (cause) {
    /*
     * Lock release is best-effort; the TTL safety net handles the case
     * where this fails. Log + swallow.
     */
    logger.warn("Failed to release migration lock; relying on TTL", {
      ownerId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

interface AppliedVersionDoc {
  name: string;
  appliedAt: Date;
}

async function loadAppliedNames(db: Db): Promise<Set<string>> {
  const docs = await db
    .collection<AppliedVersionDoc>(SCHEMA_VERSIONS_COLLECTION)
    .find({}, { projection: { name: 1, _id: 0 } })
    .toArray();

  return new Set(docs.map((d) => d.name));
}

async function recordApplied(db: Db, name: string): Promise<void> {
  await db.collection<AppliedVersionDoc>(SCHEMA_VERSIONS_COLLECTION).insertOne({
    name,
    appliedAt: new Date(),
  });
}

/**
 * Ensure the unique index on `_schema_versions.name`. This is what makes
 * concurrent runs safe even outside the lock: if two processes raced past
 * the lock (e.g. lock TTL expired during a long migration), the second
 * insert into `_schema_versions` fails with E11000 and we treat the
 * migration as already applied.
 */
async function ensureSchemaVersionIndex(db: Db): Promise<void> {
  await db.collection(SCHEMA_VERSIONS_COLLECTION).createIndex({ name: 1 }, { unique: true });
}

/**
 * Run all registered, not-yet-applied migrations. Idempotent: callers can
 * invoke this on every boot; an already-applied migration is skipped.
 *
 * Concurrency: a brief distributed lock on `_schema_lock` ensures only one
 * process runs the batch at a time. The lock has a 5-minute TTL so a
 * crashed holder can't deadlock the system. Within the locked region, each
 * migration's "is it applied?" check reads `_schema_versions`, runs the
 * migration if not, and records the success. Even if the lock is bypassed
 * (TTL expiry during a slow migration), the unique index on
 * `_schema_versions.name` plus the idempotent `createIndex` helper keep
 * the system safe.
 */
export const runMigrations = async (): Promise<void> => {
  if (registry.length === 0) {
    logger.debug("no migrations registered; skipping run");

    return;
  }

  const client = await getMongoClient();
  const db = client.db(getMongoDatabaseName());
  const ownerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;

  await ensureSchemaVersionIndex(db);
  await acquireLock(db, ownerId);

  try {
    const applied = await loadAppliedNames(db);
    const sorted = [...registry].sort((a, b) => {
      const ka = `${a.version}:${a.name}`;
      const kb = `${b.version}:${b.name}`;

      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    for (const entry of sorted) {
      const id = `${entry.version}:${entry.name}`;

      if (applied.has(id)) {
        logger.debug("migration already applied; skipping", { migration: id });
        continue;
      }

      logger.info("applying migration", { migration: id });

      try {
        await entry.run(db);
        await recordApplied(db, id);

        logger.info("migration applied", { migration: id });
      } catch (cause) {
        if (cause instanceof MongoServerError && cause.code === 11000) {
          /*
           * Another process raced past the lock (TTL window) and recorded
           * this migration first. That's fine — they did the work, we
           * skip ours.
           */
          logger.info("migration recorded by another process; skipping", { migration: id });
          continue;
        }

        throw new MigrationError(`Migration ${id} failed`, { cause });
      }
    }
  } finally {
    await releaseLock(db, ownerId);
  }
};
