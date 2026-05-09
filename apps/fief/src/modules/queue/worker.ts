import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logger";
import {
  createWebhookEventId,
  createWebhookLogConnectionId,
  createWebhookLogId,
} from "@/modules/webhook-log/webhook-log";
import {
  type RecordWebhookLogInput,
  type WebhookLogRepo,
} from "@/modules/webhook-log/webhook-log-repo";

import { computeBackoffMs, QUEUE_DEFAULT_MAX_ATTEMPTS, type QueueJob } from "./queue";
import { type OutboundQueueRepo } from "./queue-repo";

/*
 * T52 — In-process worker that drains the outbound queue.
 *
 * Runtime contract: this module is **nodejs-only**. It uses
 * `setTimeout` + `randomUUID` and consumes the singleton Mongo client,
 * none of which is allowed in the Edge runtime. Routes that import this
 * file MUST declare `export const runtime = "nodejs"`. The boot wiring
 * (a follow-up to T52, per the plan) lives in `instrumentation.ts` and
 * is gated by a `process.env.NEXT_RUNTIME === "nodejs"` check there.
 *
 * Lifecycle:
 *   - `startWorker(handlers, options)` — kicks off the polling loop on
 *     the next event-loop tick (does NOT block the caller). Idempotent:
 *     a second `startWorker` while one is running is a no-op (and logs).
 *   - `stopWorker()` — sets the running flag to `false`, signals the
 *     in-flight poll to abort, and resolves once the loop has actually
 *     ended. Safe to call multiple times.
 *
 * Per-iteration behavior:
 *   1. Call `repo.lease(workerId, leaseMs)`. If `null` → sleep
 *      `pollIntervalMs` and continue.
 *   2. Look up the handler for `job.eventType`. If missing, log + retry
 *      with backoff (don't drop — the deploy may be mid-rollout and a
 *      handler will register on the next deploy).
 *   3. Invoke `handler(job)`.
 *      - Resolve → `repo.complete(job.id)`.
 *      - Reject (or throw) → increment attempts, compute backoff, then:
 *        - if `attempts < maxAttempts`: `repo.releaseWithBackoff(...)`.
 *        - if `attempts >= maxAttempts`: hand off to the DLQ via the
 *          T11 webhook-log flow:
 *            - record the row (idempotent on
 *              `(saleorApiUrl, "saleor_to_fief", eventId)`)
 *            - record an attempt with the final error so the row's
 *              status flips to `"dead"` and `becameDead === true`
 *            - call `webhookLogRepo.moveToDlq` to migrate the row
 *            - `repo.complete(job.id)` to drop the queue row.
 *
 * The DLQ handoff is best-effort with extensive structured logging — if
 * the webhook-log writes fail, we still `complete()` the queue row and
 * log loudly so the operator can find the orphan via metrics. Leaving a
 * dead row in the queue forever is worse than a logged DLQ-write
 * failure.
 */

const logger = createLogger("modules.queue.worker");

export type QueueHandler = (job: QueueJob) => Promise<void>;

export interface WorkerHandlerRegistry {
  handlers: Record<string, QueueHandler>;
  /**
   * Optional T11 `WebhookLogRepo` used for the DLQ handoff. When
   * unset, terminal failures are dropped from the queue with a loud
   * log line — useful in unit tests of pure handlers, but the
   * production wiring MUST supply this.
   */
  webhookLogRepo?: WebhookLogRepo;
}

export interface WorkerOptions {
  repo: OutboundQueueRepo;
  /**
   * How long to wait between empty `lease()` polls. Lower = more
   * responsive but more Mongo load. Default 250ms is the sweet spot
   * for low-throughput async event traffic; the production wiring may
   * raise this in lower-traffic environments.
   */
  pollIntervalMs?: number;
  /**
   * How long to hold the lease for. The dispatcher's effective max
   * processing budget per job. The handler that exceeds this risks
   * having its job re-leased by another worker, so the upper bound
   * should be picked with a comfortable margin over the slowest
   * handler. Default 60s.
   */
  leaseMs?: number;
  /**
   * Per-job retry cap. Default `QUEUE_DEFAULT_MAX_ATTEMPTS = 6` per
   * the plan. T51 bulk-replay tooling may wire a larger cap when
   * draining a backlog.
   */
  maxAttempts?: number;
  /**
   * Distinguishes this worker process in lease ownership and logs.
   * Defaults to a random UUID per `startWorker` call. Ops can override
   * to make logs grep-friendly.
   */
  workerId?: string;
}

