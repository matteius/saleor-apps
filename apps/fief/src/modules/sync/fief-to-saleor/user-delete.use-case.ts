// cspell:ignore opensensor chargeback retriable

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import {
  createSyncSeq,
  type FiefUserId,
  FiefUserIdSchema,
  type SaleorApiUrl,
  type SaleorUserId,
  type SyncSeq,
} from "@/modules/identity-map/identity-map";
import {
  type IdentityMapRepo,
  IdentityMapRepoError,
} from "@/modules/identity-map/identity-map-repo";
import {
  FIEF_SYNC_ORIGIN_KEY,
  FIEF_SYNC_SEQ_KEY,
  shouldSkip,
  type SyncOrigin,
  tagWrite,
} from "@/modules/sync/loop-guard";

import { type WebhookEventPayload } from "./event-router";

/*
 * T24 — Fief→Saleor `user.deleted` use case.
 *
 * Per PRD §F2.5: when Fief tells us a user has been deleted we MUST NOT
 * hard-delete the Saleor customer (that would cascade-delete order rows
 * and tank our reporting / refund / chargeback workflows). Instead we:
 *
 *   1. Verify loop-guard (T13) BEFORE any side effect — drop incoming
 *      events whose origin marker says they originated from the side we
 *      are about to write into ("saleor"). This is the canary against
 *      infinite Fief↔Saleor loops, mirrors T23.
 *
 *   2. Look up the identity_map row by `(saleorApiUrl, fiefUserId)`. If
 *      no row exists → log + return ok (idempotent). The receiver records
 *      this as `dispatched` and Fief won't retry. This handles the case
 *      where Fief deletes a user that was never propagated to Saleor (e.g.
 *      a Fief-side admin tools cleanup of stub records that never logged
 *      into the storefront).
 *
 *   3. Set `customerUpdate(input: { isActive: false })` via T7's
 *      `FiefCustomerUpdate` mutation. This preserves orders + addresses
 *      (Saleor Customer.delete is what drops those).
 *
 *   4. Wipe the public claim-mapping keys by setting each to "" via T7's
 *      `FiefUpdateMetadata` mutation. Saleor has no `deleteMetadata`
 *      mutation, so empty-string is the operator-visible deletion. The
 *      origin marker `"fief"` rides on the same write so the loop guard
 *      drops the echo at T26-T29.
 *
 *   5. **Leave private metadata + identity_map row INTACT for audit.**
 *      Operators investigating refund disputes need to be able to map
 *      a Saleor order back to the Fief user that placed it, even after
 *      the Fief account is gone.
 *
 * Saleor write surface: this use case needs `customerUpdate` (for
 * `isActive: false`) and `updateMetadata` (for the public bucket wipe +
 * marker). It does NOT need `customerCreate` or `updatePrivateMetadata`
 * — those operations would violate the "preserve audit trail" contract.
 * The narrow `SaleorCustomerDeactivateClient` interface enforces that.
 *
 * Connection context: as with T23 the wiring layer (`register-handlers.ts`)
 * resolves the `(saleorApiUrl, claimMapping)` pair from the Fief
 * `data.tenant_id` and passes them in. The `claimMapping` is needed to
 * know which public metadata keys to wipe — operators can configure
 * different mappings per connection so the use case can't hard-code the
 * key list.
 */

// -- Errors -------------------------------------------------------------------

export const UserDeleteUseCaseError = {
  /**
   * The webhook `data` did not match the `UserRead` schema (missing
   * `id` / etc.). The receiver has already accepted the body, so this
   * is a Fief-side schema drift or a non-user event landing on the
   * user-delete handler.
   */
  InvalidPayload: BaseError.subclass("UserDeleteInvalidPayloadError", {
    props: { _brand: "FiefApp.UserDelete.InvalidPayload" as const },
  }),
  /**
   * `IdentityMapRepo.getByFiefUser(...)` returned err. Retriable —
   * T22's receiver records the failure as `accepted-with-handler-error`
   * and the queue (T52) backs off.
   */
  IdentityMapReadFailed: BaseError.subclass("UserDeleteIdentityMapReadFailedError", {
    props: { _brand: "FiefApp.UserDelete.IdentityMapReadFailed" as const },
  }),
  /**
   * Saleor's `customerUpdate` mutation (the deactivation) failed.
   * Retriable.
   */
  SaleorCustomerUpdateFailed: BaseError.subclass("UserDeleteSaleorCustomerUpdateFailedError", {
    props: { _brand: "FiefApp.UserDelete.SaleorCustomerUpdateFailed" as const },
  }),
  /**
   * `FiefUpdateMetadata` mutation (the public-claim wipe + origin marker)
   * failed. Retriable. Note we run customer-deactivation BEFORE the
   * metadata wipe, so a partial failure leaves the customer deactivated
   * with stale metadata — acceptable because the next event or
   * reconciliation (T30) re-converges, and the deactivation itself is
   * the load-bearing part of the contract.
   */
  SaleorMetadataWriteFailed: BaseError.subclass("UserDeleteSaleorMetadataWriteFailedError", {
    props: { _brand: "FiefApp.UserDelete.SaleorMetadataWriteFailed" as const },
  }),
};

