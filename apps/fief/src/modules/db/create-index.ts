import {
  type Collection,
  type CreateIndexesOptions,
  type Document,
  type IndexSpecification,
  MongoServerError,
} from "mongodb";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

/*
 * T53 — Idempotent `createIndex` helper safe under concurrent boot.
 *
 * Why this exists:
 *   - On rolling deploy, multiple processes boot at roughly the same time
 *     and each invokes the migration runner. Mongo's native `createIndex`
 *     is "idempotent on identical specs" — but if two callers race on a
 *     fresh database, one wins and the other sees a brief window where
 *     the index exists with the *server-defaulted* options (background,
 *     v, etc.) before the second call settles. The behavior is normally
 *     fine, but if the spec ever drifts (a new option is added, or a
 *     unique constraint is tightened), Mongo returns
 *     `IndexOptionsConflict (85)` or `IndexKeySpecsConflict (86)`. We do
 *     **not** want a single misconfigured deploy to crash every booting
 *     replica. So this helper:
 *
 *     1. Inspects the existing index list first.
 *     2. If an identical-key index with compatible options exists, no-op.
 *     3. If an identical-key index with *different* options exists, log
 *        a clear warning and return `{ created: false, skipped: true }`.
 *        The operator is expected to drop & recreate manually (this is
 *        rare — typically a one-time migration on a known schema change).
 *     4. If nothing exists, call `createIndex` and return `{ created: true }`.
 *
 *   - Concurrent callers that both reach step (4) will both invoke
 *     `createIndex`. Mongo serializes them — the second one is a no-op
 *     because the spec matches. So `MongoServerError` codes 85/86 only
 *     fire when specs genuinely differ, which is the path we explicitly
 *     log + skip.
 *
 *   - Helper return type is shaped so storage repos (T8/T9/T10/T11) can
 *     compose multiple createIndex calls inside a single migration entry
 *     and still surface "needed manual intervention" via test assertions.
 */

const logger = createLogger("modules.db.create-index");

export const CreateIndexError = BaseError.subclass("CreateIndexError", {
  props: {
    _brand: "FiefApp.CreateIndexError" as const,
  },
});

export interface CreateIndexResult {
  created: boolean;
  /**
   * `true` when a colliding-spec index already existed and we deliberately
   * left it alone. The accompanying `reason` describes the conflict for
   * operator triage.
   */
  skipped?: boolean;
  reason?: string;
}

/**
 * Mongo's `IndexOptionsConflict` is error code 85 and `IndexKeySpecsConflict`
 * is 86. Listed explicitly so we don't depend on private driver constants.
 */
const INDEX_CONFLICT_CODES = new Set([85, 86]);

/**
 * Normalize an index spec into the Mongo-native `{ field: direction }` map.
 * Accepts both array-of-tuples and object forms so the helper composes
 * naturally with mongodb-driver type aliases.
 */
function specToKey(spec: IndexSpecification): Record<string, unknown> {
  if (Array.isArray(spec)) {
    const out: Record<string, unknown> = {};

    for (const entry of spec) {
      if (Array.isArray(entry) && entry.length === 2) {
        out[String(entry[0])] = entry[1];
      } else if (typeof entry === "string") {
        out[entry] = 1;
      }
    }

    return out;
  }

  return spec as Record<string, unknown>;
}

/**
 * Compare two key specs by their normalized `{ field: direction }` shape.
 * Matches Mongo's own equality semantics (same fields in same order with
 * same direction).
 */
function keysEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) {
      return false;
    }
    if (a[aKeys[i]!] !== b[bKeys[i]!]) {
      return false;
    }
  }

  return true;
}

/**
 * Compare the option subset that's relevant to "is this the same index
 * I want to ensure exists?". `unique`, `sparse`, `partialFilterExpression`,
 * `expireAfterSeconds` are the load-bearing ones; everything else is
 * left to the driver default.
 */