interface WorkerState {
  running: boolean;
  loopPromise: Promise<void> | null;
  workerId: string;
}

/*
 * Module-level singleton. The boot wiring calls `startWorker` once;
 * tests call it many times across `beforeEach`. The state captures
 * "is there a loop in flight" so re-entry is safe.
 */
let state: WorkerState = {
  running: false,
  loopPromise: null,
  workerId: "uninitialized",
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Kick off the polling loop. Does NOT await — returns synchronously
 * after scheduling the loop. Use `stopWorker()` to halt it.
 *
 * Calling `startWorker` while a loop is already running is a no-op
 * (logged at warn). To restart with new options, `stopWorker()` first.
 */
export const startWorker = (registry: WorkerHandlerRegistry, options: WorkerOptions): void => {
  if (state.running) {
    logger.warn("startWorker called while a worker loop is already running; ignoring", {
      workerId: state.workerId,
    });

    return;
  }

  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? QUEUE_DEFAULT_MAX_ATTEMPTS;

  state = {
    running: true,
    loopPromise: null,
    workerId,
  };

  logger.info("starting outbound queue worker", { workerId, pollIntervalMs, leaseMs, maxAttempts });

  state.loopPromise = (async () => {
    while (state.running) {
      try {
        const leased = await options.repo.lease(workerId, leaseMs);

        if (leased.isErr()) {
          logger.error("lease failed; backing off", {
            workerId,
            error: leased.error.message,
          });
          await sleep(pollIntervalMs);
          continue;
        }

        const job = leased.value;

        if (!job) {
          await sleep(pollIntervalMs);
          continue;
        }

        await dispatchJob({
          job,
          handler: registry.handlers[job.eventType],
          webhookLogRepo: registry.webhookLogRepo,
          repo: options.repo,
          maxAttempts,
          workerId,
        });
      } catch (cause) {
        /*
         * Defensive — the polling loop must NEVER unwind on an
         * unexpected throw (e.g. transient Mongo error not caught by
         * the repo). Log + back off + continue.
         */
        logger.error("unexpected error in worker loop; backing off", {
          workerId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        await sleep(pollIntervalMs);
      }
    }

    logger.info("outbound queue worker stopped", { workerId });
  })();
};

/**
 * Halt the polling loop and resolve when the in-flight iteration has
 * finished. Safe to call when no worker is running (no-op).
 */
export const stopWorker = async (): Promise<void> => {
  if (!state.running) {
    return;
  }

  state.running = false;

  if (state.loopPromise) {
    await state.loopPromise;
  }

  state = {
    running: false,
    loopPromise: null,
    workerId: "stopped",
  };
};

interface DispatchArgs {
  job: QueueJob;
  handler: QueueHandler | undefined;
  webhookLogRepo: WebhookLogRepo | undefined;
  repo: OutboundQueueRepo;
  maxAttempts: number;
  workerId: string;
}

async function dispatchJob({
  job,
  handler,
  webhookLogRepo,
  repo,
  maxAttempts,
  workerId,
}: DispatchArgs): Promise<void> {
  if (!handler) {
    /*
     * No handler for this event type. Treat as a transient failure so
     * a mid-rollout deploy that hasn't registered the handler yet
     * doesn't murder the row.
     */
    const attempts = job.attempts + 1;
    const next = new Date(Date.now() + computeBackoffMs(attempts));

    logger.warn("no handler registered for event type; rescheduling", {
      workerId,
      jobId: String(job.id),
      eventType: job.eventType,
      attempts,
    });

    if (attempts >= maxAttempts) {
      // Same DLQ-handoff path as a permanent handler failure.
      await terminalFail({
        job,
        error: `No handler registered for event type "${job.eventType}"`,
        webhookLogRepo,
        repo,
        maxAttempts,
        workerId,
      });

      return;
    }

    const released = await repo.releaseWithBackoff(job.id, attempts, next);

    if (released.isErr()) {
      logger.error("releaseWithBackoff failed for orphan job", {
        workerId,
        jobId: String(job.id),
        error: released.error.message,
      });
    }

    return;
  }

  try {
    await handler(job);

    const completed = await repo.complete(job.id);

    if (completed.isErr()) {
      logger.error("complete failed after successful dispatch", {
        workerId,
        jobId: String(job.id),
        error: completed.error.message,
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const attempts = job.attempts + 1;

    if (attempts >= maxAttempts) {
      await terminalFail({
        job,
        error: message,
        webhookLogRepo,
        repo,
        maxAttempts,
        workerId,
      });

      return;
    }

    const next = new Date(Date.now() + computeBackoffMs(attempts));

    logger.warn("handler failed; rescheduling with backoff", {
      workerId,
      jobId: String(job.id),
      eventType: job.eventType,
      attempts,
      backoffMs: next.getTime() - Date.now(),
      error: message,
    });

    const released = await repo.releaseWithBackoff(job.id, attempts, next);

    if (released.isErr()) {
      logger.error("releaseWithBackoff failed", {
        workerId,
        jobId: String(job.id),
        error: released.error.message,
      });
    }
  }
}

interface TerminalFailArgs {
  job: QueueJob;
  error: string;
  webhookLogRepo: WebhookLogRepo | undefined;
  repo: OutboundQueueRepo;
  maxAttempts: number;
  workerId: string;
}

/**
 * Terminal-failure path: hand the row off to T11's DLQ via the
 * webhook-log flow, then `complete()` the queue row regardless of
 * whether the DLQ write succeeded. The queue row should NEVER linger
 * past max attempts — the operator dashboard relies on the queue
 * representing only "still trying".
 */
async function terminalFail({
  job,
  error,
  webhookLogRepo,
  repo,
  maxAttempts,
  workerId,
}: TerminalFailArgs): Promise<void> {
  logger.error("job exhausted retries; handing off to DLQ", {
    workerId,
    jobId: String(job.id),
    eventType: job.eventType,
    attempts: maxAttempts,
    error,
  });

  if (!webhookLogRepo) {
    /*
     * Unit-test path: no webhook-log repo configured. Just drop the
     * queue row and log loudly. Production boot wiring MUST supply
     * webhookLogRepo so this branch never fires in real life.
     */
    logger.error(
      "DLQ handoff skipped — webhookLogRepo not configured (queue row dropped without DLQ entry)",
      {
        workerId,
        jobId: String(job.id),
        eventType: job.eventType,
      },
    );

    const completed = await repo.complete(job.id);

    if (completed.isErr()) {
      logger.error("complete failed during DLQ-skip terminal-fail path", {
        workerId,
        jobId: String(job.id),
        error: completed.error.message,
      });
    }

    return;
  }

  /*
   * The T11 contract is: `record({...})` to insert a fresh row (or get
   * the existing one back on de-duplication), then
   * `recordAttempt({..., maxAttempts, error})` until
   * `becameDead === true`, then `moveToDlq(id)`. We jump straight to
   * "record once + flip to dead in one attempt" by passing
   * `maxAttempts: 1` to `recordAttempt`. That keeps the DLQ row's
   * `attempts` field accurate (the real attempts count comes from the
   * queue job, not the webhook-log row).
   */
  const recordInput: RecordWebhookLogInput = {
    saleorApiUrl: webhookLogRepoSaleorApiUrl(job),
    connectionId: createWebhookLogConnectionId(String(job.connectionId))._unsafeUnwrap(),
    direction: "saleor_to_fief",
    eventId: createWebhookEventId(String(job.eventId))._unsafeUnwrap(),
    eventType: job.eventType,
    payloadRedacted: job.payload,
    initialStatus: "retrying",
  };

  const recorded = await webhookLogRepo.record(recordInput);

  if (recorded.isErr()) {
    logger.error("DLQ handoff: webhook-log record failed; dropping queue row anyway", {
      workerId,
      jobId: String(job.id),
      eventType: job.eventType,
      error: recorded.error.message,
    });

    await safeComplete(repo, job, workerId);

    return;
  }

  const recordedRow = recorded.value;

  /*
   * Drive the row into `"dead"` with a single recordAttempt by setting
   * `maxAttempts: recordedRow.attempts + 1`. This works whether the row
   * is a fresh insert (attempts=0 → max=1, first attempt flips dead) or
   * a de-duplication hit (attempts=N → max=N+1, next attempt flips
   * dead).
   */
  const flippedAttempt = await webhookLogRepo.recordAttempt({
    id: recordedRow.id,
    maxAttempts: recordedRow.attempts + 1,
    error,
  });

  if (flippedAttempt.isErr()) {
    logger.error("DLQ handoff: recordAttempt failed; dropping queue row anyway", {
      workerId,
      jobId: String(job.id),
      eventType: job.eventType,
      error: flippedAttempt.error.message,
    });

    await safeComplete(repo, job, workerId);

    return;
  }

  /*
   * Update the dead row's attempts to reflect the queue's actual
   * attempt count before moving to DLQ. We invoke recordAttempt enough
   * extra times if needed; since the row is already "dead", subsequent
   * attempts only bump the counter. This keeps the DLQ entry's
   * attempts field meaningful for operator triage.
   *
   * NB: each extra call increments by 1 — so total iterations is
   * `maxAttempts - flippedAttempt.value.row.attempts`. Capped to avoid
   * pathological loops if attempts has somehow drifted high.
   */
  let currentRow = flippedAttempt.value.row;
  let safetyBudget = maxAttempts;

  while (currentRow.attempts < maxAttempts && safetyBudget-- > 0) {
    const bump = await webhookLogRepo.recordAttempt({
      id: currentRow.id,
      // The row is already "dead"; we just want the counter to climb.
      maxAttempts: currentRow.attempts + 1,
      error,
    });

    if (bump.isErr()) {
      logger.warn("DLQ handoff: failed to bump attempts on dead row", {
        workerId,
        jobId: String(job.id),
        error: bump.error.message,
      });
      break;
    }

    currentRow = bump.value.row;
  }

  const moved = await webhookLogRepo.moveToDlq(currentRow.id);

  if (moved.isErr()) {
    logger.error("DLQ handoff: moveToDlq failed; dropping queue row anyway", {
      workerId,
      jobId: String(job.id),
      webhookLogId: String(currentRow.id),
      error: moved.error.message,
    });
  } else {
    logger.info("DLQ handoff complete", {
      workerId,
      jobId: String(job.id),
      webhookLogId: String(currentRow.id),
      eventType: job.eventType,
    });
  }

  await safeComplete(repo, job, workerId);
}

async function safeComplete(
  repo: OutboundQueueRepo,
  job: QueueJob,
  workerId: string,
): Promise<void> {
  const completed = await repo.complete(job.id);

  if (completed.isErr()) {
    logger.error("complete failed during terminal-fail path", {
      workerId,
      jobId: String(job.id),
      error: completed.error.message,
    });
  }
}

/*
 * The webhook-log row needs the SaleorApiUrl branded type. The job's
 * `saleorApiUrl` is already branded (round-tripped through Zod at
 * insert time), but the schema's transform on read is a flat cast —
 * which is fine because the branded constraint is structural / type-
 * level and verified at producer time.
 */
function webhookLogRepoSaleorApiUrl(job: QueueJob) {
  return job.saleorApiUrl;
}

/*
 * Test-only: surface the internal state so tests can assert on
 * idempotence of `startWorker`. Not part of the public API.
 */
export const __getWorkerStateForTests = (): Readonly<WorkerState> => state;

/*
 * Re-export the helper that constructs the WebhookLogId branded type so
 * future hand-rolled DLQ handoffs (or tooling) don't have to import
 * from two modules.
 */
export { createWebhookLogId };