export type UserDeleteUseCaseError =
  | InstanceType<(typeof UserDeleteUseCaseError)["InvalidPayload"]>
  | InstanceType<(typeof UserDeleteUseCaseError)["IdentityMapReadFailed"]>
  | InstanceType<(typeof UserDeleteUseCaseError)["SaleorCustomerUpdateFailed"]>
  | InstanceType<(typeof UserDeleteUseCaseError)["SaleorMetadataWriteFailed"]>;

export type SaleorCustomerDeactivateError =
  | InstanceType<(typeof UserDeleteUseCaseError)["SaleorCustomerUpdateFailed"]>
  | InstanceType<(typeof UserDeleteUseCaseError)["SaleorMetadataWriteFailed"]>;

// -- Saleor write surface (intentionally narrow) ------------------------------

/**
 * Narrow Saleor write surface for the deactivation use case. Production
 * wiring binds `customerUpdate` to T7's `FiefCustomerUpdateDocument` and
 * `updateMetadata` to T7's `FiefUpdateMetadataDocument`. Tests inject a
 * fake.
 *
 * Two methods only — `customerUpdate` for the `isActive: false` flip and
 * `updateMetadata` for the public-claim wipe + origin marker. We do NOT
 * expose `customerDelete` here on purpose: T24's contract is
 * deactivate-not-delete, and giving the use case a delete primitive
 * would be a foot-gun.
 */
export interface SaleorCustomerDeactivateClient {
  customerUpdate(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    isActive: boolean;
  }): Promise<Result<void, SaleorCustomerDeactivateError>>;

  updateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, SaleorCustomerDeactivateError>>;
}

// -- Payload schema -----------------------------------------------------------

/*
 * Validated subset of `UserRead` (per `opensensor-fief/fief/schemas/user.py`).
 * We only require `id` here — `email` / `is_active` etc. aren't needed
 * for the deactivation path. `fields` is consumed for the loop-guard
 * marker extraction.
 */
const FiefUserDeletedDataSchema = z
  .object({
    id: z.string().uuid({ message: "data.id must be a UUID" }),
    tenant_id: z.string().optional(),
    fields: z.record(z.unknown()).optional().default({}),
  })
  .passthrough();

type FiefUserDeletedData = z.infer<typeof FiefUserDeletedDataSchema>;

// -- Outcome ------------------------------------------------------------------

export type UserDeleteOutcome =
  | {
      kind: "skipped-by-loop-guard";
      reason: "origin-matches-processing-side" | "stale-seq";
    }
  | {
      kind: "noop-no-binding";
      fiefUserId: FiefUserId;
    }
  | {
      kind: "deactivated";
      saleorUserId: SaleorUserId;
      writtenSeq: SyncSeq;
    };

// -- Use case -----------------------------------------------------------------

export interface UserDeleteUseCaseDeps {
  identityMapRepo: IdentityMapRepo;
  saleorClient: SaleorCustomerDeactivateClient;
}

export interface ExecuteInput {
  saleorApiUrl: SaleorApiUrl;
  /**
   * The connection's claim mapping — used to determine which public
   * metadata keys to wipe. Same shape as T23.
   */
  claimMapping: readonly ClaimMappingProjectionEntry[];
  payload: WebhookEventPayload;
}

const PROCESSING_SIDE: SyncOrigin = "saleor"; // we are writing INTO Saleor

const logger = createLogger("modules.sync.fief-to-saleor.UserDeleteUseCase");

export class UserDeleteUseCase {
  private readonly identityMapRepo: IdentityMapRepo;
  private readonly saleorClient: SaleorCustomerDeactivateClient;

  constructor(deps: UserDeleteUseCaseDeps) {
    this.identityMapRepo = deps.identityMapRepo;
    this.saleorClient = deps.saleorClient;
  }

