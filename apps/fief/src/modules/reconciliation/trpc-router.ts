/**
 * T38 — `reconciliation` tRPC sub-router.
 *
 * Procedures:
 *   - `runs.listForConnection({ connectionId, limit?, before? })`
 *       paginated history of reconciliation runs for one connection.
 *       Backed by T32's `ReconciliationRunHistoryRepo.listRecent(...)`.
 *
 *   - `runs.triggerOnDemand({ connectionId })`
 *       delegates to T32's `ReconciliationRunner.runForConnection(...)`.
 *       Returns a discriminated union:
 *         - { outcome: "ok", runId, summary, finalStatus, ... }
 *         - { outcome: "already_running", activeRunId }
 *         - { outcome: "kill_switch_disabled" }
 *       The `error` outcome from the runner is escalated to a tRPC
 *       `INTERNAL_SERVER_ERROR` (the operator UI shows a toast). The
 *       `already_running` outcome is INTENTIONALLY a normal return value
 *       (not a tRPC error) so the UI can render an info toast and keep
 *       the rest of the screen interactive.
 *
 *   - `flags.getForInstall()`
 *       returns the active "schema changed; reconciliation recommended"
 *       flag (T25) for the current install, or `null` if none. A row
 *       with a non-null `clearedAt` is treated as inactive (returns null).
 *       Serialized to ISO strings on the wire — tRPC json-serializes
 *       Date already, but we explicitly normalize the timestamps so the
 *       UI never has to touch raw `Date` instances either.
 *
 * Conventions:
 *   - Behind `protectedClientProcedure` (T33) — dashboard JWT + APL auth
 *     runs first.
 *   - Build factory pattern (T34): `buildReconciliationRouter(deps)` lets
 *     unit tests pass stubs without booting Mongo / Fief HTTP. Production
 *     wiring lives in `modules/trpc/trpc-router.ts`.
 *   - `n/no-process-env` clean: no env reads in this file.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createProviderConnectionId,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import { type ReconciliationFlagRepo } from "./reconciliation-flag-repo";
import { type ReconciliationRunHistoryRepo, type ReconciliationRunRow } from "./run-history-repo";
import { type ReconciliationRunner } from "./runner";

/*
 * ----------------------------------------------------------------------------
 * Public response shapes
 * ----------------------------------------------------------------------------
 */

/**
 * Wire shape for a single per-row repair error. Mongo and tRPC serialize
 * `Date` differently across the boundary (tRPC json-serializes to ISO
 * string by default), so we keep `row` opaque (`unknown`) on the wire and
 * let the UI surface it as a JSON-stringified diagnostic detail. Operators
 * mainly care about the count + the error message; the row payload is
 * useful for triage but does not need a typed shape on the client.
 */
export interface ReconciliationPerRowErrorDto {
  row?: unknown;
  error: string;
}

export interface ReconciliationRunRowDto {
  id: string;
  saleorApiUrl: string;
  connectionId: string;
  startedAt: string;
  completedAt: string | null;
  status: ReconciliationRunRow["status"];
  summary: ReconciliationRunRow["summary"];
  perRowErrors: ReconciliationPerRowErrorDto[];
  runError?: string;
}

export type TriggerOnDemandResult =
  | {
      outcome: "ok";
      runId: string;
      summary: ReconciliationRunRow["summary"];
      perRowErrors: ReconciliationPerRowErrorDto[];
      finalStatus: "ok" | "failed";
    }
  | {
      outcome: "already_running";
      activeRunId: string;
    }
  | {
      outcome: "kill_switch_disabled";
    };

export interface ReconciliationFlagDto {
  saleorApiUrl: string;
  reason: string;
  raisedByEventId: string | null;
  raisedAt: string;
  clearedAt: string | null;
}

const toRunRowDto = (row: ReconciliationRunRow): ReconciliationRunRowDto => ({
  id: row.id,
  saleorApiUrl: row.saleorApiUrl as unknown as string,
  connectionId: row.connectionId as unknown as string,
  startedAt: row.startedAt.toISOString(),
  completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  status: row.status,
  summary: row.summary,
  perRowErrors: row.perRowErrors.map((e) => ({ row: e.row, error: e.error })),
  ...(row.runError !== undefined ? { runError: row.runError } : {}),
});

/*
 * ----------------------------------------------------------------------------
 * Input schemas
 * ----------------------------------------------------------------------------
 */

const connectionIdSchema = z.string().uuid("connectionId must be a UUID v4");

const listForConnectionInputSchema = z.object({
  connectionId: connectionIdSchema,
  /** Default 50; capped at 200 by the repo. */
  limit: z.number().int().positive().max(200).optional(),
  /**
   * Cursor for pagination — runs strictly older than this `startedAt`. The
   * repo today implements a hard `limit` only; `before` is forwarded so the
   * UI can build cursor-style "load more" without reshaping the API later.
   */
  before: z.string().datetime().optional(),
});

const triggerOnDemandInputSchema = z.object({
  connectionId: connectionIdSchema,
});

/*
 * ----------------------------------------------------------------------------
 * Router builder
 * ----------------------------------------------------------------------------
 */

