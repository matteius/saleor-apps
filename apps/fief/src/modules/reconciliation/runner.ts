import { isFiefSyncDisabled } from "@/lib/kill-switches";
import { createLogger } from "@/lib/logger";
import { type ProviderConnectionId } from "@/modules/provider-connections/provider-connection";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type DriftDetector, type DriftReportRow } from "./drift-detector";
import { type RepairResult, type RepairUseCase } from "./repair.use-case";
import { type ReconciliationRunHistoryRepo, type ReconciliationRunRow } from "./run-history-repo";

/*
 * T32 — Reconciliation runner.
 *
 * Responsibilities:
 *   1. Honor the FIEF_SYNC kill switch (T54). When the switch is on, return
 *      `{ kind: "kill_switch_disabled" }` immediately — no Mongo work, no
 *      drift walk, no repair dispatch.
 *   2. Per-connection concurrent-run guard. The history repo's `claim(...)`
 *      is the atomic seam: a unique partial Mongo index on
 *      `(saleorApiUrl, connectionId, status: "running")` ensures only one
 *      caller wins. The loser observes `claimed: false` and returns
 *      `{ kind: "already_running" }`. This is load-bearing: without the
 *      guard, a long-running drift walk plus an overlapping cron tick
 *      would pump duplicate writes into Fief and Saleor.
 *   3. Wire `DriftDetector` -> `RepairUseCase`. Drift is a cold async
 *      iterable; repair consumes it row-by-row. Both are invariants of T30
 *      and T31 respectively.
 *   4. Persist run history. On success the row is `status: "ok"` (or
 *      `"failed"` when the repair surfaced any per-row error) with the
 *      summary + perRowErrors. On a top-level throw (drift detector blew
 *      up, repair use case threw outside a per-row context) the row is
 *      `status: "failed"` with a `runError` message.
 *
 * Multi-connection iteration (`runForInstall`) is sequential by design:
 *   - Each connection talks to its own Fief tenant. Parallel runs would
 *     hammer multiple Fief admin APIs from one cron tick, which we
 *     deliberately avoid in v1.
 *   - The Mongo `_id` of the `running` lock is per-connection, so two
 *     different connections inside one install don't actually collide on
 *     the unique index — but the install-level cron is still serial so a
 *     slow connection doesn't starve fast ones with parallel I/O bursts.
 *
 * `now()` is injected so tests are time-deterministic. `listConnections` is
 * injected so the cron route can plug in either a `ProviderConnectionRepo`
 * or a fixture without forcing the runner to know about repo decryption.
 */

const logger = createLogger("modules.reconciliation.ReconciliationRunner");

// ---------- Public types ----------

export type RunOutcome =
  | {
      kind: "ok";
      connectionId: ProviderConnectionId;
      runId: string;
      summary: ReconciliationRunRow["summary"];
      perRowErrors: ReconciliationRunRow["perRowErrors"];
      finalStatus: "ok" | "failed";
    }
  | {
      kind: "already_running";
      connectionId: ProviderConnectionId;
      /** The id of the in-flight run (so the UI can correlate). */
      activeRunId: string;
    }
  | {
      kind: "kill_switch_disabled";
      connectionId: ProviderConnectionId;
    }
  | {
      kind: "error";
      connectionId: ProviderConnectionId;
      error: string;
    };

export interface RunForConnectionInput {
  saleorApiUrl: SaleorApiUrl;
  connectionId: ProviderConnectionId;
}

export interface RunForInstallInput {
  saleorApiUrl: SaleorApiUrl;
}

export interface ConnectionListEntry {
  id: ProviderConnectionId;
  saleorApiUrl: SaleorApiUrl;
}

