import { createIndex } from "@/modules/db/create-index";
import { type MigrationEntry, registerMigration } from "@/modules/db/migration-runner";

import { IDENTITY_MAP_COLLECTION } from "./repositories/mongodb/constants";

/*
 * T10 — Schema migration for the `identity_map` collection.
 *
 * Two unique compound indexes (the "bidirectional join" enforced at the
 * storage layer):
 *
 *   - `{ saleorApiUrl: 1, saleorUserId: 1 }` — uniqueness in the Saleor
 *     direction. Prevents two Fief users binding to the same Saleor
 *     customer within a single Saleor instance.
 *
 *   - `{ saleorApiUrl: 1, fiefUserId: 1 }` — uniqueness in the Fief
 *     direction. The race-resolution lever for T19: `findOneAndUpdate(...)`
 *     against this index is what guarantees exactly one winner during a
 *     two-device first-login race. Without this index, the upsert would
 *     silently succeed twice and we'd end up with duplicate Saleor
 *     customers bound to the same Fief user.
 *
 * Per the plan-coordinator note in the task brief: this migration owns
 * `version: "004"`. T8 owns "002", T9 "003", T11 "005". The runner sorts
 * lexicographically so 004 runs after 003 and before 005 deterministically
 * regardless of registration order.
 */

export const identityMapIndexMigration: MigrationEntry = {
  version: "004",
  name: "identity-map-indexes",
  async run(db) {
    const collection = db.collection(IDENTITY_MAP_COLLECTION);

    await createIndex(
      collection,
      { saleorApiUrl: 1, saleorUserId: 1 },
      { unique: true, name: "identity_map_saleor_user_unique" },
    );

    await createIndex(
      collection,
      { saleorApiUrl: 1, fiefUserId: 1 },
      { unique: true, name: "identity_map_fief_user_unique" },
    );
  },
};

/*
 * Register at module load. The runner registry is in-process and idempotent
 * on `version + name`, so re-importing this module (e.g. in tests) is safe.
 *
 * The actual `runMigrations()` invocation happens at app boot — see T53 for
 * the boot wiring. Registering here keeps the call-site declarative: every
 * collection that needs indexes ships its own `migrations.ts` and the
 * runner picks them up via the registry.
 */
registerMigration(identityMapIndexMigration);
