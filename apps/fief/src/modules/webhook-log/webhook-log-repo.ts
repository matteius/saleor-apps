import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type WebhookDirection,
  type WebhookEventId,
  type WebhookLog,
  type WebhookLogConnectionId,
  type WebhookLogId,
  type WebhookStatus,
} from "./webhook-log";

/*
 * T11 — Repository interface for the `webhook_log` collection.
 *
 * The interface lives next to the domain (rather than under
 * `repositories/`) so consumers can `import type { WebhookLogRepo }` without
 * pulling the Mongo driver into their bundle. The Mongo implementation is
 * the only impl today (T11), but the interface is shaped so a future
 * in-memory variant for unit tests of T22/T26-T29 receivers can drop in
 * without touching the receiver code.
 *
 * All methods return `Result` per the project convention; the receivers
 * (T22 / T26-T29) compose them via `andThen` and surface failures into
 * the structured logger (T50) without throwing.
 */

export const WebhookLogRepoError = BaseError.subclass("WebhookLogRepoError", {
  props: {
    _brand: "FiefApp.WebhookLog.RepoError" as const,
  },
});
export const WebhookLogNotFoundError = BaseError.subclass("WebhookLogNotFoundError", {
  props: {
    _brand: "FiefApp.WebhookLog.NotFoundError" as const,
  },
});

/**
 * Producer-supplied row contents for `record(...)`. The repo assigns
 * `id`, `createdAt`, `ttl`, `attempts: 0`, and `status: "retrying"` —
 * callers don't need to. Returned `WebhookLog` is the full persisted
 * shape.
 */
export interface RecordWebhookLogInput {
  saleorApiUrl: SaleorApiUrl;
  connectionId: WebhookLogConnectionId;
  direction: WebhookDirection;
  eventId: WebhookEventId;
  eventType: string;
  payloadRedacted: unknown;
  /**
   * Optional override of the initial status. The receivers (T22, T26-T29)
   * pass `"ok"` immediately when they handle inline; the queue (T52) lets
   * the default `"retrying"` apply and flips to `"ok"` on first-attempt
   * success via `recordAttempt`.
   */
  initialStatus?: WebhookStatus;
}

/**
 * Filters for `list(...)`. All fields are optional; the dashboard (T37)
 * narrows by tenant + status + window.
 */
export interface WebhookLogFilters {
  saleorApiUrl?: SaleorApiUrl;
  status?: WebhookStatus;
  direction?: WebhookDirection;
  /**
   * Match `eventType` (exact). The dashboard exposes a free-form filter;
   * the receivers don't use this.
   */
  eventType?: string;
  /**
   * Inclusive lower bound on `createdAt`. The dashboard defaults to
   * "last 7 days" via this filter.
   */
  createdAfter?: Date;
  /**
   * Page size cap. The dashboard renders 50/page; bulk-export tooling
   * raises this. Repo enforces `Math.min(limit, 1000)` defensively.
   */
  limit?: number;
}

/**
 * Outcome of `recordAttempt(...)` so callers know whether the row is
 * now terminal-dead (and therefore should be moved to DLQ via
 * `moveToDlq()`).
 */
export interface RecordAttemptResult {
  /** The full row after the increment + status flip. */
  row: WebhookLog;
  /**
   * `true` when the just-incremented `attempts` reached the
   * `maxAttempts` threshold and `status` was flipped to `"dead"`. Queue
   * worker checks this and invokes `moveToDlq` immediately so a dead
   * row never lingers in `webhook_log` waiting for the TTL sweep.
   */
  becameDead: boolean;
}

export interface WebhookLogRepo {
  /**
   * Insert a fresh row. Returns the persisted entity (with `id`, `ttl`,
   * `createdAt` filled in). On unique-index conflict (i.e. caller raced
   * with another receiver on the same `(saleorApiUrl, direction,
   * eventId)`) returns the *existing* row so the producer can
   * short-circuit safely.
   */
  record(
    input: RecordWebhookLogInput,
  ): Promise<Result<WebhookLog, InstanceType<typeof WebhookLogRepoError>>>;

  /**
   * De-duplication primitive used by every receiver before dispatch.
   * Returns `true` when a row with `(saleorApiUrl, direction, eventId)`
   * already exists, `false` otherwise. The receiver should `record(...)`
   * after this returns `false`; the unique index plus the upsert
   * behavior of `record` means even a time-of-check-to-time-of-use race
   * remains safe.
   */
  dedupCheck(args: {
    saleorApiUrl: SaleorApiUrl;
    direction: WebhookDirection;
    eventId: WebhookEventId;
  }): Promise<Result<boolean, InstanceType<typeof WebhookLogRepoError>>>;

  /**
   * Increment `attempts` on `id`, append `lastError` (when supplied),
   * and flip `status` to `"dead"` when the new `attempts >= maxAttempts`.
   * Caller (T52 worker) decides `maxAttempts`: default 6 per the plan,
   * but bulk-replay tooling (T51) bumps it to absorb large backfills.
   *
   * On `success: true`, status flips to `"ok"` and we no longer count
   * this row toward the retry budget.
   */
  recordAttempt(args: {
    id: WebhookLogId;
    maxAttempts: number;
    success?: boolean;
    error?: string;
  }): Promise<
    Result<
      RecordAttemptResult,
      InstanceType<typeof WebhookLogRepoError | typeof WebhookLogNotFoundError>
    >
  >;

  /**
   * Move a row to the DLQ collection. Atomic: writes to `dlq` then
   * removes from `webhook_log`. Used by the queue worker (T52) after
   * `recordAttempt` returns `becameDead: true`.
   *
   * Returns the migrated row's id. The DLQ row carries the same `id`
   * so dashboards can cross-reference.
   */
  moveToDlq(
    id: WebhookLogId,
  ): Promise<
    Result<WebhookLogId, InstanceType<typeof WebhookLogRepoError | typeof WebhookLogNotFoundError>>
  >;

  /**
   * List rows matching `filters`, sorted by `createdAt` desc. Caps
   * results at 1000 internally (`limit` is the requested cap; repo
   * enforces the absolute ceiling).
   */
  list(
    filters: WebhookLogFilters,
  ): Promise<Result<WebhookLog[], InstanceType<typeof WebhookLogRepoError>>>;

  /** Fetch a single row by id; returns `null` (not error) when missing. */
  getById(
    id: WebhookLogId,
  ): Promise<Result<WebhookLog | null, InstanceType<typeof WebhookLogRepoError>>>;
}