export interface ReconciliationRunnerDeps {
  driftDetector: Pick<DriftDetector, "detect">;
  repairUseCase: Pick<RepairUseCase, "repair">;
  runHistoryRepo: ReconciliationRunHistoryRepo;
  /**
   * Lists the connections under an install. The cron route plugs in a
   * Mongo-backed `ProviderConnectionRepo.list(...)` mapped to this shape.
   * The default is a no-op so unit tests of `runForConnection` don't have
   * to wire a repo they never call.
   */
  listConnections?: (input: { saleorApiUrl: SaleorApiUrl }) => Promise<ConnectionListEntry[]>;
  /** Test seam for `Date.now()`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

// ---------- Implementation ----------

export class ReconciliationRunner {
  private readonly deps: ReconciliationRunnerDeps;
  private readonly now: () => Date;

  constructor(deps: ReconciliationRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async runForConnection(input: RunForConnectionInput): Promise<RunOutcome> {
    const { saleorApiUrl, connectionId } = input;

    if (isFiefSyncDisabled()) {
      logger.warn("Skipping reconciliation: FIEF_SYNC kill switch is on", {
        saleorApiUrl,
        connectionId,
      });

      return { kind: "kill_switch_disabled", connectionId };
    }

    const startedAt = this.now();
    const claim = await this.deps.runHistoryRepo.claim({
      saleorApiUrl,
      connectionId,
      startedAt,
    });

    if (claim.isErr()) {
      logger.error("Reconciliation claim failed", {
        saleorApiUrl,
        connectionId,
        errorBrand: claim.error._brand,
        errorMessage: claim.error.message,
      });

      return {
        kind: "error",
        connectionId,
        error: claim.error.message,
      };
    }

    const claimResult = claim.value;

    if (!claimResult.claimed) {
      logger.info("Reconciliation already running for connection; skipping", {
        saleorApiUrl,
        connectionId,
        activeRunId: claimResult.row.id,
      });

      return {
        kind: "already_running",
        connectionId,
        activeRunId: claimResult.row.id,
      };
    }

    const runId = claimResult.row.id;

    /*
     * Run the drift -> repair pipeline. We catch top-level throws here so the
     * `complete(...)` write happens even when the pipeline blows up — without
     * that, a `running` row would be stranded forever and the next cron tick
     * would observe `claimed: false` indefinitely.
     */
    let repairResult: RepairResult;
    let runError: string | undefined;

    try {
      const drift: AsyncIterable<DriftReportRow> = this.deps.driftDetector.detect({
        saleorApiUrl,
        connectionId,
      });

      repairResult = await this.deps.repairUseCase.repair({
        saleorApiUrl,
        drift,
      });
    } catch (cause) {
      runError = cause instanceof Error ? cause.message : String(cause);
      repairResult = {
        summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
        perRowErrors: [],
      };
      logger.error("Reconciliation pipeline threw", {
        saleorApiUrl,
        connectionId,
        runId,
        errorMessage: runError,
      });
    }

    const finalStatus: "ok" | "failed" =
      runError !== undefined || repairResult.summary.failed > 0 ? "failed" : "ok";

    const completedAt = this.now();
    const completion = await this.deps.runHistoryRepo.complete({
      id: runId,
      status: finalStatus,
      completedAt,
      summary: repairResult.summary,
      perRowErrors: repairResult.perRowErrors,
      runError,
    });

    if (completion.isErr()) {
      logger.error("Reconciliation complete write failed", {
        saleorApiUrl,
        connectionId,
        runId,
        errorMessage: completion.error.message,
      });

      return {
        kind: "error",
        connectionId,
        error: completion.error.message,
      };
    }

    logger.info("Reconciliation run complete", {
      saleorApiUrl,
      connectionId,
      runId,
      finalStatus,
      total: repairResult.summary.total,
      repaired: repairResult.summary.repaired,
      skipped: repairResult.summary.skipped,
      failed: repairResult.summary.failed,
    });

    return {
      kind: "ok",
      connectionId,
      runId,
      summary: repairResult.summary,
      perRowErrors: repairResult.perRowErrors,
      finalStatus,
    };
  }

  /**
   * Run reconciliation for every active connection under an install,
   * sequentially. Returns one `RunOutcome` per connection. A failure on
   * connection N does NOT abort the run for connection N+1 — each
   * connection's outcome is captured independently so partial progress is
   * still committed.
   */
  async runForInstall(input: RunForInstallInput): Promise<RunOutcome[]> {
    const { saleorApiUrl } = input;

    if (this.deps.listConnections === undefined) {
      logger.error("runForInstall called without a listConnections dep", { saleorApiUrl });

      return [];
    }

    const connections = await this.deps.listConnections({ saleorApiUrl });
    const outcomes: RunOutcome[] = [];

    for (const conn of connections) {
      const outcome = await this.runForConnection({
        saleorApiUrl,
        connectionId: conn.id,
      });

      outcomes.push(outcome);
    }

    return outcomes;
  }
}
