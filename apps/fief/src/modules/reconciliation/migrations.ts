import { createIndex } from "@/modules/db/create-index";
import { type MigrationEntry, registerMigration } from "@/modules/db/migration-runner";

/*
 * T32 — Schema migration for the `reconciliation_runs` collection.
 *
 * Three indexes:
 *
 *   1. Concurrent-run guard. Unique partial index on
 *      `{ saleorApiUrl, connectionId, status: "running" }` filtered to
 *      `status === "running"`. This is what makes
 *      `ReconciliationRunHistoryRepo.claim(...)` atomic across replicas:
 *      `findOneAndUpdate(... { upsert: true })` against this index either
 *      writes a fresh "running" row OR fails with E11000 because another
 *      replica already has one.
 *
 *      `partialFilterExpression` is mandatory — without it, the unique
 *      constraint would block legitimate completed runs from sharing
 *      `(saleorApiUrl, connectionId)`.
 *
 *   2. UI listing — `{ saleorApiUrl: 1, startedAt: -1 }` powers
 *      `listRecent(...)` (T38).
 *
 *   3. Per-connection listing — `{ saleorApiUrl: 1, connectionId: 1, startedAt: -1 }`
 *      powers the same `listRecent` when filtered by connectionId.
 *
 * Version `"007"` per the plan-coordinator note. T8="002", T9="003", T10="004",
 * T11="005", T17="006", this migration is "007". The runner sorts
 * lexicographically so registration order doesn't matter.
 */

export const RECONCILIATION_RUNS_COLLECTION = "reconciliation_runs";

export const reconciliationRunsMigration: MigrationEntry = {
  version: "007",
  name: "reconciliation-runs-indexes",
  async run(db) {
    const collection = db.collection(RECONCILIATION_RUNS_COLLECTION);

    /*
     * Unique partial index. Two replicas calling `claim(...)` simultaneously
     * either: (a) the first wins the upsert, the second hits E11000 and
     * surfaces `claimed: false`; or (b) both observe an existing row in their
     * findOne and skip the upsert. Either way, exactly one runner runs.
     */
    await createIndex(
      collection,
      { saleorApiUrl: 1, connectionId: 1, status: 1 },
      {
        unique: true,
        partialFilterExpression: { status: "running" },
        name: "reconciliation_runs_running_unique",
      },
    );

    await createIndex(
      collection,
      { saleorApiUrl: 1, startedAt: -1 },
      { name: "reconciliation_runs_install_recent_idx" },
    );

    await createIndex(
      collection,
      { saleorApiUrl: 1, connectionId: 1, startedAt: -1 },
      { name: "reconciliation_runs_connection_recent_idx" },
    );
  },
};

export const registerReconciliationRunsMigration = (): void => {
  registerMigration(reconciliationRunsMigration);
};

/*
 * Eager registration mirrors the pattern from T10/T11 — production boot
 * paths that import the repo wire the migration without an extra call.
 * Tests that call `resetMigrationRegistryForTests()` re-invoke
 * `registerReconciliationRunsMigration()` afterward.
 */
registerReconciliationRunsMigration();
