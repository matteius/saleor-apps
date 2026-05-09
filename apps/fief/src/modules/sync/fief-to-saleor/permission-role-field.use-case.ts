// cspell:ignore upsert opensensor retriable behavioural behaviour

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import {
  type ClaimMappingProjectionEntry,
  projectClaimsToSaleorMetadata,
  type ProjectedSaleorMetadata,
} from "@/modules/claims-mapping/projector";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { type AnyFiefAdminApiError } from "@/modules/fief-client/admin-api-errors";
import {
  type FiefAdminToken,
  type FiefUser,
  type FiefUserId,
  FiefUserIdSchema,
} from "@/modules/fief-client/admin-api-types";
import {
  createSyncSeq,
  type SaleorApiUrl,
  type SaleorUserId,
  type SyncSeq,
} from "@/modules/identity-map/identity-map";
import {
  type IdentityMapRepo,
  type IdentityMapRepoError,
} from "@/modules/identity-map/identity-map-repo";
import {
  createReconciliationFlagReason,
  type ReconciliationFlagError as ReconciliationFlagErrorType,
} from "@/modules/reconciliation/reconciliation-flag";
import { type ReconciliationFlagRepo } from "@/modules/reconciliation/reconciliation-flag-repo";
import {
  FIEF_SYNC_ORIGIN_KEY,
  FIEF_SYNC_SEQ_KEY,
  shouldSkip,
  type SyncOrigin,
  tagWrite,
} from "@/modules/sync/loop-guard";

import { type WebhookEventPayload } from "./event-router";
import { type SaleorCustomerClient, type SaleorCustomerWriteError } from "./user-upsert.use-case";

/*
 * T25 — Fief→Saleor `user_permission.{created,deleted}`,
 * `user_role.{created,deleted}`, and `user_field.updated` use case.
 *
 * Five Fief webhook events collapse into ONE class because four of them
 * share the same downstream behaviour (re-fetch user → re-project claims
 * → re-write Saleor metadata) and the fifth (`user_field.updated`) is a
 * schema-level change handled by raising an operational flag.
 *
 *   - `user_permission.created` / `user_permission.deleted`
 *   - `user_role.created` / `user_role.deleted`
 *
 *     Payload `data.user_id` identifies the affected user. We use T5's
 *     `FiefAdminApiClient.getUser` to refresh the FULL user (with the
 *     current `fields` bag), then run the standard project + tag + write
 *     pipeline against the bound Saleor customer (looked up via the
 *     identity_map established by T19 / T23).
 *
 *     If no identity_map row exists, we surface `NoIdentityMapping` —
 *     T23 will provision the row when its `user.created` event arrives;
 *     a permission/role event arriving first is an out-of-order Fief
 *     delivery the receiver records and the next dispatch corrects.
 *     We do NOT create the Saleor customer here (that's T23's job).
 *
 *   - `user_field.updated`
 *
 *     SCHEMA change. Applies to ALL users. We deliberately do NOT fan
 *     out per-user (could be millions of users — would melt Saleor and
 *     would still be racy with concurrent T23 deliveries). Instead we
 *     raise a "reconciliation recommended" flag in the
 *     `reconciliation_flags` collection (see
 *     `modules/reconciliation/reconciliation-flag.ts`) which T38's UI
 *     surfaces as a banner. Operators trigger T30/T31 reconciliation
 *     on demand from there.
 *
 * Loop guard: identical to T23's pattern. After re-fetching the Fief
 * user, we extract origin + seq markers from `FiefUser.fields` (where
 * Saleor→Fief writers stash them via `tagWrite(...)`) and skip if the
 * marker says origin="saleor" — the permission grant was triggered by
 * a Saleor-side write we already reflected through Fief; processing
 * the echo would loop. PRD §F2.8.
 */

// -- Errors -------------------------------------------------------------------

