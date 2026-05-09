import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type DecryptedProviderConnectionSecrets,
  type ProviderConnection,
  type ProviderConnectionCreateInput,
  type ProviderConnectionId,
  type ProviderConnectionUpdateInput,
} from "./provider-connection";

/*
 * T8 — `ProviderConnectionRepo` interface.
 *
 * The repo is the single boundary through which the rest of the app reads /
 * writes `ProviderConnection` documents. Two non-obvious contracts:
 *
 *   1. **Encryption is invisible to the caller.** Inputs carry plaintext
 *      secrets; the repo encrypts via T4's `RotatingFiefEncryptor` before
 *      persisting. Reads return the encrypted shape (the brand keeps callers
 *      from accidentally treating ciphertext as plaintext); use
 *      `getDecryptedSecrets()` when plaintext is genuinely required (T17 / T19
 *      / T20). This narrows the blast radius of an accidental log dump.
 *
 *   2. **Soft-delete is the default deletion path.** `softDelete()` flips
 *      `softDeletedAt`; `list()` excludes soft-deleted entries unless
 *      `includeSoftDeleted: true` is passed. T29 (subscription lifecycle)
 *      uses this so deactivation is reversible and audit-traceable.
 *
 * Result-typed errors mirror the rest of the Fief codebase (`neverthrow`
 * convention): callers handle failure modes explicitly without catching
 * exceptions across module boundaries.
 */

// -- Errors -------------------------------------------------------------------

export const ProviderConnectionRepoError = {
  NotFound: BaseError.subclass("ProviderConnectionNotFoundError", {
    props: { _brand: "FiefApp.ProviderConnectionRepo.NotFound" as const },
  }),
  FailureFetching: BaseError.subclass("ProviderConnectionFailureFetchingError", {
    props: { _brand: "FiefApp.ProviderConnectionRepo.FailureFetching" as const },
  }),
  FailureSaving: BaseError.subclass("ProviderConnectionFailureSavingError", {
    props: { _brand: "FiefApp.ProviderConnectionRepo.FailureSaving" as const },
  }),
  FailureDeleting: BaseError.subclass("ProviderConnectionFailureDeletingError", {
    props: { _brand: "FiefApp.ProviderConnectionRepo.FailureDeleting" as const },
  }),
  FailureDecrypting: BaseError.subclass("ProviderConnectionFailureDecryptingError", {
    props: { _brand: "FiefApp.ProviderConnectionRepo.FailureDecrypting" as const },
  }),
};

export type ProviderConnectionRepoError =
  | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
  | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
  | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
  | InstanceType<(typeof ProviderConnectionRepoError)["FailureDeleting"]>
  | InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>;

// -- Access patterns ----------------------------------------------------------

/** Query params for `get()`. Always scoped by `saleorApiUrl` for tenant safety. */
export interface GetProviderConnectionAccess {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
  /** When `true`, soft-deleted connections are also returned. Default `false`. */
  includeSoftDeleted?: boolean;
}

/** Query params for `list()`. */
export interface ListProviderConnectionsAccess {
  saleorApiUrl: SaleorApiUrl;
  /** When `true`, soft-deleted connections are included in the result. Default `false`. */
  includeSoftDeleted?: boolean;
}

// -- Interface ----------------------------------------------------------------

export interface ProviderConnectionRepo {
  /**
   * Insert a new connection. Generates a new `ProviderConnectionId` (UUID v4),
   * encrypts all secret slots, and persists. Returns the freshly-stored entity
   * (with brand-typed encrypted slots).
   */
  create(
    saleorApiUrl: SaleorApiUrl,
    input: ProviderConnectionCreateInput,
  ): Promise<
    Result<ProviderConnection, InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>>
  >;

  /**
   * Read a single connection by id. Returns `NotFound` if the doc doesn't
   * exist or is soft-deleted (unless `includeSoftDeleted: true`).
   */
  get(
    access: GetProviderConnectionAccess,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  >;

  /**
   * List connections for an install. Excludes soft-deleted entries by default.
   */
  list(
    access: ListProviderConnectionsAccess,
  ): Promise<
    Result<
      ProviderConnection[],
      InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  >;

  /**
   * Patch the named fields. Re-encrypts only the secret slots present in the
   * patch; other secrets are left untouched (avoids the "fetch → mutate →
   * write" foot-gun where a stale plaintext gets re-encrypted under a new
   * key version).
   */
  update(
    access: { saleorApiUrl: SaleorApiUrl; id: ProviderConnectionId },
    patch: ProviderConnectionUpdateInput,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  >;

  /**
   * Soft-delete: flips `softDeletedAt` to `new Date()`. Does NOT remove the
   * row. Subsequent `list()` calls (without `includeSoftDeleted`) will skip
   * this row.
   */
  softDelete(access: {
    saleorApiUrl: SaleorApiUrl;
    id: ProviderConnectionId;
  }): Promise<
    Result<
      void,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDeleting"]>
    >
  >;

  /**
   * Reverse a soft-delete by clearing `softDeletedAt`. Used by T29's
   * "reactivate" path.
   */
  restore(access: {
    saleorApiUrl: SaleorApiUrl;
    id: ProviderConnectionId;
  }): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  >;

  /**
   * Decrypt all secret slots for a connection. Returned shape mirrors the
   * encrypted layout but with plaintext strings. Used by T17 (rotation) and
   * T19/T20 (Saleor token issuance) — anywhere plaintext is genuinely
   * required.
   *
   * Implementations MUST NOT log the returned plaintext.
   */
  getDecryptedSecrets(
    access: GetProviderConnectionAccess,
  ): Promise<
    Result<
      DecryptedProviderConnectionSecrets,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>
    >
  >;
}
