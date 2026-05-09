// cspell:ignore opensensor

import { err, ok, type Result } from "neverthrow";

import { type createLogger } from "@/lib/logger";
import {
  type DlqEntry,
  type DlqEntryId,
  type WebhookEventId,
  type WebhookLogConnectionId,
} from "@/modules/dlq/dlq";
import { type DlqRepo } from "@/modules/dlq/dlq-repo";
import {
  createProviderConnectionId,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { type EnqueueJobInput } from "@/modules/queue/queue";
import { type OutboundQueueRepo } from "@/modules/queue/queue-repo";
import { type WebhookEventPayload } from "@/modules/sync/fief-to-saleor/event-router";
import { type WebhookLogRepo } from "@/modules/webhook-log/webhook-log-repo";

/*
 * T51 — DLQ replay use case.
 *
 * Operator triggers via the dashboard (T37). Behavior per the plan:
 *
 *   1. Load DLQ entry (T11). Missing -> `not_found`.
 *   2. Load the bound connection by id (T8 tenant-scoped read). If the
 *      connection is soft-deleted -> `connection_deleted` error code.
 *      The DLQ row stays put; T37 UI consumes the explicit code to
 *      keep the "Replay" button disabled with a tooltip.
 *   3. Branch by direction:
 *        - `fief_to_saleor`  -> dispatch via T22's receiver path
 *          (we go through the EventRouter shape so all the cross-
 *           cutting work the receiver did the first time around stays
 *           consistent on replay).
 *        - `saleor_to_fief`  -> re-enqueue via T52's outbound queue.
 *   4. On success: delete the DLQ row (T11). Record a replay attempt
 *      in `webhook_log` so the audit trail captures the manual
 *      intervention.
 *
 * Soft-delete refusal is mandatory — the plan requires the explicit
 * `connection_deleted` code as the contract with the T37 UI, so a
 * future refactor that lets a soft-deleted connection's events replay
 * silently would break R12 (operator UI guarantee).
 *
 * The use case only orchestrates — it never bypasses the receiver or
 * the queue. Both branches go through the production dispatch path so
 * a replay is identical to a first-time delivery from the consumer's
 * point of view.
 */

/*
 * ---------------------------------------------------------------------------
 * Public error union
 * ---------------------------------------------------------------------------
 */

export type DlqReplayErrorCode =
  /** DLQ entry id does not exist (or was already deleted). */
  | "not_found"
  /**
   * Bound connection is soft-deleted (or has disappeared entirely). T37
   * UI keys off this exact code to disable the "Replay" button — do NOT
   * fold this into `replay_failed`.
   */
  | "connection_deleted"
  /** Repo I/O failed while loading prerequisites. */
  | "internal"
  /** The replay step itself (dispatch / enqueue) returned a failure. */
  | "replay_failed";

/**
 * Replay error payload. Returned via `Result.err(...)` so callers can
 * branch on `code` without instanceof checks.
 */
export interface DlqReplayError {
  code: DlqReplayErrorCode;
  message: string;
  /**
   * Optional underlying cause — operator-visible logs include this; the
   * tRPC layer translates it to a structured TRPCError.
   */
  cause?: unknown;
}

/*
 * ---------------------------------------------------------------------------
 * Public output
 * ---------------------------------------------------------------------------
 */

export interface DlqReplayResult {
  replayed: true;
  direction: "fief_to_saleor" | "saleor_to_fief";
}

/*
 * ---------------------------------------------------------------------------
 * Collaborator seams
 * ---------------------------------------------------------------------------
 */

/**
 * Minimal subset of the T22 receiver path the use case touches. We
 * accept a structural type rather than the full `FiefReceiver` class so
 * the use case can be wired against either the eventRouter directly
 * (production) or a hand-rolled stub (tests). The shape mirrors
 * `EventRouter.dispatch`: the production composition root passes
 * `eventRouter.dispatch.bind(eventRouter)` through this seam.
 */
export interface FiefReceiverDispatchSeam {
  dispatch(payload: WebhookEventPayload): Promise<Result<unknown, never>>;
}

/**
 * Minimal subset of T52's `OutboundQueueRepo`. We only use `enqueue`
 * — narrowing the seam keeps the test stubs honest.
 */
export type OutboundQueueEnqueueSeam = Pick<OutboundQueueRepo, "enqueue">;

export interface DlqReplayUseCaseDeps {
  dlqRepo: DlqRepo;
  webhookLogRepo: WebhookLogRepo;
  providerConnectionRepo: ProviderConnectionRepo;
  fiefReceiver: FiefReceiverDispatchSeam;
  outboundQueue: OutboundQueueEnqueueSeam;
  logger: ReturnType<typeof createLogger>;
}

export interface DlqReplayInput {
  dlqEntryId: DlqEntryId;
}

/*
 * ---------------------------------------------------------------------------
 * Use case
 * ---------------------------------------------------------------------------
 */

export class DlqReplayUseCase {
  private readonly dlqRepo: DlqRepo;
  private readonly webhookLogRepo: WebhookLogRepo;
  private readonly providerConnectionRepo: ProviderConnectionRepo;
  private readonly fiefReceiver: FiefReceiverDispatchSeam;
  private readonly outboundQueue: OutboundQueueEnqueueSeam;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(deps: DlqReplayUseCaseDeps) {
    this.dlqRepo = deps.dlqRepo;
    this.webhookLogRepo = deps.webhookLogRepo;
    this.providerConnectionRepo = deps.providerConnectionRepo;
    this.fiefReceiver = deps.fiefReceiver;
    this.outboundQueue = deps.outboundQueue;
    this.logger = deps.logger;
  }

  async replay(input: DlqReplayInput): Promise<Result<DlqReplayResult, DlqReplayError>> {
    /*
     * Step 1 — load the DLQ entry. Missing id is a 404 / `not_found`
     * (operator picked a row that was already discarded or never
     * existed).
     */
    const loadResult = await this.dlqRepo.getById(input.dlqEntryId);

    if (loadResult.isErr()) {
      this.logger.error("DLQ replay: getById failed", {
        dlqEntryId: input.dlqEntryId,
        error: loadResult.error,
      });

      return err({
        code: "internal",
        message: "Failed to load DLQ entry",
        cause: loadResult.error,
      });
    }

    const entry = loadResult.value;

    if (entry === null) {
      this.logger.warn("DLQ replay: entry not found", { dlqEntryId: input.dlqEntryId });

      return err({ code: "not_found", message: `DLQ entry ${input.dlqEntryId} not found` });
    }

    /*
     * Step 2 — load the bound connection. We use the tenant-scoped repo
     * read (T8) because the DLQ row carries `saleorApiUrl` — no need
     * for the cross-tenant `findConnectionById` seam the inbound
     * receiver uses.
     *
     * `includeSoftDeleted: true` is mandatory: a soft-deleted
     * connection wouldn't be returned by the default read path, but we
     * need to *see* it to return the explicit `connection_deleted`
     * code (T37 UI contract). Without that flag the operator would see
     * `not_found` for both "deleted" and "never existed", which T37 has
     * to disambiguate.
     */
    let connectionUuid: ProviderConnectionId;

    try {
      connectionUuid = createProviderConnectionId(entry.connectionId as unknown as string);
    } catch (cause) {
      this.logger.error("DLQ replay: malformed connectionId on DLQ row", {
        dlqEntryId: input.dlqEntryId,
        connectionId: entry.connectionId,
      });

      return err({
        code: "internal",
        message: "DLQ entry has malformed connectionId",
        cause,
      });
    }

    const connectionResult = await this.providerConnectionRepo.get({
      saleorApiUrl: entry.saleorApiUrl,
      id: connectionUuid,
      includeSoftDeleted: true,
    });

    if (connectionResult.isErr()) {
      const cause = connectionResult.error;

      // NotFound and soft-delete share the same operator-facing code.
      if (cause.constructor.name === "ProviderConnectionNotFoundError") {
        this.logger.warn("DLQ replay refused: connection not found", {
          dlqEntryId: input.dlqEntryId,
          connectionId: entry.connectionId,
        });

        return err({
          code: "connection_deleted",
          message: "Connection not found (deleted or never existed) — replay refused",
          cause,
        });
      }

      this.logger.error("DLQ replay: providerConnectionRepo.get failed", {
        dlqEntryId: input.dlqEntryId,
        error: cause,
      });

      return err({
        code: "internal",
        message: "Failed to load provider connection",
        cause,
      });
    }

    const connection = connectionResult.value;

    if (connection.softDeletedAt !== null) {
      this.logger.warn("DLQ replay refused: connection is soft-deleted", {
        dlqEntryId: input.dlqEntryId,
        connectionId: entry.connectionId,
        softDeletedAt: connection.softDeletedAt.toISOString(),
      });

      return err({
        code: "connection_deleted",
        message: "Connection is soft-deleted — replay refused",
      });
    }

    /*
     * Step 3 — branch on direction. The DLQ row's payload was already
     * redacted by the producer (T11 contract); the receiver / queue
     * consume the redacted shape on first delivery too, so re-feeding
     * it is correct.
     */
    const direction = entry.direction;

    if (direction === "fief_to_saleor") {
      const dispatchOutcome = await this.replayInbound(entry);

      if (dispatchOutcome.isErr()) {
        return err(dispatchOutcome.error);
      }
    } else if (direction === "saleor_to_fief") {
      const enqueueOutcome = await this.replayOutbound(entry);

      if (enqueueOutcome.isErr()) {
        return err(enqueueOutcome.error);
      }
    } else {
      /*
       * Exhaustive on `WebhookDirection`. If the union ever grows we
       * want a hard fail rather than silently falling through.
       */
      const _exhaustive: never = direction;

      void _exhaustive;

      return err({
        code: "internal",
        message: `Unknown DLQ row direction: ${String(direction)}`,
      });
    }

    /*
     * Step 4 — bookkeeping. Record the replay attempt in webhook_log
     * BEFORE deleting the DLQ row so a Mongo blip on the delete
     * doesn't lose the audit trail.
     *
     * The replay row uses a synthesized eventId so it doesn't collide
     * with the original (which already lives in the DLQ row's
     * `eventId`). The convention `replay-<original>-<timestamp>` keeps
     * the original visible for cross-referencing.
     */
    const replayEventId = `replay-${entry.eventId as unknown as string}-${Date.now()}`;
    const recordResult = await this.webhookLogRepo.record({
      saleorApiUrl: entry.saleorApiUrl,
      connectionId: entry.connectionId as unknown as WebhookLogConnectionId,
      direction: entry.direction,
      eventId: replayEventId as unknown as WebhookEventId,
      eventType: entry.eventType,
      payloadRedacted: entry.payloadRedacted,
      /*
       * Replay reaches here only when the dispatch / enqueue itself
       * succeeded — so the row is `ok` from the audit POV. The
       * outbound branch will re-walk the queue's own retry path if
       * the eventual handler fails; that's the queue's row, not this
       * audit row.
       */
      initialStatus: "ok",
    });

    if (recordResult.isErr()) {
      this.logger.error("DLQ replay: webhook_log record failed (replay still considered ok)", {
        dlqEntryId: input.dlqEntryId,
        error: recordResult.error,
      });
      /*
       * Don't fail the replay — the actual work is done. The audit
       * gap is logged.
       */
    }

    /*
     * Step 5 — delete the DLQ row. Idempotent on the repo side.
     */
    const deleteResult = await this.dlqRepo.delete(entry.id);

    if (deleteResult.isErr()) {
      this.logger.error("DLQ replay: dlqRepo.delete failed", {
        dlqEntryId: input.dlqEntryId,
        error: deleteResult.error,
      });

      return err({
        code: "internal",
        message: "Replay succeeded but DLQ row could not be deleted",
        cause: deleteResult.error,
      });
    }

    this.logger.info("DLQ replay succeeded", {
      dlqEntryId: input.dlqEntryId,
      direction: entry.direction,
      eventType: entry.eventType,
    });

    return ok({ replayed: true, direction });
  }

  /*
   * -------------------------------------------------------------------------
   * Direction-specific helpers
   * -------------------------------------------------------------------------
   */

  private async replayInbound(entry: DlqEntry): Promise<Result<void, DlqReplayError>> {
    const data =
      entry.payloadRedacted &&
      typeof entry.payloadRedacted === "object" &&
      !Array.isArray(entry.payloadRedacted)
        ? (entry.payloadRedacted as Record<string, unknown>)
        : ({} as Record<string, unknown>);

    const dispatchResult = await this.fiefReceiver.dispatch({
      type: entry.eventType,
      data,
      eventId: entry.eventId as unknown as string,
    });

    if (dispatchResult.isErr()) {
      /*
       * EventRouter contract is `Result.ok(...)` for every reachable
       * terminal state; an `err` here means the structural seam is
       * broken. Surface as `replay_failed` rather than `internal` so
       * the operator UI tells the user "your replay didn't run" rather
       * than "the app blew up" — both are accurate but the former is
       * the more actionable framing.
       */
      this.logger.error("DLQ replay: receiver dispatch returned err (should not happen)", {
        eventType: entry.eventType,
        error: dispatchResult.error,
      });

      return err({
        code: "replay_failed",
        message: "Receiver dispatch returned an error",
        cause: dispatchResult.error,
      });
    }

    const outcome = dispatchResult.value as { kind: string };

    if (outcome.kind === "failed") {
      this.logger.warn("DLQ replay: handler returned failure on replay", {
        eventType: entry.eventType,
      });

      return err({
        code: "replay_failed",
        message: `Handler for "${entry.eventType}" returned a failure on replay`,
        cause: outcome,
      });
    }

    /*
     * `dispatched` and `no-handler` are both ok — `no-handler` is the
     * documented forward-compat path (a handler may have been removed
     * since the original failure; replay is a no-op in that case).
     */
    return ok(undefined);
  }

  private async replayOutbound(entry: DlqEntry): Promise<Result<void, DlqReplayError>> {
    const enqueueInput: EnqueueJobInput = {
      saleorApiUrl: entry.saleorApiUrl,
      connectionId: entry.connectionId as unknown as WebhookLogConnectionId,
      eventType: entry.eventType,
      eventId: entry.eventId as unknown as WebhookEventId,
      payload: entry.payloadRedacted,
    };

    const enqueueResult = await this.outboundQueue.enqueue(enqueueInput);

    if (enqueueResult.isErr()) {
      this.logger.error("DLQ replay: outbound enqueue failed", {
        eventType: entry.eventType,
        error: enqueueResult.error,
      });

      return err({
        code: "replay_failed",
        message: "Failed to re-enqueue outbound job",
        cause: enqueueResult.error,
      });
    }

    return ok(undefined);
  }
}
