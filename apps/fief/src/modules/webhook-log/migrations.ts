import { createIndex } from "@/modules/db/create-index";
import { registerMigration } from "@/modules/db/migration-runner";

import { WEBHOOK_LOG_TTL_DAYS } from "./webhook-log";

/*
 * T11 — Migration registration for `webhook_log` + `dlq` collections.
 *
 * Both collections live under one entry (version `"005"`) so the runner
 * applies them atomically and the operator can correlate "rolled out
 * webhook logging" to a single line in `_schema_versions`.
 *
 * Indexes:
 *   - `webhook_log`:
 *     - unique `{ saleorApiUrl: 1, direction: 1, eventId: 1 }` — the
 *       de-duplication primitive consumed by the receiver's check
 *       (T22 + T26-T29).
 *     - TTL on `{ ttl: 1 }` with `expireAfterSeconds: 0` — Mongo's TTL
 *       monitor prunes rows when their `ttl` Date has passed. The
 *       30-day window is encoded in the Date stored at insert time
 *       (see `webhook-log.ts:computeWebhookLogTtl`); the index just
 *       points the monitor at the field.
 *     - secondary `{ saleorApiUrl: 1, status: 1, createdAt: -1 }` —
 *       powers the dashboard health screen (T37) without resorting to
 *       a full-tenant scan per status filter.
 *   - `dlq`:
 *     - secondary `{ saleorApiUrl: 1, movedToDlqAt: -1 }` — dashboard
 *       sort. No TTL: DLQ rows are operator-deleted explicitly (T37).
 *
 * `registerMigration` is idempotent on `version + name`, so calling
 * `registerWebhookLogAndDlqMigrations()` from multiple module-load
 * paths (e.g. tests + boot) is safe.
 *
 * Why a function instead of running `registerMigration` at module load?
 *   - The other migrations (T8 / T9 / T10) follow the bare-call
 *     pattern, but for T11 the test suite needs a way to re-register
 *     after `resetMigrationRegistryForTests()` in `beforeEach`. Wrapping
 *     in a function lets tests call it explicitly post-reset, while the
 *     production boot path calls it from the same place (the module
 *     index re-exports + invokes on first import).
 */

export const WEBHOOK_LOG_COLLECTION = "webhook_log";
export const DLQ_COLLECTION = "dlq";

export const registerWebhookLogAndDlqMigrations = (): void => {
  registerMigration({
    version: "005",
    name: "webhook-log-and-dlq-indexes",
    async run(db) {
      const webhookLog = db.collection(WEBHOOK_LOG_COLLECTION);
      const dlq = db.collection(DLQ_COLLECTION);

      /*
       * Unique de-duplication index — keys ordered so a partial
       * "saleorApiUrl + direction" scan still uses the index prefix.
       */
      await createIndex(
        webhookLog,
        { saleorApiUrl: 1, direction: 1, eventId: 1 },
        { unique: true, name: "webhook_log_dedup_idx" },
      );

      /*
       * TTL — `expireAfterSeconds: 0` means "expire when the Date in `ttl` is
       * in the past". The 30-day offset is set per-row at insert time.
       */
      await createIndex(
        webhookLog,
        { ttl: 1 },
        {
          expireAfterSeconds: 0,
          name: `webhook_log_ttl_${WEBHOOK_LOG_TTL_DAYS}d_idx`,
        },
      );

      // Health-screen sort: tenant + status, descending by createdAt.
      await createIndex(
        webhookLog,
        { saleorApiUrl: 1, status: 1, createdAt: -1 },
        { name: "webhook_log_health_idx" },
      );

      // DLQ — no TTL by design.
      await createIndex(
        dlq,
        { saleorApiUrl: 1, movedToDlqAt: -1 },
        { name: "dlq_tenant_recent_idx" },
      );
    },
  });
};

/*
 * Eagerly register on module import so production boot paths (which import
 * the repo) wire the migration without needing a separate call. Test code
 * MUST still call this explicitly after `resetMigrationRegistryForTests()`.
 */
registerWebhookLogAndDlqMigrations();