export const PermissionRoleFieldUseCaseError = {
  /**
   * The webhook payload did not carry the field we expected — `data.user_id`
   * for permission/role events, or an unrecognized `payload.type`.
   */
  InvalidPayload: BaseError.subclass("PermissionRoleFieldInvalidPayloadError", {
    props: { _brand: "FiefApp.PermissionRoleField.InvalidPayload" as const },
  }),
  /**
   * `FiefAdminApiClient.getUser(...)` returned an error (network / auth /
   * 404). Not retried automatically here — the receiver's recordAttempt
   * + queue (T11/T52) handle backoff.
   */
  FiefUserFetchFailed: BaseError.subclass("PermissionRoleFieldFiefUserFetchFailedError", {
    props: { _brand: "FiefApp.PermissionRoleField.FiefUserFetchFailed" as const },
  }),
  /**
   * `IdentityMapRepo.getByFiefUser` / `upsert` returned an error.
   */
  IdentityMapWriteFailed: BaseError.subclass("PermissionRoleFieldIdentityMapWriteFailedError", {
    props: { _brand: "FiefApp.PermissionRoleField.IdentityMapWriteFailed" as const },
  }),
  /**
   * No identity_map row exists for this Fief user. Out-of-order delivery —
   * T23's `user.created` will follow shortly and provision the binding.
   * Surfaced as a typed error so the receiver records visibility; not a
   * bug in our pipeline.
   */
  NoIdentityMapping: BaseError.subclass("PermissionRoleFieldNoIdentityMappingError", {
    props: { _brand: "FiefApp.PermissionRoleField.NoIdentityMapping" as const },
  }),
  /**
   * `updateMetadata` / `updatePrivateMetadata` failed at Saleor.
   */
  SaleorMetadataWriteFailed: BaseError.subclass(
    "PermissionRoleFieldSaleorMetadataWriteFailedError",
    {
      props: { _brand: "FiefApp.PermissionRoleField.SaleorMetadataWriteFailed" as const },
    },
  ),
  /**
   * The reconciliation_flags storage write failed for a `user_field.updated`
   * event. The use case has no other side effect on this event type, so the
   * caller treats this as a clean retriable failure (no user-data is at
   * risk of corruption — the flag just isn't recorded yet).
   */
  ReconciliationFlagWriteFailed: BaseError.subclass(
    "PermissionRoleFieldReconciliationFlagWriteFailedError",
    {
      props: {
        _brand: "FiefApp.PermissionRoleField.ReconciliationFlagWriteFailed" as const,
      },
    },
  ),
};

export type PermissionRoleFieldUseCaseError =
  | InstanceType<(typeof PermissionRoleFieldUseCaseError)["InvalidPayload"]>
  | InstanceType<(typeof PermissionRoleFieldUseCaseError)["FiefUserFetchFailed"]>
  | InstanceType<(typeof PermissionRoleFieldUseCaseError)["IdentityMapWriteFailed"]>
  | InstanceType<(typeof PermissionRoleFieldUseCaseError)["NoIdentityMapping"]>
  | InstanceType<(typeof PermissionRoleFieldUseCaseError)["SaleorMetadataWriteFailed"]>
  | InstanceType<(typeof PermissionRoleFieldUseCaseError)["ReconciliationFlagWriteFailed"]>;

// -- Outcome ------------------------------------------------------------------

export type PermissionRoleFieldOutcome =
  | {
      kind: "skipped-by-loop-guard";
      reason: "origin-matches-processing-side" | "stale-seq";
    }
  | {
      kind: "written";
      saleorUserId: SaleorUserId;
      writtenSeq: SyncSeq;
    }
  | {
      kind: "reconciliation-flag-raised";
      reason: string;
    };

// -- Payload schemas ----------------------------------------------------------

/*
 * `user_permission.*` / `user_role.*` payloads — both carry `data.user_id`
 * (and other fields we don't read here). We accept the union loosely and
 * brand the user_id with `FiefUserIdSchema` for type safety.
 */
const FiefUserScopedEventDataSchema = z
  .object({
    user_id: z.string().uuid({ message: "data.user_id must be a UUID" }),
  })
  .passthrough();

/*
 * `user_field.updated` payload — we only need the slug + id for log /
 * reason text. Other fields (configuration, type) are accepted permissively.
 */
