import { createIndex } from "@/modules/db/create-index";
import { registerMigration } from "@/modules/db/migration-runner";

/*
 * T8 — register the `provider_connections` collection's indexes with the T53
 * migration runner. Importing this module has the side-effect of pushing the
 * entry into the registry; `runMigrations()` (called from app boot, T47/T49)
 * is what actually issues the `createIndex` calls.
 *
 * Coordination notes:
 *   - Version `"002"` is reserved for this migration (T8). T9 owns `"003"`,
 *     T10 owns `"004"`, T11 owns `"005"`. Renumbering breaks idempotency by
 *     making the runner re-apply the migration under a new key, so do not.
 *   - Index choices follow PRD §F2.5: `{ saleorApiUrl: 1 }` is the hot path
 *     for `list()`-by-install (UI + handler resolution). The unique compound
 *     `{ saleorApiUrl: 1, id: 1 }` enforces tenant-scoped uniqueness so a
 *     cross-tenant id collision is impossible by construction.
 *   - The `createIndex` helper from T53 handles concurrent boot races: two
 *     processes calling this migration simultaneously will both succeed
 *     (Mongo serializes identical specs; conflicts on differing options are
 *     logged + skipped).
 */

registerMigration({
  version: "002",
  name: "provider-connections-indexes",
  async run(db) {
    const coll = db.collection("provider_connections");

    await createIndex(coll, { saleorApiUrl: 1 });
    await createIndex(coll, { saleorApiUrl: 1, id: 1 }, { unique: true });
  },
});
