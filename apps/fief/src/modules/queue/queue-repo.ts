import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import {
  type EnqueueJobInput,
  type QueueJob,
  type QueueJobId,
  type QueuePeekFilters,
} from "./queue";

/*
 * T52 — Repository interface for the `outbound_queue` collection.
 *
 * Lives next to the domain (mirrors T11's structure) so consumers can
 * `import type { OutboundQueueRepo }` without pulling Mongo into their
 * bundle. The Mongo impl is the only impl today; an in-memory test
 * variant could drop in for handler-level unit tests later.
 *
 * All methods return `Result` per the project convention; the worker
 * (`worker.ts`) composes them via `andThen` and never throws across the
 * dispatch boundary.
 */

export const QueueRepoError = BaseError.subclass("QueueRepoError", {
  props: {
    _brand: "FiefApp.Queue.RepoError" as const,
  },
});

export const QueueJobNotFoundError = BaseError.subclass("QueueJobNotFoundError", {
  props: {
    _brand: "FiefApp.Queue.JobNotFoundError" as const,
  },
});

export interface OutboundQueueRepo {
  /**
   * Insert a new job. Idempotent on `eventId` — a duplicate enqueue
   * returns the existing job (so a webhook redelivery doesn't double-
   * process). The first call wins; subsequent calls do NOT mutate the
   * stored row.
   */
  enqueue(input: EnqueueJobInput): Promise<Result<QueueJob, InstanceType<typeof QueueRepoError>>>;

  /**
   * Atomically claim the next due job for `workerId`. Returns `null`
   * when no eligible job exists.
   *
   * Eligibility: `nextAttemptAt <= now AND (lockedUntil missing OR
   * lockedUntil < now)`. Multiple concurrent workers calling `lease()`
   * against the same single eligible row are guaranteed by the
   * underlying `findOneAndUpdate` to see exactly one winner.
   *
   * The lease is held for `leaseMs` from the call time. If the worker
   * crashes mid-dispatch, the lease expires and the row becomes
   * leasable again — no separate sweeper required.
   */
  lease(
    workerId: string,
    leaseMs: number,
  ): Promise<Result<QueueJob | null, InstanceType<typeof QueueRepoError>>>;

  /**
   * Permanently remove a job from the queue. Called by the worker on
   * successful dispatch, AND on terminal-failure-after-DLQ-handoff.
   * Idempotent — completing an already-removed id is a no-op.
   */
  complete(
    jobId: QueueJobId,
  ): Promise<Result<void, InstanceType<typeof QueueRepoError | typeof QueueJobNotFoundError>>>;

  /**
   * Release the lease and reschedule the job. Increments persisted
   * attempts to `attempts` (caller-supplied — usually `current + 1`)
   * and sets `nextAttemptAt` to `nextAttemptAt`. Clears `lockedBy` /
   * `lockedUntil` so the job is leasable again at `nextAttemptAt`.
   */
  releaseWithBackoff(
    jobId: QueueJobId,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<Result<void, InstanceType<typeof QueueRepoError | typeof QueueJobNotFoundError>>>;

  /**
   * Diagnostic read — returns rows matching `filters` sorted by
   * `nextAttemptAt` asc. Used by tests + the operator dashboard
   * (T37). Capped at 1000 rows internally.
   */
  peek(filters: QueuePeekFilters): Promise<Result<QueueJob[], InstanceType<typeof QueueRepoError>>>;
}
