import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import {
  type FiefUserId,
  type IdentityMapRow,
  type SaleorApiUrl,
  type SaleorUserId,
  type SyncSeq,
} from "./identity-map";

/*
 * T10 — `identity_map` repository contract.
 *
 * Modeled on the Avatax / Stripe repository patterns. Returns `Result<T, E>`
 * uniformly so call sites compose with `neverthrow` chains. The Mongo impl
 * lives in `repositories/mongodb/`; the contract is implementation-agnostic
 * so a future test-double or in-memory impl can be swapped in.
 *
 * The critical operation is `upsert`. See `identity-map.ts` for the race
 * semantics — `wasInserted` tells the caller whether they're the "winner"
 * of a concurrent first-login race or the "loser" who should reuse the
 * existing binding.
 */

export const IdentityMapRepoError = BaseError.subclass("IdentityMapRepoError", {
  props: {
    _brand: "IdentityMap.RepoError" as const,
  },
});

export interface UpsertIdentityMapInput {
  saleorApiUrl: SaleorApiUrl;
  saleorUserId: SaleorUserId;
  fiefUserId: FiefUserId;
  syncSeq: SyncSeq;
}

export interface UpsertIdentityMapResult {
  /**
   * The post-upsert row as Mongo sees it. If `wasInserted` is `false`, the
   * row reflects the previously-bound state — the caller's `saleorUserId`
   * may NOT match `row.saleorUserId` (the loser of a race sees the
   * winner's binding).
   */
  row: IdentityMapRow;
  /**
   * `true` when this call was the one that actually wrote the row (the
   * "winner" of any concurrent race). `false` when an existing row was
   * found and returned. Callers MUST branch on this:
   *
   *   - `true`  → safe to provision side-effects (Saleor customer create
   *               in T19, Fief user create in T26) tied to the binding.
   *   - `false` → another caller already provisioned; re-use the bound
   *               `row.saleorUserId` and skip provisioning.
   *
   * Also returns `false` when an upsert with an OLDER syncSeq lands on an
   * existing newer row (the no-regression path) — semantically the same
   * outcome: this caller did not establish the binding.
   */
  wasInserted: boolean;
}

export interface GetBySaleorUserInput {
  saleorApiUrl: SaleorApiUrl;
  saleorUserId: SaleorUserId;
}

export interface GetByFiefUserInput {
  saleorApiUrl: SaleorApiUrl;
  fiefUserId: FiefUserId;
}

export interface DeleteInput {
  saleorApiUrl: SaleorApiUrl;
  saleorUserId: SaleorUserId;
}

export interface IdentityMapRepo {
  /**
   * Look up an identity-map row by Saleor customer id within a Saleor
   * instance. Returns `null` (wrapped in `Ok`) on miss; `IdentityMapRepoError`
   * on storage failure.
   */
  getBySaleorUser(
    input: GetBySaleorUserInput,
  ): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>>;

  /**
   * Look up an identity-map row by Fief user id within a Saleor instance.
   * Returns `null` (wrapped in `Ok`) on miss; `IdentityMapRepoError` on
   * storage failure.
   */
  getByFiefUser(
    input: GetByFiefUserInput,
  ): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>>;

  /**
   * Atomic "insert-if-absent, return existing-or-new" upsert. THE
   * synchronization point for the auth-plane race (T19/T23). See
   * `UpsertIdentityMapResult.wasInserted` for the race-resolution contract.
   *
   * Monotonic seq: if the input `syncSeq` is `<=` the existing row's
   * `lastSyncSeq`, the row is NOT modified — the caller receives the
   * existing row with `wasInserted: false` and the original (higher)
   * `lastSyncSeq` intact. This makes the storage layer safe under
   * out-of-order webhook delivery.
   */
  upsert(
    input: UpsertIdentityMapInput,
  ): Promise<Result<UpsertIdentityMapResult, InstanceType<typeof IdentityMapRepoError>>>;

  /**
   * Delete the binding. Idempotent — deleting a non-existent row succeeds
   * with `Ok`. Used by Fief `UserDeleted` (T24) — note T24 may opt to leave
   * the row in place for audit; that's the use-case-layer decision.
   */
  delete(input: DeleteInput): Promise<Result<void, InstanceType<typeof IdentityMapRepoError>>>;
}
