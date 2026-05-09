/**
 * T51 — `dlq` tRPC sub-router.
 *
 * Single procedure today:
 *   - `replay` — run a DLQ entry back through the production dispatch
 *     path (T22 receiver for `fief_to_saleor`, T52 outbound queue for
 *     `saleor_to_fief`). Refuses to replay against soft-deleted
 *     connections — the explicit `connection_deleted` error code is the
 *     contract with T37's UI ("Replay" button stays disabled with a
 *     tooltip).
 *
 * Conventions:
 *   - Behind `protectedClientProcedure` (T33) — dashboard JWT + APL
 *     auth runs first.
 *   - Use case is dependency-injected via `buildDlqRouter({ useCase })`
 *     so unit tests can pass a stub without booting Mongo / Fief HTTP.
 *     Production wires the live use case in `modules/trpc/trpc-router.ts`.
 *   - Use-case error codes (T51's `DlqReplayErrorCode`) translate to
 *     tRPC errors with the explicit code preserved in the message. T37
 *     UI parses the message for the "connection_deleted" sentinel.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import { type DlqEntryId } from "./dlq";
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

export interface DlqRouterDeps {
  useCase: DlqReplayUseCaseSeam;
}

export const buildDlqRouter = (deps: DlqRouterDeps) => {
  const { useCase } = deps;

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
  });
};

export type DlqRouter = ReturnType<typeof buildDlqRouter>;
