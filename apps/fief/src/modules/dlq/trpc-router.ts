/**
 * T51 / T37 — `dlq` tRPC sub-router.
 *
 * Procedures:
 *   - `replay` (T51) — run a DLQ entry back through the production
 *     dispatch path (T22 receiver for `fief_to_saleor`, T52 outbound
 *     queue for `saleor_to_fief`). Refuses to replay against
 *     soft-deleted connections — the explicit `connection_deleted`
 *     error code is the contract with T37's UI ("Replay" button stays
 *     disabled with a tooltip).
 *   - `list` (T37) — list DLQ entries scoped to the current install.
 *     Sorted by `movedToDlqAt` desc. Optional filters: `connectionId`,
 *     `limit`, `before` (ISO timestamp cursor). `connectionId` and
 *     `before` are applied post-fetch in the router (the existing
 *     `DlqRepo.list` interface from T11 only filters by
 *     `saleorApiUrl + movedAfter + limit`).
 *
 * Conventions:
 *   - Behind `protectedClientProcedure` (T33) — dashboard JWT + APL
 *     auth runs first.
 *   - Use case + repo are dependency-injected via
 *     `buildDlqRouter({ useCase, repo })` so unit tests can pass stubs
 *     without booting Mongo / Fief HTTP. Production wires live
 *     instances in `modules/trpc/trpc-router.ts`.
 *   - Use-case error codes (T51's `DlqReplayErrorCode`) translate to
 *     tRPC errors with the explicit code preserved in the message. T37
 *     UI parses the message for the "connection_deleted" sentinel.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import { type DlqEntry, type DlqEntryId } from "./dlq";
import { type DlqRepo } from "./dlq-repo";
import {
  type DlqReplayError,
  type DlqReplayResult,
  type DlqReplayUseCase,
} from "./replay.use-case";

const replayInputSchema = z.object({
  dlqEntryId: z.string().min(1, "dlqEntryId must be non-empty"),
});

/**
 * Translate a `DlqReplayError` into a `TRPCError`. The explicit code is
 * appended to `message` so T37's UI can detect `connection_deleted`
 * without inspecting nested fields (tRPC strips type info on the wire).
 */
const mapReplayErrorToTrpc = (error: DlqReplayError): TRPCError => {
  const message = `${error.code}: ${error.message}`;

  switch (error.code) {
    case "not_found":
      return new TRPCError({ code: "NOT_FOUND", message });
    case "connection_deleted":
      /*
       * PRECONDITION_FAILED matches the "your upstream-system call
       * failed; not a bug in this app" framing the connections router
       * already uses.
       */
      return new TRPCError({ code: "PRECONDITION_FAILED", message });
    case "replay_failed":
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
    case "internal":
    default:
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
  }
};

/**
 * Minimal subset of `DlqReplayUseCase` the router consumes. Keeps the
 * test stub tight — replay is the only public method.
 */
export type DlqReplayUseCaseSeam = Pick<DlqReplayUseCase, "replay">;

/*
 * ---------------------------------------------------------------------------
 * `list` projection
 * ---------------------------------------------------------------------------
 */

/**
 * Header-only projection of a DLQ entry. The bulky `payloadRedacted`
 * stays in the repo row (the dashboard does not yet need it on the DLQ
 * list view; if we add a "view payload" panel for DLQ later it should
 * follow the `webhookLog.getPayload` lazy-load pattern).
 */
export interface DlqListRow {
  id: string;
  connectionId: string;
  direction: DlqEntry["direction"];
  eventId: string;
  eventType: string;
  status: DlqEntry["status"];
  attempts: number;
  lastError?: string;
  movedToDlqAt: string;
}

export interface DlqListResponse {
  rows: DlqListRow[];
}

const projectEntryToHeaderShape = (entry: DlqEntry): DlqListRow => ({
  id: entry.id as unknown as string,
  connectionId: entry.connectionId as unknown as string,
  direction: entry.direction,
  eventId: entry.eventId as unknown as string,
  eventType: entry.eventType,
  status: entry.status,
  attempts: entry.attempts,
  ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
  movedToDlqAt: entry.movedToDlqAt.toISOString(),
});

const listInputSchema = z.object({
  connectionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  /**
   * ISO-8601 timestamp; rows older than this (`movedToDlqAt < before`)
   * are returned. Sorted desc.
   */
  before: z.string().datetime().optional(),
});

export interface DlqRouterDeps {
  useCase: DlqReplayUseCaseSeam;
  /**
   * Optional repo for the T37 `list` procedure. Tests of the legacy
   * `replay`-only surface that don't construct a repo continue to work
   * by leaving this undefined; production wires the Mongo-backed repo
   * in `modules/trpc/trpc-router.ts`.
   */
  repo?: DlqRepo;
}

export const buildDlqRouter = (deps: DlqRouterDeps) => {
  const { useCase, repo } = deps;

  return router({
    /**
     * Replay a single DLQ entry. Refuses against soft-deleted
     * connections (returns `PRECONDITION_FAILED` with the
     * `connection_deleted:` sentinel in the message).
     */
    replay: protectedClientProcedure
      .input(replayInputSchema)
      .mutation(async ({ ctx, input }): Promise<DlqReplayResult> => {
        const result = await useCase.replay({
          dlqEntryId: input.dlqEntryId as unknown as DlqEntryId,
        });

        if (result.isErr()) {
          ctx.logger.warn("dlq.replay refused / failed", {
            dlqEntryId: input.dlqEntryId,
            code: result.error.code,
            message: result.error.message,
          });

          throw mapReplayErrorToTrpc(result.error);
        }

        return result.value;
      }),

    /**
     * List DLQ entries for the current install. Sorted by
     * `movedToDlqAt` desc. `connectionId` + `before` filters are
     * applied post-fetch.
     */
    list: protectedClientProcedure
      .input(listInputSchema)
      .query(async ({ ctx, input }): Promise<DlqListResponse> => {
        if (repo === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "DLQ repo not wired into router",
          });
        }

        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        const result = await repo.list({
          saleorApiUrl: saleorApiUrlResult.value,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });

        if (result.isErr()) {
          ctx.logger.error("dlq.list failed", { error: result.error });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to list DLQ entries",
          });
        }

        let rows = result.value;

        if (input.connectionId !== undefined) {
          const target = input.connectionId;

          rows = rows.filter((row) => (row.connectionId as unknown as string) === target);
        }

        if (input.before !== undefined) {
          const cutoff = new Date(input.before);

          rows = rows.filter((row) => row.movedToDlqAt < cutoff);
        }

        return { rows: rows.map(projectEntryToHeaderShape) };
      }),
  });
};

export type DlqRouter = ReturnType<typeof buildDlqRouter>;
