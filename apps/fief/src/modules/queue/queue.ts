import { fromThrowable } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  type WebhookEventId,
  type WebhookLogConnectionId,
} from "@/modules/webhook-log/webhook-log";

/*
 * T52 — Domain entity + Zod schemas for the in-process outbound queue.
 *
 * The queue persists Saleor → Fief async work (T26-T29 enqueue here, the
 * worker drains and dispatches to Fief). Per PRD §F6.2 we hand-roll on a
 * Mongo `outbound_queue` collection rather than pulling BullMQ — adding
 * BullMQ would force a Redis dependency on operators who otherwise only
 * need MongoDB for this app.
 *
 * Job lifecycle:
 *   1. Producer (T26-T29) calls `enqueue({ saleorApiUrl, connectionId,
 *      eventType, eventId, payload })`. The repo enforces uniqueness on
 *      `eventId` so a webhook redelivery doesn't double-process.
 *   2. Worker (`src/modules/queue/worker.ts`) polls `lease(workerId,
 *      leaseMs)` which atomically locks one due job for `leaseMs`.
 *   3. Worker dispatches to a registered handler keyed by `eventType`.
 *      On success: `complete(jobId)` removes the row.
 *      On failure with attempts < max: `releaseWithBackoff` reschedules.
 *      On failure at attempts == max: hand off to T11's DLQ via
 *      `webhookLogRepo.moveToDlq` and then `complete` to drop the queue
 *      row. (DLQ is the long-term holding pen; queue is short-lived.)
 *
 * Why store `eventId` at the top level (not buried in `payload`):
 *   - The Mongo unique index for producer de-duplication needs to be
 *     a fixed field path, not a path inside arbitrary JSON.
 *   - Producers (T26-T29) already have the Saleor webhook event id at
 *     hand by the time they enqueue — surfacing it to a top-level
 *     field makes the de-duplication contract obvious.
 *
 * Lease semantics (`lockedBy` + `lockedUntil`):
 *   - `lockedUntil < now` means the lease has expired (e.g. worker
 *     crashed mid-dispatch). The next `lease()` call will re-acquire
 *     the row. This is the only "self-healing" mechanism — there's no
 *     separate sweeper.
 *   - `lockedBy` is informational; `lockedUntil` is what the lookup
 *     actually filters on.
 */

export const QueueValidationError = BaseError.subclass("QueueValidationError", {
  props: {
    _brand: "FiefApp.Queue.ValidationError" as const,
  },
});

const queueJobIdSchema = z.string().min(1).brand("QueueJobId");

export type QueueJobId = z.infer<typeof queueJobIdSchema>;

export const createQueueJobId = (raw: string) =>
  fromThrowable(queueJobIdSchema.parse, (error) => QueueValidationError.normalize(error))(raw);

/**
 * Persisted job entity — what the repo round-trips.
 *
 * Note `payload` is `unknown` deliberately: producers (T26-T29) hand in
 * domain-specific shapes (a Saleor `customer_created` payload, a
 * subscription update, a reconciliation diff). The handler registered
 * in the worker is responsible for narrowing the payload to its own
 * domain shape — the queue is type-erased on payload by design so a
 * single queue can carry every event type.
 */
export const queueJobSchema = z.object({
  id: queueJobIdSchema,
  saleorApiUrl: z
    .string()
    .min(1)
    .transform((value) => value as SaleorApiUrl),
  connectionId: z
    .string()
    .min(1)
    .transform((value) => value as WebhookLogConnectionId),
  /**
   * Event type discriminator — the worker uses this to route to the
   * registered handler. Producers (T26-T29) supply concrete strings like
   * `"customer.created"`, `"customer.updated"`, etc.
   */
  eventType: z.string().min(1),
  /**
   * Deduplication key. Unique across the whole queue. Producers must
   * supply a stable id; for Saleor webhooks the natural source is the
   * webhook event id; for T32 reconciliation a synthetic id is fine as
   * long as it's stable across the same logical event.
   */
  eventId: z
    .string()
    .min(1)
    .transform((value) => value as WebhookEventId),
  payload: z.unknown(),
  /**
   * Number of dispatch attempts that have completed (success or failure).
   * Initialized to 0 on enqueue. Incremented by `releaseWithBackoff`.
   * The worker compares against `maxAttempts` to decide DLQ handoff.
   */
  attempts: z.number().int().nonnegative(),
  /**
   * Earliest wall-clock at which the job is eligible for `lease()`.
   * Producers initialize this to `now` so a fresh job is immediately
   * leasable. `releaseWithBackoff` pushes it forward by the computed
   * exponential backoff.
   */
  nextAttemptAt: z.date(),
  /**
   * Worker id holding the active lease, if any. Informational only — the
   * lease lookup filters on `lockedUntil`. `undefined` when the row has
   * never been leased or the lease was released cleanly.
   */
  lockedBy: z.string().min(1).optional(),
  /**
   * Wall-clock at which the active lease expires. `undefined` when no
   * lease is active. The lease query is `nextAttemptAt <= now AND
   * (lockedUntil missing OR lockedUntil < now)` — so a worker that
   * crashes mid-dispatch leaves a row that becomes leasable again as
   * soon as `lockedUntil` passes.
   */
  lockedUntil: z.date().optional(),
  createdAt: z.date(),
});
export type QueueJob = z.infer<typeof queueJobSchema>;

/**
 * Producer-side input for `enqueue(...)`. The repo assigns `id`,
 * `attempts: 0`, `nextAttemptAt: now`, `createdAt: now`.
 */
export interface EnqueueJobInput {
  saleorApiUrl: SaleorApiUrl;
  connectionId: WebhookLogConnectionId;
  eventType: string;
  eventId: WebhookEventId;
  payload: unknown;
}

/**
 * Filters for `peek(...)`. All fields optional — peek is a diagnostics
 * primitive (operator UI / tests). Returns up to 1000 rows by default.
 */
export interface QueuePeekFilters {
  saleorApiUrl?: SaleorApiUrl;
  eventType?: string;
  /** Inclusive lower bound on `createdAt`. */
  createdAfter?: Date;
  /** Page-size cap. Repo enforces `Math.min(limit, 1000)`. */
  limit?: number;
}

/**
 * Default exponential-backoff window per the plan: max 6 attempts,
 * capped at 10 minutes.
 *
 * Schedule (in seconds): 1, 4, 16, 64, 256, 600.
 *
 * Computed as `min(BASE_MS * 4^attempts, MAX_BACKOFF_MS)`. Exposed so
 * producer-side telemetry (T37 dashboard) can compute "next attempt at"
 * without re-implementing the formula.
 */
export const QUEUE_BACKOFF_BASE_MS = 1_000;
export const QUEUE_BACKOFF_MAX_MS = 10 * 60 * 1_000;
export const QUEUE_DEFAULT_MAX_ATTEMPTS = 6;

/**
 * Compute the next-attempt-at delay for the given attempt count.
 * `attempts` is the *new* attempt count after the failure — i.e. the
 * worker has already incremented it before calling this.
 */
export const computeBackoffMs = (attempts: number): number => {
  if (attempts <= 0) {
    return 0;
  }
  const raw = QUEUE_BACKOFF_BASE_MS * Math.pow(4, attempts - 1);

  return Math.min(raw, QUEUE_BACKOFF_MAX_MS);
};
