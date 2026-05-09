import { createIndex } from "@/modules/db/create-index";
import { registerMigration } from "@/modules/db/migration-runner";

/*
 * T52 — Migration registration for the `outbound_queue` collection.
 *
 * Indexes:
 *   - `{ nextAttemptAt: 1, lockedUntil: 1 }` — supports the lease
 *     lookup `nextAttemptAt <= now AND (lockedUntil missing OR
 *     lockedUntil < now)`. Mongo's index intersection makes the leading
 *     `nextAttemptAt` the primary discriminator, then the secondary
 *     `lockedUntil` filter is a fast scan within the matched range.
 *   - unique `{ eventId: 1 }` — producer de-duplication. The first
 *     `enqueue` wins; subsequent `enqueue`s with the same `eventId`
 *     see E11000 and the repo returns the existing row instead of
 *     inserting.
 *
 * Registered under version `"006"` (T11 took `"005"`; future storage
 * repos pick the next available version monotonically).
 *
 * Wrapped in a function (rather than top-level `registerMigration`) for
 * the same reason as T11: tests need to re-register after
 * `resetMigrationRegistryForTests()`. Production boot calls
 * `registerOutboundQueueMigrations()` once on the first import path.
 */

export const OUTBOUND_QUEUE_COLLECTION = "outbound_queue";

export const registerOutboundQueueMigrations = (): void => {
  registerMigration({
    version: "006",
    name: "outbound-queue-indexes",
    async run(db) {
      const queue = db.collection(OUTBOUND_QUEUE_COLLECTION);

      /*
       * Lease lookup index. Composite — Mongo can serve the
       * `nextAttemptAt <= $now` range scan from the prefix and apply
       * the `lockedUntil` filter inline. Without this index, every
       * lease() call would full-scan the queue, which on a busy queue
       * is the difference between sub-millisecond and second-scale
       * lease latency.
       */
      await createIndex(
        queue,
        { nextAttemptAt: 1, lockedUntil: 1 },
        { name: "outbound_queue_lease_idx" },
      );

      /*
       * Producer de-duplication. Unique to enforce the idempotency
       * contract on `enqueue`. The producer-side de-duplication is
       * _the_ guarantee against double-processing a webhook
       * redelivery; the worker side has no equivalent fallback so this
       * index is load-bearing.
       */
      await createIndex(
        queue,
        { eventId: 1 },
        { unique: true, name: "outbound_queue_event_dedup_idx" },
      );
    },
  });
};

/*
 * Eagerly register on module import so production boot paths (which
 * import the repo) wire the migration without a separate call. Test
 * code MUST still call this explicitly after
 * `resetMigrationRegistryForTests()`.
 */
registerOutboundQueueMigrations();
