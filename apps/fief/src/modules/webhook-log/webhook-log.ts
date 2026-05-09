import { fromThrowable } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * T11 — Domain entity + Zod schemas for `webhook_log`.
 *
 * Every inbound (`fief_to_saleor`) and outbound (`saleor_to_fief`) sync event
 * lands here with enough provenance for:
 *
 *   - **Deduplication** (T22 Fief receiver, T26-T29 Saleor receivers) — the
 *     unique index on `{ saleorApiUrl, direction, eventId }` lets the
 *     receiver's `WebhookLogRepo` check short-circuit duplicate deliveries.
 *   - **Audit / health screen** (T37) — secondary index on
 *     `{ saleorApiUrl, status, createdAt }` powers the dashboard view.
 *   - **Retry orchestration** (T52 in-process queue) — `recordAttempt`
 *     increments on each retry and flips status to `"dead"` after the
 *     caller-configured max, at which point the queue worker invokes
 *     `moveToDlq` (this repo) to hand the row off for manual review.
 *   - **TTL pruning** — `ttl` is a `Date` 30 days hence; a TTL index on
 *     `ttl` lets Mongo expire successful + dead rows automatically. The
 *     companion `dlq` collection (T11 also) does NOT TTL — DLQ rows stay
 *     until an operator deletes them explicitly via T37.
 *
 * Redaction note: the `payloadRedacted` field stores whatever the *caller*
 * passes. Per T50 the logger redactor (`redactFiefSecrets`) masks Fief
 * secrets at log time; webhook receivers (T22, T26-T29) are responsible
 * for running their inbound payload through the same shape (or a domain-
 * specific projector) BEFORE handing it to this repo. The repo never
 * redacts on its own — that would silently double-mask if the caller
 * already did the right thing.
 */

export const WebhookLogValidationError = BaseError.subclass("WebhookLogValidationError", {
  props: {
    _brand: "FiefApp.WebhookLog.ValidationError" as const,
  },
});

/**
 * Direction of the synced event.
 *
 *   - `fief_to_saleor` — inbound webhook from Fief, dispatched into Saleor
 *     by T22→T23/T24/T25.
 *   - `saleor_to_fief` — outbound work enqueued by T26-T29 (or T32
 *     reconciliation) and pushed into Fief by T52's queue worker.
 */
export const webhookDirectionSchema = z.enum(["fief_to_saleor", "saleor_to_fief"]);
export type WebhookDirection = z.infer<typeof webhookDirectionSchema>;

/**
 * Per-row processing status.
 *
 *   - `ok` — terminal success.
 *   - `retrying` — at least one attempt failed; the queue (T52) will retry
 *     until `attempts >= max` or a success.
 *   - `dead` — terminal failure; queue worker has called `moveToDlq` (or
 *     will on next pass) to hand off for operator review (T37).
 */
export const webhookStatusSchema = z.enum(["ok", "retrying", "dead"]);
export type WebhookStatus = z.infer<typeof webhookStatusSchema>;

const webhookLogIdSchema = z.string().min(1).brand("WebhookLogId");

export type WebhookLogId = z.infer<typeof webhookLogIdSchema>;

export const createWebhookLogId = (raw: string) =>
  fromThrowable(webhookLogIdSchema.parse, (error) => WebhookLogValidationError.normalize(error))(
    raw,
  );

const webhookEventIdSchema = z.string().min(1).brand("WebhookEventId");

export type WebhookEventId = z.infer<typeof webhookEventIdSchema>;

export const createWebhookEventId = (raw: string) =>
  fromThrowable(webhookEventIdSchema.parse, (error) => WebhookLogValidationError.normalize(error))(
    raw,
  );

const connectionIdSchema = z.string().min(1).brand("WebhookLogConnectionId");

export type WebhookLogConnectionId = z.infer<typeof connectionIdSchema>;

export const createWebhookLogConnectionId = (raw: string) =>
  fromThrowable(connectionIdSchema.parse, (error) => WebhookLogValidationError.normalize(error))(
    raw,
  );

/**
 * Domain entity for a webhook-log row. The shape is shared verbatim with
 * the DLQ entity (T11 also) — the only behavior difference between the
 * two is the lack of TTL on DLQ. Re-using the same Zod schema means the
 * "move to DLQ" path is a typed projection, not a re-validation.
 */
export const webhookLogSchema = z.object({
  /** Stable id assigned at insert time. Branded for typed lookups. */
  id: webhookLogIdSchema,
  /**
   * Saleor tenant the event belongs to. Stored as the branded
   * `SaleorApiUrl` produced by `createSaleorApiUrl(...)`. Schema-side
   * we accept the raw string + cast on read; the constructor
   * (`createWebhookLog` in this module) is the authoritative gate.
   */
  saleorApiUrl: z
    .string()
    .min(1)
    .transform((value) => value as SaleorApiUrl),
  /**
   * Owning provider connection (T8). Branded as a distinct type so a stray
   * `string` from the route handler can't be passed in. Optional only to
   * support orphan inbound deliveries (T22 returns 410 + logs even when
   * the connection has been soft-deleted).
   */
  connectionId: connectionIdSchema,
  direction: webhookDirectionSchema,
  /**
   * Provider-side event id used for de-duplication. `(saleorApiUrl,
   * direction, eventId)` is unique. Inbound events use the Fief webhook
   * event id; outbound events use the Saleor webhook event id (or a
   * synthetic id when the producer is the reconciliation runner T32).
   */
  eventId: webhookEventIdSchema,
  /**
   * Provider-side event type, e.g. `user.created`, `customer.created`.
   * Stored verbatim — receivers tag rows with whatever the producer
   * named the event so unknown / new types are auditable later.
   */
  eventType: z.string().min(1),
  status: webhookStatusSchema,
  attempts: z.number().int().nonnegative(),
  /**
   * Last error message captured by `recordAttempt(error: unknown)`.
   * `undefined` until the first failure. Truncated by the caller if
   * needed — repo stores whatever it gets.
   */
  lastError: z.string().optional(),
  /**
   * Caller-redacted payload snapshot. See file-header note: the repo
   * does not redact on its own. Zod allows `unknown` so receivers can
   * pass arbitrary JSON-serializable shapes (Fief webhook bodies, Saleor
   * subscription query results, T32 reconciliation diffs).
   */
  payloadRedacted: z.unknown(),
  /**
   * Mongo TTL anchor — set to `now + 30 days` at insert time. The TTL
   * index on this field expires the document automatically.
   * Declared as a `Date` (not a number / ISO string) because the Mongo
   * TTL monitor only honors `Date`-typed fields.
   */
  ttl: z.date(),
  createdAt: z.date(),
});
export type WebhookLog = z.infer<typeof webhookLogSchema>;

/**
 * Number of days a successful / dead webhook-log row is retained before
 * the Mongo TTL monitor expires it. DLQ rows are not subject to this —
 * they stay until an operator deletes them via T37.
 */
export const WEBHOOK_LOG_TTL_DAYS = 30;
export const WEBHOOK_LOG_TTL_MS = WEBHOOK_LOG_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Compute the TTL anchor for a freshly-inserted row. Exported so tests
 * can assert on the resolved value without re-implementing the formula.
 */
export const computeWebhookLogTtl = (now: Date = new Date()): Date =>
  new Date(now.getTime() + WEBHOOK_LOG_TTL_MS);
