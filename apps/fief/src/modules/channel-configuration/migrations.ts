import { createIndex } from "@/modules/db/create-index";
import { registerMigration } from "@/modules/db/migration-runner";

/*
 * T9 — Register the channel-configuration index migration with T53's runner.
 *
 * Module-load side-effect: importing this module pushes the migration entry
 * into the in-process registry. No I/O happens here — `runMigrations()` (T53)
 * applies the work on app boot.
 *
 * Index rationale:
 *
 *   - `{ saleorApiUrl: 1 }` UNIQUE — the repo stores one document per Saleor
 *     tenant (default + overrides for that tenant in a single row). The
 *     unique constraint defends against double-write races: even if two
 *     concurrent webhook handlers raced past an in-process check, the second
 *     `replaceOne(..., { upsert: true })` is filtered by saleorApiUrl so the
 *     unique index would catch a genuine concurrent-insert bug.
 *
 * Version `"003"` is reserved for T9 per the parallel-batch task allocation:
 *   T8 → "002" (provider_connections)
 *   T9 → "003" (channel_configuration)        ← this file
 *   T10 → "004" (identity_map)
 *   T11 → "005" (webhook_log + dlq)
 */

registerMigration({
  version: "003",
  name: "channel-configuration-indexes",
  async run(db) {
    const collection = db.collection("channel_configuration");

    await createIndex(collection, { saleorApiUrl: 1 }, { unique: true });
  },
});