function optionsCompatible(
  desired: CreateIndexesOptions,
  existing: Document,
): { compatible: boolean; reason?: string } {
  const checks: Array<{ key: keyof CreateIndexesOptions & keyof Document; desc: string }> = [
    { key: "unique", desc: "unique" },
    { key: "sparse", desc: "sparse" },
    { key: "expireAfterSeconds", desc: "expireAfterSeconds (TTL)" },
  ];

  for (const { key, desc } of checks) {
    const desiredVal = desired[key] ?? false;
    const existingVal = existing[key] ?? false;

    if (desiredVal !== existingVal) {
      return {
        compatible: false,
        reason: `${desc} mismatch (desired=${JSON.stringify(desiredVal)}, existing=${JSON.stringify(
          existingVal,
        )})`,
      };
    }
  }

  if (desired.partialFilterExpression || existing.partialFilterExpression) {
    const desiredJson = JSON.stringify(desired.partialFilterExpression ?? null);
    const existingJson = JSON.stringify(existing.partialFilterExpression ?? null);

    if (desiredJson !== existingJson) {
      return {
        compatible: false,
        reason: `partialFilterExpression mismatch (desired=${desiredJson}, existing=${existingJson})`,
      };
    }
  }

  return { compatible: true };
}

export const createIndex = async <TSchema extends Document = Document>(
  collection: Collection<TSchema>,
  spec: IndexSpecification,
  options: CreateIndexesOptions = {},
): Promise<CreateIndexResult> => {
  const desiredKey = specToKey(spec);

  let existingIndexes: Document[] = [];

  try {
    existingIndexes = await collection.indexes();
  } catch (cause) {
    /*
     * `indexes()` throws `NamespaceNotFound` for a collection that doesn't
     * exist yet. That's the common path on a fresh deploy — fall through
     * to `createIndex` (which auto-creates the collection).
     */
    if (!(cause instanceof MongoServerError && cause.code === 26)) {
      throw new CreateIndexError("Failed to list existing indexes", { cause });
    }
  }

  for (const existing of existingIndexes) {
    if (!keysEqual(existing.key as Record<string, unknown>, desiredKey)) {
      continue;
    }

    const compat = optionsCompatible(options, existing);

    if (compat.compatible) {
      // Same key + compatible options — nothing to do.
      return { created: false };
    }

    /*
     * Same key, different options — refuse to drop+recreate automatically
     * because that risks data-availability windows under concurrent boot
     * and can break in-flight queries depending on the index. Log loudly
     * so the operator can intervene.
     */
    logger.warn("createIndex skipped — colliding index already exists with different options", {
      collection: collection.collectionName,
      desiredKey: JSON.stringify(desiredKey),
      desiredOptions: JSON.stringify(options),
      existingName: typeof existing.name === "string" ? existing.name : "",
      existingUnique: existing.unique === true,
      existingSparse: existing.sparse === true,
      reason: compat.reason,
    });

    return {
      created: false,
      skipped: true,
      reason: `Index conflict on ${collection.collectionName}: ${compat.reason}`,
    };
  }

  try {
    await collection.createIndex(spec, options);

    return { created: true };
  } catch (cause) {
    /*
     * Race window: another booting process created the same index between
     * our `indexes()` call and our `createIndex` call. If the spec we sent
     * matches what's now there, the driver returns success; the conflict
     * codes only fire on genuine drift.
     */
    if (cause instanceof MongoServerError && INDEX_CONFLICT_CODES.has(cause.code as number)) {
      logger.warn("createIndex skipped — concurrent boot created an index with conflicting spec", {
        collection: collection.collectionName,
        desiredKey: JSON.stringify(desiredKey),
        desiredOptions: JSON.stringify(options),
        code: typeof cause.code === "number" ? cause.code : -1,
        message: cause.message,
      });

      return {
        created: false,
        skipped: true,
        reason: `Index conflict on ${collection.collectionName}: ${cause.message}`,
      };
    }

    throw new CreateIndexError("Failed to create index", { cause });
  }
};