const FiefUserFieldEventDataSchema = z
  .object({
    id: z.string().uuid({ message: "data.id must be a UUID" }),
    slug: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const PERMISSION_ROLE_EVENT_TYPES = new Set<string>([
  "user_permission.created",
  "user_permission.deleted",
  "user_role.created",
  "user_role.deleted",
]);

const FIELD_EVENT_TYPE = "user_field.updated";

// -- Use case -----------------------------------------------------------------

export interface PermissionRoleFieldUseCaseDeps {
  identityMapRepo: IdentityMapRepo;
  saleorClient: SaleorCustomerClient;
  /**
   * Subset of `FiefAdminApiClient` we actually call. Loosely typed so tests
   * can stub without constructing a real client (which requires a live
   * config + retry settings).
   */
  fiefAdmin: Pick<FiefAdminApiClient, "getUser">;
  reconciliationFlagRepo: ReconciliationFlagRepo;
}

export interface ExecuteInput {
  saleorApiUrl: SaleorApiUrl;
  /** The connection's claim mapping — used by the projector. */
  claimMapping: readonly ClaimMappingProjectionEntry[];
  /**
   * Plaintext admin token for the connection. Resolved by the wiring
   * layer (`register-handlers.ts`) via `ProviderConnectionRepo.getDecryptedSecrets`.
   */
  adminToken: FiefAdminToken;
  payload: WebhookEventPayload;
}

const PROCESSING_SIDE: SyncOrigin = "saleor"; // we are writing INTO Saleor

const logger = createLogger("modules.sync.fief-to-saleor.PermissionRoleFieldUseCase");

export class PermissionRoleFieldUseCase {
  private readonly identityMapRepo: IdentityMapRepo;
  private readonly saleorClient: SaleorCustomerClient;
  private readonly fiefAdmin: Pick<FiefAdminApiClient, "getUser">;
  private readonly reconciliationFlagRepo: ReconciliationFlagRepo;

  constructor(deps: PermissionRoleFieldUseCaseDeps) {
    this.identityMapRepo = deps.identityMapRepo;
    this.saleorClient = deps.saleorClient;
    this.fiefAdmin = deps.fiefAdmin;
    this.reconciliationFlagRepo = deps.reconciliationFlagRepo;
  }

  async execute(
    input: ExecuteInput,
  ): Promise<Result<PermissionRoleFieldOutcome, PermissionRoleFieldUseCaseError>> {
    /*
     * Step 0 — discriminate by event type. The use case is collapsed but
     * the per-event-type branches diverge significantly here.
     */
    if (input.payload.type === FIELD_EVENT_TYPE) {
      return this.executeFieldUpdated(input);
    }

    if (PERMISSION_ROLE_EVENT_TYPES.has(input.payload.type)) {
      return this.executePermissionOrRole(input);
    }

    logger.warn("Unrecognized event type for PermissionRoleFieldUseCase", {
      eventType: input.payload.type,
      eventId: input.payload.eventId,
    });

    return err(
      new PermissionRoleFieldUseCaseError.InvalidPayload(
        `Unrecognized event type for PermissionRoleFieldUseCase: ${input.payload.type}`,
      ),
    );
  }

  // -- user_permission.* / user_role.* ----------------------------------------

  private async executePermissionOrRole(
    input: ExecuteInput,
  ): Promise<Result<PermissionRoleFieldOutcome, PermissionRoleFieldUseCaseError>> {
    const parsed = FiefUserScopedEventDataSchema.safeParse(input.payload.data);

    if (!parsed.success) {
      return err(
        new PermissionRoleFieldUseCaseError.InvalidPayload(
          `Invalid permission/role event payload: ${parsed.error.message}`,
          { cause: parsed.error },
        ),
      );
    }

    const branded = FiefUserIdSchema.safeParse(parsed.data.user_id);

    if (!branded.success) {
      return err(
        new PermissionRoleFieldUseCaseError.InvalidPayload(
          `data.user_id is not a valid Fief user id: ${branded.error.message}`,
        ),
      );
    }

    const fiefUserId: FiefUserId = branded.data;

    /*
     * Step 1 — re-fetch the user via T5 so we have the canonical claim bag
     * (and the loop-guard markers in `fields`).
     */
    const fetchResult = await this.fiefAdmin.getUser(input.adminToken, fiefUserId);

    if (fetchResult.isErr()) {
      logger.error("FiefAdminApi.getUser failed for permission/role event", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        fiefUserId,
        error: fetchResult.error,
      });

      return err(
        new PermissionRoleFieldUseCaseError.FiefUserFetchFailed(
          "Failed to re-fetch Fief user for permission/role event",
          { cause: fetchResult.error as AnyFiefAdminApiError },
        ),
      );
    }

    const fiefUser = fetchResult.value;

    /*
     * Step 2 — loop guard. Extract origin/seq from the user's fields bag.
     * If the marker says origin="saleor", we triggered this through a
     * Saleor-originated write that propagated to Fief; processing the echo
     * would loop. Skip BEFORE reading identity_map — the skip path doesn't
     * need it.
     */
    const incomingMarker = extractMarkerFromFiefFields(fiefUser.fields);

    /*
     * Step 3 — identity_map lookup. We need the bound Saleor user id.
     */
    const existingRowResult = await this.identityMapRepo.getByFiefUser({
      saleorApiUrl: input.saleorApiUrl,
      fiefUserId,
    });

    if (existingRowResult.isErr()) {
      return err(
        new PermissionRoleFieldUseCaseError.IdentityMapWriteFailed(
          "identity_map getByFiefUser failed",
          { cause: existingRowResult.error },
        ),
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

      logger.info("Permission/role event skipped by loop guard", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        fiefUserId,
        reason,
      });

      return ok({ kind: "skipped-by-loop-guard", reason });
    }

    if (existingRow === null) {
      logger.warn(
        "No identity_map row for permission/role event — out-of-order delivery; T23 will provision shortly",
        {
          eventType: input.payload.type,
          eventId: input.payload.eventId,
          fiefUserId,
        },
      );

      return err(
        new PermissionRoleFieldUseCaseError.NoIdentityMapping(
          "identity_map row missing for fiefUserId — out-of-order Fief delivery",
        ),
      );
    }

    const saleorUserId: SaleorUserId = existingRow.saleorUserId;

    /*
     * Step 4 — bump seq + atomically upsert. T10 enforces monotonicity at
     * the storage layer; concurrent writers converge via `wasInserted: false`.
     */
    const newSeqResult = createSyncSeq(lastSeenSeq + 1);

    if (newSeqResult.isErr()) {
      return err(
        new PermissionRoleFieldUseCaseError.IdentityMapWriteFailed(
          "Failed to construct bumped SyncSeq",
          { cause: newSeqResult.error },
        ),
      );
    }

    const newSeq = newSeqResult.value;

    const upsertResult = await this.identityMapRepo.upsert({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      fiefUserId,
      syncSeq: newSeq,
    });

    if (upsertResult.isErr()) {
      return err(
        new PermissionRoleFieldUseCaseError.IdentityMapWriteFailed("identity_map upsert failed", {
          cause: upsertResult.error,
        }),
      );
    }

    const { row } = upsertResult.value;
    const writtenSeq = createSyncSeq(row.lastSyncSeq).unwrapOr(newSeq);

    /*
     * Step 5 — re-project claims + tag + write. Identical to T23.
     */
    const projection = projectClaimsToSaleorMetadata(input.claimMapping, fiefUser.fields);
    const tag = tagWrite(PROCESSING_SIDE === "saleor" ? "fief" : "saleor", writtenSeq);
    const finalWrite = mergeProjectionWithTag(projection, tag);

    const metadataResult = await this.saleorClient.updateMetadata({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      items: toMetadataItems(finalWrite.metadata),
    });

    if (metadataResult.isErr()) {
      return err(saleorWriteToOurError(metadataResult.error));
    }

    const privateResult = await this.saleorClient.updatePrivateMetadata({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      items: toMetadataItems(finalWrite.privateMetadata),
    });

    if (privateResult.isErr()) {
      return err(saleorWriteToOurError(privateResult.error));
    }

    logger.info("Permission/role event re-projected to Saleor", {
      eventType: input.payload.type,
      eventId: input.payload.eventId,
      fiefUserId,
      saleorUserId,
      writtenSeq,
    });

    return ok({ kind: "written", saleorUserId, writtenSeq });
  }

  // -- user_field.updated -----------------------------------------------------

  private async executeFieldUpdated(
    input: ExecuteInput,
  ): Promise<Result<PermissionRoleFieldOutcome, PermissionRoleFieldUseCaseError>> {
    const parsed = FiefUserFieldEventDataSchema.safeParse(input.payload.data);

    if (!parsed.success) {
      return err(
        new PermissionRoleFieldUseCaseError.InvalidPayload(
          `Invalid user_field.updated payload: ${parsed.error.message}`,
          { cause: parsed.error },
        ),
      );
    }

    const slug = parsed.data.slug ?? "(unknown-slug)";
    const fieldId = parsed.data.id;

    /*
     * Build a meaningful reason string. T38's UI shows this verbatim so
     * operators know WHY reconciliation is recommended.
     */
    const reasonText = `user_field.updated: slug=${slug} id=${fieldId}`;
    const reasonResult = createReconciliationFlagReason(reasonText);

    if (reasonResult.isErr()) {
      // Should be unreachable — the reason text is always non-empty.
      return err(
        new PermissionRoleFieldUseCaseError.InvalidPayload(
          `Could not build reconciliation flag reason: ${reasonResult.error.message}`,
          { cause: reasonResult.error },
        ),
      );
    }

    const raiseResult = await this.reconciliationFlagRepo.raise({
      saleorApiUrl: input.saleorApiUrl,
      reason: reasonResult.value,
      raisedByEventId: input.payload.eventId,
    });

    if (raiseResult.isErr()) {
      logger.error(
        "Failed to raise reconciliation flag for user_field.updated event; surfacing as soft failure",
        {
          eventType: input.payload.type,
          eventId: input.payload.eventId,
          error: raiseResult.error,
        },
      );

      return err(reconciliationToOurError(raiseResult.error));
    }

    logger.info(
      "user_field.updated event raised reconciliation-recommended flag (no per-user fan-out)",
      {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        slug,
        fieldId,
      },
    );

    return ok({ kind: "reconciliation-flag-raised", reason: reasonText });
  }
}

// -- helpers ------------------------------------------------------------------

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

interface MergedSaleorWrite {
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

const mergeProjectionWithTag = (
  projection: ProjectedSaleorMetadata,
  tag: { metadata: Record<string, string>; privateMetadata: Record<string, string> },
): MergedSaleorWrite => ({
  metadata: { ...projection.metadata, ...tag.metadata },
  privateMetadata: { ...projection.privateMetadata, ...tag.privateMetadata },
});

const toMetadataItems = (bag: Record<string, string>): Array<{ key: string; value: string }> =>
  Object.entries(bag).map(([key, value]) => ({ key, value }));

const unsafeMinimumSeq = (): SyncSeq => createSyncSeq(0)._unsafeUnwrap();

const saleorWriteToOurError = (
  e: SaleorCustomerWriteError,
): InstanceType<(typeof PermissionRoleFieldUseCaseError)["SaleorMetadataWriteFailed"]> =>
  new PermissionRoleFieldUseCaseError.SaleorMetadataWriteFailed(
    "Saleor metadata mutation failed during permission/role re-projection",
    { cause: e },
  );

const reconciliationToOurError = (
  e: ReconciliationFlagErrorType,
): InstanceType<(typeof PermissionRoleFieldUseCaseError)["ReconciliationFlagWriteFailed"]> =>
  new PermissionRoleFieldUseCaseError.ReconciliationFlagWriteFailed(
    "Failed to raise reconciliation flag for user_field.updated",
    { cause: e },
  );

/*
 * Re-export for the wiring layer.
 */
export type { FiefUser, FiefUserId, IdentityMapRepoError, SaleorApiUrl, SaleorUserId, SyncSeq };
