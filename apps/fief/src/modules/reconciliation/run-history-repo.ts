import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type ProviderConnectionId } from "@/modules/provider-connections/provider-connection";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type RepairPerRowError, type RepairSummary } from "./repair.use-case";

/*
 * T32 — Reconciliation run-history repo.
 *
 * Persists one document per `ReconciliationRunner.runForConnection(...)`
 * invocation. Two access patterns motivate the schema:
 *
 *   1. Per-connection concurrent-run guard — `claim(...)` is the atomic
 *      "find-or-create-running-row" primitive: if a row with `status = "running"`
 *      already exists for `(saleorApiUrl, connectionId)`, the second caller
 *      observes `claimed: false` and returns "already running" without ever
 *      starting drift detection. The mongo impl uses `findOneAndUpdate` with an
 *      upsert + a unique partial index on `{ saleorApiUrl, connectionId,
 *      status: "running" }` so the operation is atomic across replicas.
 *
 *   2. T38 (UI) reads recent runs to render a status panel. `listRecent(...)`
 *      returns the N most-recent rows for an install, ordered by `startedAt`
 *      desc. The UI surfaces `status`, `summary`, and `perRowErrors[]`.
 *
 * The schema is deliberately flat — drift kinds are aggregated into the
 * RepairSummary counts so the UI can show "X repaired / Y failed" without
 * hitting the drift detector again.
 */

export const ReconciliationRunHistoryRepoError = BaseError.subclass(
  "ReconciliationRunHistoryRepoError",
  {
    props: {
      _brand: "FiefApp.ReconciliationRunHistoryRepoError" as const,
    },
  },
);

export type ReconciliationRunStatus = "running" | "ok" | "failed";

export interface ReconciliationRunRow {
  /** UUID v4. */
  id: string;
  saleorApiUrl: SaleorApiUrl;
  connectionId: ProviderConnectionId;
  startedAt: Date;
  /** Null while `status === "running"`. */
  completedAt: Date | null;
  status: ReconciliationRunStatus;
  /**
   * Aggregated `RepairSummary` from the drift→repair pipeline. Initialized
   * to all-zero on `claim()` and rewritten on `complete()`.
   */
  summary: RepairSummary;
  /**
   * Per-row error trail surfaced by `RepairUseCase`. Empty by default.
   */
  perRowErrors: RepairPerRowError[];
  /**
   * Optional top-level run-failure message (e.g. "drift-detector threw").
   * Populated when `status === "failed"`.
   */
  runError?: string;
}

export interface ClaimResult {
  /**
   * `true` when this caller wins the lock and gets a fresh row to write into.
   * `false` when another runner is already in flight for this
   * `(saleorApiUrl, connectionId)`.
   */
  claimed: boolean;
  /**
   * The active "running" row for this `(saleorApiUrl, connectionId)`. When
   * `claimed: true`, this is the row this caller owns. When `claimed: false`,
   * this is the row that's already running (consumed by the UI to show the
   * concurrent caller "another run is in flight").
   */
  row: ReconciliationRunRow;
}

export interface CompleteInput {
  id: string;
  status: Exclude<ReconciliationRunStatus, "running">;
  completedAt: Date;
  summary: RepairSummary;
  perRowErrors: RepairPerRowError[];
  runError?: string;
}

export interface ListRecentInput {
  saleorApiUrl: SaleorApiUrl;
  /** Default 50; capped at 200 to bound memory. */
  limit?: number;
  /** Optional connection filter — when supplied, only that connection's rows. */
  connectionId?: ProviderConnectionId;
}

export interface ReconciliationRunHistoryRepo {
  /**
   * Atomically obtain (or fail to obtain) a "running" row for
   * `(saleorApiUrl, connectionId)`. The returned row's `status` is always
   * `"running"` — callers update via `complete(...)` when the run finishes.
   */
  claim(input: {
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
    startedAt: Date;
  }): Promise<Result<ClaimResult, InstanceType<typeof ReconciliationRunHistoryRepoError>>>;

  /**
   * Mark a previously-claimed row as `"ok"` or `"failed"`, writing the
   * summary + per-row errors. Idempotent on `id`: a second call with the
   * same `id` rewrites the row (used by the integration test to verify the
   * happy path AND the fail path produce a single terminal row).
   */
  complete(
    input: CompleteInput,
  ): Promise<Result<ReconciliationRunRow, InstanceType<typeof ReconciliationRunHistoryRepoError>>>;

  /**
   * Recent runs across all connections for an install (or filtered by
   * `connectionId`). Ordered by `startedAt` desc.
   */
  listRecent(
    input: ListRecentInput,
  ): Promise<
    Result<ReconciliationRunRow[], InstanceType<typeof ReconciliationRunHistoryRepoError>>
  >;
}
