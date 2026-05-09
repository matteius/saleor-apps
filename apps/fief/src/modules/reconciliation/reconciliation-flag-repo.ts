// cspell:ignore opensensor

import { type Result } from "neverthrow";

import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type RaiseReconciliationFlagInput,
  type ReconciliationFlagError,
  type ReconciliationFlagRow,
} from "./reconciliation-flag";

/*
 * T25 — `reconciliation_flags` repository contract.
 *
 * Single-document-per-`saleorApiUrl` semantics: `raise(...)` is an upsert
 * (idempotent across repeated webhook deliveries) — re-raising the same
 * flag updates `raisedAt` + `reason` and clears any prior `clearedAt`.
 *
 * The Mongo impl lives in `repositories/mongodb/` (deferred to the wiring
 * layer / a follow-up task; this PR ships the interface + an in-memory
 * impl exercised in the use-case tests). T38 reads via `get(...)` to
 * surface the banner; an `ack(...)` operator action sets `clearedAt`.
 */

export interface ReconciliationFlagRepo {
  /**
   * Raise (or refresh) the reconciliation-recommended flag for a given
   * `saleorApiUrl`. Idempotent — re-raising overwrites `raisedAt` and
   * resets `clearedAt` to `null`.
   */
  raise(
    input: RaiseReconciliationFlagInput,
  ): Promise<Result<ReconciliationFlagRow, ReconciliationFlagError>>;

  /**
   * Read the current flag (or `null` if never raised). T38's UI uses this
   * to decide whether to show the banner.
   */
  get(input: {
    saleorApiUrl: SaleorApiUrl;
  }): Promise<Result<ReconciliationFlagRow | null, ReconciliationFlagError>>;
}