  async execute(input: ExecuteInput): Promise<Result<UserDeleteOutcome, UserDeleteUseCaseError>> {
    /*
     * Step 1 — validate the Fief webhook payload.
     */
    const dataResult = parseFiefUserDeletedData(input.payload);

    if (dataResult.isErr()) {
      logger.warn("Fief user.deleted payload failed validation", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        error: dataResult.error.message,
      });

      return err(dataResult.error);
    }

    const userData = dataResult.value;
    const fiefUserId = userData.id as unknown as FiefUserId;

    /*
     * Step 2 — extract loop-guard markers from `fields`. Saleor→Fief
     * writers (T29 in particular for delete) stash origin + seq there
     * via `tagWrite(...)`.
     */
    const incomingMarker = extractMarkerFromFiefFields(userData.fields ?? {});

    const existingRowResult = await this.identityMapRepo.getByFiefUser({
      saleorApiUrl: input.saleorApiUrl,
      fiefUserId,
    });

    if (existingRowResult.isErr()) {
      logger.error("identity_map getByFiefUser failed; surfacing as IdentityMapReadFailed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        error: existingRowResult.error,
      });

      return err(
        new UserDeleteUseCaseError.IdentityMapReadFailed("getByFiefUser failed", {
          cause: existingRowResult.error,
        }),
      );
    }

    const existingRow = existingRowResult.value;
    const lastSeenSeq = existingRow
      ? createSyncSeq(existingRow.lastSyncSeq).unwrapOr(unsafeMinimumSeq())
      : unsafeMinimumSeq();

    if (
      shouldSkip({
        incomingMarker,
        processingSide: PROCESSING_SIDE,
        lastSeenSeq,
      })
    ) {
      const reason: "origin-matches-processing-side" | "stale-seq" =
        incomingMarker.origin === PROCESSING_SIDE ? "origin-matches-processing-side" : "stale-seq";

      logger.info("Fief→Saleor user-delete skipped by loop guard", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        fiefUserId,
        reason,
      });

      return ok({ kind: "skipped-by-loop-guard", reason });
    }

    /*
     * Step 3 — idempotent no-op when no binding exists. The receiver
     * still records this as a successful dispatch so Fief stops
     * retrying. Common path: Fief deletes a stub user that never logged
     * into the storefront, so we never created a Saleor customer for it.
     */
    if (!existingRow) {
      logger.info("Fief user.deleted but no identity_map row — idempotent no-op", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        fiefUserId,
      });

      return ok({ kind: "noop-no-binding", fiefUserId });
    }

    const saleorUserId = existingRow.saleorUserId;

    /*
     * Step 4 — bump seq for the deactivation write. Same monotonicity
     * contract as T23: strictly greater than what we observed.
     */
    const newSeqResult = createSyncSeq(lastSeenSeq + 1);

    if (newSeqResult.isErr()) {
      // Should be unreachable — `lastSeenSeq + 1` is always a non-negative integer.
      return err(
        new UserDeleteUseCaseError.SaleorCustomerUpdateFailed(
          "Failed to construct bumped SyncSeq",
          {
            cause: newSeqResult.error,
          },
        ),
      );
    }

    const writtenSeq = newSeqResult.value;

    /*
     * Step 5 — deactivate the customer. Run BEFORE the metadata wipe so
     * even if the metadata mutation fails the customer is no longer
     * authentication-eligible (the load-bearing half of F2.5).
     */
    const updateResult = await this.saleorClient.customerUpdate({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      isActive: false,
    });

    if (updateResult.isErr()) {
      logger.error("Saleor customerUpdate (deactivate) failed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        saleorUserId,
        error: updateResult.error,
      });

      return err(updateResult.error);
    }

    /*
     * Step 6 — wipe the public claim metadata keys (set each to "")
     * AND attach the origin marker. The origin marker MUST land on this
     * write so T26-T29 (Saleor→Fief) can drop the echo when Saleor's
     * own webhook fires for the metadata change.
     *
     * We deliberately wipe ONLY the public-visibility entries from the
     * claim mapping. Private metadata stays for audit (F2.5).
     */
    const publicWipe = buildPublicWipeItems(input.claimMapping);
    const tag = tagWrite(PROCESSING_SIDE === "saleor" ? "fief" : "saleor", writtenSeq);

    const items = mergeWipeWithMarker(publicWipe, tag.metadata);

    const metadataResult = await this.saleorClient.updateMetadata({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      items,
    });

    if (metadataResult.isErr()) {
      logger.error("Saleor updateMetadata (claim wipe + marker) failed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        saleorUserId,
        error: metadataResult.error,
      });

      return err(metadataResult.error);
    }

    logger.info("Fief→Saleor user-delete (deactivate) completed", {
      eventType: input.payload.type,
      eventId: input.payload.eventId,
      fiefUserId,
      saleorUserId,
      writtenSeq,
    });

    return ok({ kind: "deactivated", saleorUserId, writtenSeq });
  }
}

