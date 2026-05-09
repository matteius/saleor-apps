// cspell:ignore upsert upserts opensensor dedup behavioural retriable

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import {
  type ClaimMappingProjectionEntry,
  projectClaimsToSaleorMetadata,
  type ProjectedSaleorMetadata,
} from "@/modules/claims-mapping/projector";
import {
  createSyncSeq,
  type FiefUserId,
  FiefUserIdSchema,
  type IdentityMapRow,
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
 * T23 — Fief→Saleor `user.created` / `user.updated` use case.
 *
 * One entry point (`UserUpsertUseCase.execute`) handles BOTH event types
 * — they have identical payload shapes (`UserRead` per
 * `opensensor-fief/fief/schemas/user.py`) and the only behavioural
 * difference between them is whether an identity_map row already exists
 * (which we discover via lookup, NOT via the event-type discriminator).
 * Treating both events through one path means a `user.updated` that
 * arrives before its matching `user.created` (Fief retry, dedup miss)
 * still does the right thing — we look up, find no row, and provision.
 *
 * Race semantics — there are TWO concurrent provisioners that can land
 * on the same `(saleorApiUrl, fiefUserId)`:
 *
 *   - T19 (`POST /api/auth/external-obtain-access-tokens`) — the Saleor
 *     plugin's first-login callback. T19 calls Fief's token endpoint,
 *     gets the `fiefUserId`, then upserts identity_map.
 *
 *   - T23 (THIS use case) — fired by Fief's `user.created` webhook,
 *     which Fief emits as soon as the user record is committed.
 *
 * Both paths funnel through `IdentityMapRepo.upsert(...)` which is the
 * synchronization point (T10's atomic findOneAndUpdate against a unique
 * compound index). Whichever caller wins the race observes
 * `wasInserted: true`; the loser observes `wasInserted: false` and
 * re-uses the bound `saleorUserId`.
 *
 * The flow:
 *
 *   1. Validate the Fief webhook payload — we accept the union of fields
 *      Fief actually emits for these events (`UserRead` in fief's
 *      schemas; `id`, `email`, `email_verified`, `is_active`, `tenant_id`,
 *      `fields`, `created_at`, `updated_at`). The receiver has already
 *      verified HMAC + JSON-shape (T22), so this is the typed boundary.
 *
 *   2. Loop-guard: extract origin + seq markers from the Fief user's
 *      `fields` (where the Saleor→Fief writers — T26-T29 — stash them
 *      via `tagWrite(...)`). If the marker says origin="saleor" or the
 *      seq is `<= lastSeenSeq`, drop the event. PRD §F2.8.
 *
 *   3. Lookup-or-provision: fetch the identity_map row. If absent,
 *      create the Saleor customer (T7's `customerCreate`) and atomically
 *      upsert. If present, reuse the bound `saleorUserId` and skip the
 *      create.
 *
 *   4. Project claims (T14) over the Fief user's `fields`, merge with
 *      `tagWrite("fief", newSeq)` so the write itself carries our
 *      origin marker (which is what T26-T29 will observe and skip).
 *
 *   5. Write split metadata via T7's `FiefUpdateMetadata` +
 *      `FiefUpdatePrivateMetadata` mutations against the bound id.
 *
 * The Saleor GraphQL surface is fronted by `SaleorCustomerClient` — a
 * narrow interface so tests can swap in a fake without standing up an
 * urql `Client`. Production wiring (T56/T57 + register-handlers.ts)
 * supplies a real implementation backed by T7's generated documents
 * (`FiefCustomerCreateDocument`, `FiefUpdateMetadataDocument`,
 * `FiefUpdatePrivateMetadataDocument`).
 */

// -- Errors -------------------------------------------------------------------

export const UserUpsertUseCaseError = {
  /**
   * The webhook `data` did not match the `UserRead` schema (missing
   * `id` / `email` / etc.). The receiver has already accepted the body
   * (it parsed as `{type, data}`), so this is a Fief-side schema drift
   * or an event whose payload doesn't fit the user-lifecycle shape.
   */
  InvalidPayload: BaseError.subclass("UserUpsertInvalidPayloadError", {
    props: { _brand: "FiefApp.UserUpsert.InvalidPayload" as const },
  }),
  /**
   * `IdentityMapRepo.upsert(...)` or `getByFiefUser(...)` returned err.
   * The handler treats this as retriable — the receiver records it as
   * `accepted-with-handler-error` and the queue (T52) backs off.
   */
  IdentityMapWriteFailed: BaseError.subclass("UserUpsertIdentityMapWriteFailedError", {
    props: { _brand: "FiefApp.UserUpsert.IdentityMapWriteFailed" as const },
  }),
  /**
   * Saleor's `customerCreate` mutation failed (network, account error,
   * duplicate-email, etc). Retriable.
   */
  SaleorCustomerCreateFailed: BaseError.subclass("UserUpsertSaleorCustomerCreateFailedError", {
    props: { _brand: "FiefApp.UserUpsert.SaleorCustomerCreateFailed" as const },
  }),
  /**
   * `FiefUpdateMetadata` / `FiefUpdatePrivateMetadata` mutation failed.
   * Retriable. NOTE: we run metadata BEFORE privateMetadata, so a partial
   * failure leaves the public bucket written but private absent — this
   * is acceptable because the next event (or T30's reconciliation) will
   * re-converge.
   */
  SaleorMetadataWriteFailed: BaseError.subclass("UserUpsertSaleorMetadataWriteFailedError", {
    props: { _brand: "FiefApp.UserUpsert.SaleorMetadataWriteFailed" as const },
  }),
};

export type UserUpsertUseCaseError =
  | InstanceType<(typeof UserUpsertUseCaseError)["InvalidPayload"]>
  | InstanceType<(typeof UserUpsertUseCaseError)["IdentityMapWriteFailed"]>
  | InstanceType<(typeof UserUpsertUseCaseError)["SaleorCustomerCreateFailed"]>
  | InstanceType<(typeof UserUpsertUseCaseError)["SaleorMetadataWriteFailed"]>;

export type SaleorCustomerWriteError =
  | InstanceType<(typeof UserUpsertUseCaseError)["SaleorCustomerCreateFailed"]>
  | InstanceType<(typeof UserUpsertUseCaseError)["SaleorMetadataWriteFailed"]>;

// -- Saleor write surface (intentionally narrow) ------------------------------

export interface CreatedSaleorCustomer {
  saleorUserId: SaleorUserId;
  email: string;
}

/**
 * Narrow Saleor write surface for the use case. Production wiring binds
 * each method to a urql client + the matching generated document
 * (`FiefCustomerCreateDocument`, `FiefUpdateMetadataDocument`,
 * `FiefUpdatePrivateMetadataDocument`). Tests inject a fake.
 *
 * Method-by-method rather than passing in a urql `Client`:
 *   - The use case only writes — it doesn't need query / cache surfaces.
 *   - The fakes for tests don't need to mock urql internals.
 *   - When/if we later need a different transport (e.g. a server-to-
 *     server admin token vs. Saleor's app-token), only the wiring
 *     changes; the use case stays unchanged.
 */
export interface SaleorCustomerClient {
  customerCreate(input: {
    saleorApiUrl: SaleorApiUrl;
    email: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
  }): Promise<Result<CreatedSaleorCustomer, SaleorCustomerWriteError>>;

  updateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, SaleorCustomerWriteError>>;

  updatePrivateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, SaleorCustomerWriteError>>;
}

// -- Payload schema -----------------------------------------------------------

/*
 * Validated subset of `UserRead` (per `opensensor-fief/fief/schemas/user.py`).
 * We only require the fields the use case actually consumes — everything
 * else is permissively accepted (`.passthrough()` so future Fief schema
 * additions don't trip this).
 *
 * Note: `id` is the canonical Fief user UUID (we re-brand via the existing
 * FiefUserId schema for type safety). Other IDs (tenant_id, etc.) are
 * accepted as plain strings here because we don't read them in this use
 * case — the connection context already pins us to a tenant via the
 * receiver's connectionId lookup.
 */
const FiefUserEventDataSchema = z
  .object({
    id: z.string().uuid({ message: "data.id must be a UUID" }),
    email: z.string().email({ message: "data.email must be an email" }),
    email_verified: z.boolean().optional(),
    is_active: z.boolean().optional(),
    tenant_id: z.string().optional(),
    fields: z.record(z.unknown()).optional().default({}),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

type FiefUserEventData = z.infer<typeof FiefUserEventDataSchema>;

// -- Outcome ------------------------------------------------------------------

export type UserUpsertOutcome =
  | {
      kind: "skipped-by-loop-guard";
      reason: "origin-matches-processing-side" | "stale-seq";
    }
  | {
      kind: "written";
      saleorUserId: SaleorUserId;
      /** True if THIS execution wrote the identity_map row (race winner). */
      wasInserted: boolean;
      /** The seq that was written into Saleor's privateMetadata. */
      writtenSeq: SyncSeq;
    };

// -- Use case -----------------------------------------------------------------

export interface UserUpsertUseCaseDeps {
  identityMapRepo: IdentityMapRepo;
  saleorClient: SaleorCustomerClient;
}

export interface ExecuteInput {
  saleorApiUrl: SaleorApiUrl;
  /**
   * The connection's claim mapping. Per T22's design the eventRouter
   * payload doesn't carry connection context, so the wiring layer
   * (`register-handlers.ts`) resolves the connection by Fief tenant_id
   * + saleorApiUrl scope, then passes the relevant subset here. This
   * keeps the use case independent of how connections are stored.
   */
  claimMapping: readonly ClaimMappingProjectionEntry[];
  payload: WebhookEventPayload;
}

const PROCESSING_SIDE: SyncOrigin = "saleor"; // we are writing INTO Saleor

const logger = createLogger("modules.sync.fief-to-saleor.UserUpsertUseCase");

export class UserUpsertUseCase {
  private readonly identityMapRepo: IdentityMapRepo;
  private readonly saleorClient: SaleorCustomerClient;

  constructor(deps: UserUpsertUseCaseDeps) {
    this.identityMapRepo = deps.identityMapRepo;
    this.saleorClient = deps.saleorClient;
  }

  async execute(input: ExecuteInput): Promise<Result<UserUpsertOutcome, UserUpsertUseCaseError>> {
    /*
     * Step 1 — validate the Fief webhook payload. The receiver has
     * already gated on the `{type, data}` shape; this layer adds the
     * stricter user-event schema check.
     */
    const dataResult = parseFiefUserEventData(input.payload);

    if (dataResult.isErr()) {
      logger.warn("Fief user webhook payload failed validation", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        error: dataResult.error.message,
      });

      return err(dataResult.error);
    }

    const userData = dataResult.value;
    const fiefUserId = userData.id as unknown as FiefUserId;

    /*
     * Step 2 — extract loop-guard markers from the Fief user `fields`.
     * Saleor→Fief writers (T26-T29) stash origin + seq there via
     * `tagWrite(...)`. If marker is absent (legacy/external event)
     * `shouldSkip` falls through to the seq check, then to "proceed".
     */
    const incomingMarker = extractMarkerFromFiefFields(userData.fields ?? {});

    const existingRowResult = await this.identityMapRepo.getByFiefUser({
      saleorApiUrl: input.saleorApiUrl,
      fiefUserId,
    });

    if (existingRowResult.isErr()) {
      logger.error("identity_map getByFiefUser failed; surfacing as IdentityMapWriteFailed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        error: existingRowResult.error,
      });

      return err(
        new UserUpsertUseCaseError.IdentityMapWriteFailed("getByFiefUser failed", {
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

      logger.info("Fief→Saleor user-upsert skipped by loop guard", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        fiefUserId,
        reason,
      });

      return ok({ kind: "skipped-by-loop-guard", reason });
    }

    /*
     * Step 3 — lookup-or-provision. If a row exists, reuse the binding;
     * if not, create the Saleor customer first so we know the
     * `saleorUserId` to feed into `upsert`.
     */
    let saleorUserId: SaleorUserId;

    if (existingRow) {
      saleorUserId = existingRow.saleorUserId;
    } else {
      const createResult = await this.saleorClient.customerCreate({
        saleorApiUrl: input.saleorApiUrl,
        email: userData.email,
        firstName: stringOrUndefined(userData.fields?.["first_name"]),
        lastName: stringOrUndefined(userData.fields?.["last_name"]),
        isActive: userData.is_active,
      });

      if (createResult.isErr()) {
        logger.error("Saleor customerCreate failed for new Fief user", {
          eventType: input.payload.type,
          eventId: input.payload.eventId,
          fiefUserId,
          error: createResult.error,
        });

        return err(createResult.error);
      }

      saleorUserId = createResult.value.saleorUserId;
    }

    /*
     * Step 4 — bump seq and atomically upsert. The seq must be strictly
     * greater than the lastSeenSeq we observed — keep it simple by
     * adding 1. T10's storage layer rejects regressions, so even if a
     * concurrent writer has already bumped past us we converge to the
     * higher value via the `wasInserted: false` path.
     */
    const newSeqResult = createSyncSeq(lastSeenSeq + 1);

    if (newSeqResult.isErr()) {
      // Should be unreachable — `lastSeenSeq + 1` is always a non-negative integer.
      return err(
        new UserUpsertUseCaseError.IdentityMapWriteFailed("Failed to construct bumped SyncSeq", {
          cause: newSeqResult.error,
        }),
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
      logger.error("identity_map upsert failed; surfacing as IdentityMapWriteFailed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        fiefUserId,
        error: upsertResult.error,
      });

      return err(
        new UserUpsertUseCaseError.IdentityMapWriteFailed("upsert failed", {
          cause: upsertResult.error,
        }),
      );
    }

    const { row, wasInserted } = upsertResult.value;
    /*
     * If the row already existed AND a concurrent writer bumped seq past
     * us, T10 returns the existing row with `wasInserted: false` and the
     * higher `lastSyncSeq` intact. Use the canonical row's seq for the
     * Saleor write so we don't regress what's already in Saleor.
     */
    const writtenSeq = createSyncSeq(row.lastSyncSeq).unwrapOr(newSeq);

    /*
     * Step 5 — project claims and merge the origin marker, then split
     * into Saleor's metadata + privateMetadata buckets. The marker MUST
     * land on the write because that's how T26-T29 detect "this came
     * from us — drop the echo".
     */
    const projection = projectClaimsToSaleorMetadata(input.claimMapping, userData.fields ?? {});
    const tag = tagWrite(PROCESSING_SIDE === "saleor" ? "fief" : "saleor", writtenSeq);

    const finalWrite = mergeProjectionWithTag(projection, tag);

    /*
     * Two mutations — public bucket first, private second. A failure
     * between them surfaces as `SaleorMetadataWriteFailed` and the
     * receiver records it as retriable; the next event or the
     * reconciliation walker (T30) re-converges.
     */
    const metadataResult = await this.saleorClient.updateMetadata({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      items: toMetadataItems(finalWrite.metadata),
    });

    if (metadataResult.isErr()) {
      logger.error("Saleor updateMetadata failed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        saleorUserId,
        error: metadataResult.error,
      });

      return err(metadataResult.error);
    }

    const privateResult = await this.saleorClient.updatePrivateMetadata({
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId,
      items: toMetadataItems(finalWrite.privateMetadata),
    });

    if (privateResult.isErr()) {
      logger.error("Saleor updatePrivateMetadata failed", {
        eventType: input.payload.type,
        eventId: input.payload.eventId,
        saleorUserId,
        error: privateResult.error,
      });

      return err(privateResult.error);
    }

    logger.info("Fief→Saleor user-upsert completed", {
      eventType: input.payload.type,
      eventId: input.payload.eventId,
      fiefUserId,
      saleorUserId,
      wasInserted,
      writtenSeq,
    });

    return ok({ kind: "written", saleorUserId, wasInserted, writtenSeq });
  }
}

// -- helpers ------------------------------------------------------------------

const parseFiefUserEventData = (
  payload: WebhookEventPayload,
): Result<FiefUserEventData, InstanceType<(typeof UserUpsertUseCaseError)["InvalidPayload"]>> => {
  const parsed = FiefUserEventDataSchema.safeParse(payload.data);

  if (!parsed.success) {
    return err(
      new UserUpsertUseCaseError.InvalidPayload(
        `Invalid Fief user event payload: ${parsed.error.message}`,
        { cause: parsed.error },
      ),
    );
  }

  /*
   * Defense-in-depth: brand the user id with FiefUserIdSchema to make sure
   * we got a Fief-shape uuid (the Fief-side validator emits UUID4; the
   * schema on our side accepts UUIDs generally).
   */
  const branded = FiefUserIdSchema.safeParse(parsed.data.id);

  if (!branded.success) {
    return err(
      new UserUpsertUseCaseError.InvalidPayload(
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

interface MergedSaleorWrite {
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

const mergeProjectionWithTag = (
  projection: ProjectedSaleorMetadata,
  tag: { metadata: Record<string, string>; privateMetadata: Record<string, string> },
): MergedSaleorWrite => ({
  /*
   * Tag wins on conflict — the marker MUST be authoritative or the
   * loop guard breaks. In practice the operator-supplied claim mapping
   * shouldn't shadow our reserved keys.
   */
  metadata: { ...projection.metadata, ...tag.metadata },
  privateMetadata: { ...projection.privateMetadata, ...tag.privateMetadata },
});

const toMetadataItems = (bag: Record<string, string>): Array<{ key: string; value: string }> =>
  Object.entries(bag).map(([key, value]) => ({ key, value }));

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/*
 * Returns the brand's minimum (`0`). Used as a fallback when no row
 * exists yet so `shouldSkip` has a sane lastSeenSeq to compare against.
 *
 * NOTE: `createSyncSeq(0)` is total (the schema accepts 0), so the
 * `_unsafeUnwrap` cannot throw here — but we wrap in a function so the
 * branded value is constructed once per call rather than living in
 * module state (where stale tests / vitest reloads could share it).
 */
const unsafeMinimumSeq = (): SyncSeq => createSyncSeq(0)._unsafeUnwrap();

/*
 * Re-export for the wiring layer — register-handlers.ts (T23/T24/T25
 * collectively) imports this to bind the use case to the eventRouter.
 */
export type { FiefUserId, IdentityMapRow, SaleorApiUrl, SaleorUserId, SyncSeq };
export { IdentityMapRepoError };