export interface ReconciliationRouterDeps {
  runHistoryRepo: ReconciliationRunHistoryRepo;
  flagRepo: ReconciliationFlagRepo;
  runner: Pick<ReconciliationRunner, "runForConnection">;
}

const requireSaleorApiUrl = (raw: string) => {
  const parsed = createSaleorApiUrl(raw);

  if (parsed.isErr()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid saleorApiUrl in request context",
    });
  }

  return parsed.value;
};

const requireConnectionId = (raw: string): ProviderConnectionId => {
  try {
    return createProviderConnectionId(raw);
  } catch (cause) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid connection id: ${(cause as Error).message}`,
    });
  }
};

export const buildReconciliationRouter = (deps: ReconciliationRouterDeps) => {
  const { runHistoryRepo, flagRepo, runner } = deps;

  const runsRouter = router({
    /**
     * Paginated list of reconciliation runs for a single connection.
     * Sorted desc by `startedAt`; default limit 50, capped at 200.
     */
    listForConnection: protectedClientProcedure
      .input(listForConnectionInputSchema)
      .query(async ({ ctx, input }): Promise<ReconciliationRunRowDto[]> => {
        const saleorApiUrl = requireSaleorApiUrl(ctx.saleorApiUrl);
        const connectionId = requireConnectionId(input.connectionId);
        const limit = input.limit ?? 50;

        const result = await runHistoryRepo.listRecent({
          saleorApiUrl,
          connectionId,
          limit,
        });

        if (result.isErr()) {
          ctx.logger.error("reconciliation.runs.listForConnection failed", {
            error: result.error,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to list reconciliation runs",
          });
        }

        /*
         * `before` cursor is forwarded for forward-compat — today the repo
         * doesn't honor it; we filter client-side here so the API surface
         * the UI consumes stays cursor-shaped without forcing a repo
         * migration. When repo gains real cursor support, remove this
         * filter and pass `before` through.
         */
        const filtered =
          input.before === undefined
            ? result.value
            : result.value.filter((row) => row.startedAt < new Date(input.before as string));

        return filtered.map(toRunRowDto);
      }),

    /**
     * Trigger an on-demand reconciliation run for a single connection.
     * Returns the runner's discriminated outcome — `already_running` and
     * `kill_switch_disabled` are deliberate non-error returns so the UI
     * can surface a friendly toast instead of an exception.
     */
    triggerOnDemand: protectedClientProcedure
      .input(triggerOnDemandInputSchema)
      .mutation(async ({ ctx, input }): Promise<TriggerOnDemandResult> => {
        const saleorApiUrl = requireSaleorApiUrl(ctx.saleorApiUrl);
        const connectionId = requireConnectionId(input.connectionId);

        const outcome = await runner.runForConnection({ saleorApiUrl, connectionId });

        switch (outcome.kind) {
          case "ok":
            return {
              outcome: "ok",
              runId: outcome.runId,
              summary: outcome.summary,
              perRowErrors: outcome.perRowErrors.map((e) => ({ row: e.row, error: e.error })),
              finalStatus: outcome.finalStatus,
            };
          case "already_running":
            ctx.logger.info("reconciliation.runs.triggerOnDemand: already running", {
              connectionId: input.connectionId,
              activeRunId: outcome.activeRunId,
            });

            return {
              outcome: "already_running",
              activeRunId: outcome.activeRunId,
            };
          case "kill_switch_disabled":
            ctx.logger.warn("reconciliation.runs.triggerOnDemand: kill switch on", {
              connectionId: input.connectionId,
            });

            return { outcome: "kill_switch_disabled" };
          case "error":
          default:
            ctx.logger.error("reconciliation.runs.triggerOnDemand: runner errored", {
              connectionId: input.connectionId,
              error: outcome.kind === "error" ? outcome.error : "unknown",
            });

            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message:
                outcome.kind === "error"
                  ? `Reconciliation runner failed: ${outcome.error}`
                  : "Reconciliation runner returned an unknown outcome",
            });
        }
      }),
  });

  const flagsRouter = router({
    /**
     * The active reconciliation-recommended flag for the current install,
     * or `null` if none. Cleared flags (`clearedAt !== null`) are treated
     * as inactive to keep the UI banner contract simple.
     */
    getForInstall: protectedClientProcedure.query(
      async ({ ctx }): Promise<ReconciliationFlagDto | null> => {
        const saleorApiUrl = requireSaleorApiUrl(ctx.saleorApiUrl);

        const result = await flagRepo.get({ saleorApiUrl });

        if (result.isErr()) {
          ctx.logger.error("reconciliation.flags.getForInstall failed", {
            error: result.error,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to load reconciliation flags",
          });
        }

        const flag = result.value;

        if (flag === null || flag.clearedAt !== null) {
          return null;
        }

        return {
          saleorApiUrl: flag.saleorApiUrl as unknown as string,
          reason: flag.reason as unknown as string,
          raisedByEventId: flag.raisedByEventId,
          raisedAt: flag.raisedAt.toISOString(),
          clearedAt: flag.clearedAt === null ? null : (flag.clearedAt as Date).toISOString(),
        };
      },
    ),
  });

  return router({
    runs: runsRouter,
    flags: flagsRouter,
  });
};

export type ReconciliationRouter = ReturnType<typeof buildReconciliationRouter>;