// -- helpers ------------------------------------------------------------------

const parseFiefUserDeletedData = (
  payload: WebhookEventPayload,
): Result<FiefUserDeletedData, InstanceType<(typeof UserDeleteUseCaseError)["InvalidPayload"]>> => {
  const parsed = FiefUserDeletedDataSchema.safeParse(payload.data);

  if (!parsed.success) {
    return err(
      new UserDeleteUseCaseError.InvalidPayload(
        `Invalid Fief user.deleted event payload: ${parsed.error.message}`,
        { cause: parsed.error },
      ),
    );
  }

  /*
   * Defense-in-depth: brand-check the user id with FiefUserIdSchema.
   */
  const branded = FiefUserIdSchema.safeParse(parsed.data.id);

  if (!branded.success) {
    return err(
      new UserDeleteUseCaseError.InvalidPayload(
        `data.id is not a valid Fief user id: ${branded.error.message}`,
      ),
    );
  }

  return ok(parsed.data);
};

const extractMarkerFromFiefFields = (
  fields: Record<string, unknown>,
): { origin?: SyncOrigin; seq?: SyncSeq } => {
  const rawOrigin = fields[FIEF_SYNC_ORIGIN_KEY];
  const rawSeq = fields[FIEF_SYNC_SEQ_KEY];

  let origin: SyncOrigin | undefined;

  if (rawOrigin === "fief" || rawOrigin === "saleor") {
    origin = rawOrigin;
  }

  let seq: SyncSeq | undefined;

  if (typeof rawSeq === "string") {
    const parsed = Number.parseInt(rawSeq, 10);

    if (!Number.isNaN(parsed)) {
      const branded = createSyncSeq(parsed);

      if (branded.isOk()) {
        seq = branded.value;
      }
    }
  } else if (typeof rawSeq === "number" && Number.isFinite(rawSeq)) {
    const branded = createSyncSeq(rawSeq);

    if (branded.isOk()) {
      seq = branded.value;
    }
  }

  return { origin, seq };
};

/**
 * Build the `{key, value: ""}` items for every PUBLIC claim-mapping entry.
 * Private-visibility entries are NOT included — F2.5 says private
 * metadata stays for audit.
 */
const buildPublicWipeItems = (
  mapping: readonly ClaimMappingProjectionEntry[],
): Array<{ key: string; value: string }> => {
  const items: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();

  for (const entry of mapping) {
    if (entry.visibility !== "public") {
      continue;
    }

    if (seen.has(entry.saleorMetadataKey)) {
      continue;
    }
    seen.add(entry.saleorMetadataKey);
    items.push({ key: entry.saleorMetadataKey, value: "" });
  }

  return items;
};

/**
 * Merge the public-claim wipe items with the origin-marker entries so
 * a single `updateMetadata` call carries both. The marker keys win on
 * conflict — the loop guard MUST be authoritative.
 */
const mergeWipeWithMarker = (
  wipeItems: ReadonlyArray<{ key: string; value: string }>,
  markerBag: Record<string, string>,
): Array<{ key: string; value: string }> => {
  const out = new Map<string, string>();

  for (const item of wipeItems) {
    out.set(item.key, item.value);
  }
  for (const [key, value] of Object.entries(markerBag)) {
    out.set(key, value);
  }

  return Array.from(out.entries()).map(([key, value]) => ({ key, value }));
};

/*
 * Returns the brand's minimum (`0`) — fallback when no row exists yet so
 * `shouldSkip` has a sane lastSeenSeq to compare against. Mirrors T23.
 */
const unsafeMinimumSeq = (): SyncSeq => createSyncSeq(0)._unsafeUnwrap();

/*
 * Re-export for the wiring layer — register-handlers.ts (T24) imports
 * this to bind the use case to the eventRouter.
 */
export type { FiefUserId, SaleorApiUrl, SaleorUserId, SyncSeq };
export { IdentityMapRepoError };
