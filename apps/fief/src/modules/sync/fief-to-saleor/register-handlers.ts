// cspell:ignore upsert opensensor behaviour

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { type FiefAdminToken } from "@/modules/fief-client/admin-api-types";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { type ReconciliationFlagRepo } from "@/modules/reconciliation/reconciliation-flag-repo";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type EventRouter, type WebhookEventPayload } from "./event-router";
import {
  PermissionRoleFieldUseCase,
  type PermissionRoleFieldUseCaseError,
} from "./permission-role-field.use-case";
import {
  type SaleorCustomerDeactivateClient,
  UserDeleteUseCase,
  type UserDeleteUseCaseError,
} from "./user-delete.use-case";
import {
  type SaleorCustomerClient,
  UserUpsertUseCase,
  type UserUpsertUseCaseError,
} from "./user-upsert.use-case";

/*
 * T23/T24/T25 — Single boot point that wires the Fief→Saleor handlers
 * onto T22's `eventRouter`.
 *
 * This file is the convention shared by T23, T24, and T25 — each task
 * appends its handler registration to the body of `registerFiefToSaleorHandlers`.
 * On boot (e.g. inside the App Router's webhook route module-load) the
 * production wiring calls this function exactly once with the resolved
 * dependency graph; tests construct an `EventRouter` per case, call
 * `registerFiefToSaleorHandlers(...)` with in-memory fakes, and assert
 * the handler-side behaviour through the router.
 *
 * Contract for T24 / T25 to follow when they extend this module:
 *
 *   1. Add the additional use-case dep slots to `RegisterFiefToSaleorHandlersDeps`
 *      (e.g. `userDeleteUseCase: UserDeleteUseCase` for T24).
 *   2. Append `eventRouter.registerHandler(eventType, ...)` calls below the
 *      existing T23 block — DO NOT re-order T23's calls.
 *   3. The closure they register MUST follow the same shape — resolve the
 *      connection via `resolveConnectionForEvent`, call `useCase.execute(...)`,
 *      and translate the Result into the `WebhookEventHandler` Result shape.
 *
 * Connection-context resolution
 * -----------------------------
 *
 * T22's `WebhookEventPayload` is `{ type, data, eventId }` only — no
 * `connectionId` or `saleorApiUrl`. The use case needs both (saleorApiUrl
 * scopes the identity_map; the connection's `claimMapping` drives the
 * projector). The wiring layer therefore takes a `resolveConnectionForEvent`
 * callback that the production code implements as a Mongo lookup keyed by
 * Fief's `data.tenant_id` (which IS in the payload — see `UserRead` in
 * `opensensor-fief/fief/schemas/user.py`). Tests inject a fixed-resolution
 * stub.
 *
 * Multi-tenancy note: a single Fief tenant can theoretically be linked to
 * multiple Saleor instances (one connection per `(saleorApiUrl, tenantId)`).
 * The resolver returns `null` when no connection matches; the handler
 * surfaces this as a `no-handler-side-skip` outcome (logged + accepted)
 * rather than a failure, because the receiver (T22) has already verified
 * HMAC against a connection — the resolver is a defense-in-depth lookup.
 * Fan-out across multiple matching connections is currently NOT supported
 * — the resolver returns the FIRST match. Multi-Saleor-per-tenant is a
 * follow-up (track in T36/T38 ops UI).
 */

export const RegisterHandlersError = {
  /**
   * The event payload was missing a tenant_id we could use for connection
   * resolution. Fief always emits `tenant_id` in user events, so this is
   * a forward-compat guard against future event types being wired here.
   */
  MissingTenantId: BaseError.subclass("RegisterHandlersMissingTenantIdError", {
    props: { _brand: "FiefApp.RegisterHandlers.MissingTenantId" as const },
  }),
  /**
   * No connection matches the resolver lookup. The receiver verified HMAC
   * against a connection so this is unusual — it can happen if the
   * connection was soft-deleted between HMAC verification and handler
   * dispatch. Surfaced as a handler-side error so T11 logs it visibly.
   */
  ConnectionNotResolved: BaseError.subclass("RegisterHandlersConnectionNotResolvedError", {
    props: { _brand: "FiefApp.RegisterHandlers.ConnectionNotResolved" as const },
  }),
};

export type RegisterHandlersError =
  | InstanceType<(typeof RegisterHandlersError)["MissingTenantId"]>
  | InstanceType<(typeof RegisterHandlersError)["ConnectionNotResolved"]>;

/**
 * Resolved connection-context fed to the use case. The minimal shape so
 * tests don't have to construct a full `ProviderConnection` doc.
 *
 * `adminToken` was added in T25 — the permission/role/field use case calls
 * `FiefAdminApiClient.getUser` to re-fetch the affected user and needs a
 * decrypted admin token. T23/T24 do NOT consume this field (the field is
 * resolver-supplied and additive — pre-existing resolvers without it
 * remain valid because TypeScript treats the missing property as
 * `undefined`, which T23/T24's handlers ignore).
 */
export interface ResolvedConnectionContext {
  saleorApiUrl: SaleorApiUrl;
  claimMapping: readonly ClaimMappingProjectionEntry[];
  /**
   * Plaintext Fief admin token, decrypted by the production resolver via
   * `ProviderConnectionRepo.getDecryptedSecrets`. Required for T25's
   * permission/role re-fetch path; absent → T25 surfaces a typed error.
   * T23/T24 do not consume this field.
   */
  adminToken?: FiefAdminToken;
}

/**
 * Resolver injected by production wiring. Takes the Fief webhook payload
 * and returns the connection context to use for that event, or `null` if
 * no connection matches.
 *
 * Production impl: look up `provider_connections` by Fief `tenant_id`
 * (extracted from `payload.data.tenant_id`) and return the first non-soft-
 * deleted match. Tests typically inject a fixed-context stub.
 */
export type ResolveConnectionForEvent = (
  payload: WebhookEventPayload,
) => Promise<Result<ResolvedConnectionContext | null, Error>>;

export interface RegisterFiefToSaleorHandlersDeps {
  eventRouter: EventRouter;
  identityMapRepo: IdentityMapRepo;
  saleorClient: SaleorCustomerClient;
  /**
   * Narrow Saleor write surface for T24's deactivate-on-delete use case.
   * Production wiring binds the same urql client + the deactivate-shaped
   * documents (`FiefCustomerUpdateDocument`, `FiefUpdateMetadataDocument`).
   * Kept as a separate slot so the use case can't reach for
   * `customerCreate` / `updatePrivateMetadata` (would violate the
   * preserve-audit-trail contract).
   */
  saleorDeactivateClient: SaleorCustomerDeactivateClient;
  /**
   * T25 — Fief admin API client (subset). Used by the permission/role
   * handler to re-fetch the affected user via `getUser`. Production wiring
   * supplies a `FiefAdminApiClient` instance; tests stub the `getUser`
   * method only.
   */
  fiefAdmin: Pick<FiefAdminApiClient, "getUser">;
  /**
   * T25 — `reconciliation_flags` storage. The `user_field.updated`
   * handler raises a flag here instead of fanning out per-user (schema
   * changes apply to every user; T38's UI surfaces the banner so
   * operators can run T30/T31 reconciliation on demand).
   */
  reconciliationFlagRepo: ReconciliationFlagRepo;
  resolveConnectionForEvent: ResolveConnectionForEvent;
}

const logger = createLogger("modules.sync.fief-to-saleor.registerHandlers");

/**
 * Wire the Fief→Saleor handlers onto the supplied `eventRouter`. Idempotent
 * but not concurrent-safe: call exactly once per boot. Re-calling will
 * trigger T22's "handler re-registered" warning log (last-write-wins).
 *
 * Returns the same `eventRouter` for chained registration if needed.
 */
export const registerFiefToSaleorHandlers = (
  deps: RegisterFiefToSaleorHandlersDeps,
): EventRouter => {
  const userUpsertUseCase = new UserUpsertUseCase({
    identityMapRepo: deps.identityMapRepo,
    saleorClient: deps.saleorClient,
  });

  const userUpsertHandler = async (
    payload: WebhookEventPayload,
  ): Promise<Result<unknown, RegisterHandlersError | UserUpsertUseCaseError>> => {
    const connectionResult = await deps.resolveConnectionForEvent(payload);

    if (connectionResult.isErr()) {
      logger.error("resolveConnectionForEvent failed for Fief user event", {
        eventType: payload.type,
        eventId: payload.eventId,
        error: connectionResult.error,
      });

      return err(
        new RegisterHandlersError.ConnectionNotResolved(
          "Failed to resolve connection for Fief webhook event",
          { cause: connectionResult.error },
        ),
      );
    }

    const context = connectionResult.value;

    if (context === null) {
      logger.warn("No connection matched the Fief webhook event — accepting without write", {
        eventType: payload.type,
        eventId: payload.eventId,
      });

      return err(
        new RegisterHandlersError.ConnectionNotResolved(
          "No connection matches this Fief event (resolver returned null)",
        ),
      );
    }

    return userUpsertUseCase.execute({
      saleorApiUrl: context.saleorApiUrl,
      claimMapping: context.claimMapping,
      payload,
    });
  };

  /*
   * T23: register the upsert handler against BOTH user-lifecycle event
   * keys. The use case is event-type agnostic — it discriminates between
   * "create" and "update" by inspecting the identity_map state, not the
   * event type — so we can reuse the same handler for both.
   *
   * Keys MUST exactly match `WebhookEvent.type` from
   * `opensensor-fief/fief/services/webhooks/models.py:UserCreated.key()`
   * and `UserUpdated.key()`.
   */
  deps.eventRouter
    .registerHandler("user.created", userUpsertHandler)
    .registerHandler("user.updated", userUpsertHandler);

  /*
   * T24 — `user.deleted` handler. Per PRD §F2.5: deactivate the Saleor
   * customer (`isActive: false`), wipe public claim metadata, leave
   * private metadata + identity_map row intact for audit. Tag origin
   * "fief" so the Saleor→Fief loop guard (T26-T29) drops the echo.
   *
   * Same connection-resolution boilerplate as T23 — reuses the
   * `resolveConnectionForEvent` callback so the wiring layer only has
   * to supply one resolver for the whole Fief→Saleor surface.
   */
  const userDeleteUseCase = new UserDeleteUseCase({
    identityMapRepo: deps.identityMapRepo,
    saleorClient: deps.saleorDeactivateClient,
  });

  const userDeleteHandler = async (
    payload: WebhookEventPayload,
  ): Promise<Result<unknown, RegisterHandlersError | UserDeleteUseCaseError>> => {
    const connectionResult = await deps.resolveConnectionForEvent(payload);

    if (connectionResult.isErr()) {
      logger.error("resolveConnectionForEvent failed for Fief user.deleted event", {
        eventType: payload.type,
        eventId: payload.eventId,
        error: connectionResult.error,
      });

      return err(
        new RegisterHandlersError.ConnectionNotResolved(
          "Failed to resolve connection for Fief user.deleted event",
          { cause: connectionResult.error },
        ),
      );
    }

    const context = connectionResult.value;

    if (context === null) {
      logger.warn("No connection matched the Fief user.deleted event — accepting without write", {
        eventType: payload.type,
        eventId: payload.eventId,
      });

      return err(
        new RegisterHandlersError.ConnectionNotResolved(
          "No connection matches this Fief user.deleted event (resolver returned null)",
        ),
      );
    }

    return userDeleteUseCase.execute({
      saleorApiUrl: context.saleorApiUrl,
      claimMapping: context.claimMapping,
      payload,
    });
  };

  /*
   * Key MUST exactly match `WebhookEvent.type` from
   * `opensensor-fief/fief/services/webhooks/models.py:UserDeleted` =
   * `"user.deleted"`.
   */
  deps.eventRouter.registerHandler("user.deleted", userDeleteHandler);

  /*
   * T25 — Permission / Role / UserField handlers. Five Fief webhook event
   * types collapse into one use case (see `permission-role-field.use-case.ts`
   * for the rationale): four of them re-fetch + re-project the affected
   * user's claims; the fifth (`user_field.updated`) raises a
   * "reconciliation recommended" flag (T38 reads it).
   *
   * Like T23/T24, all five share the same connection-resolution closure.
   * The use case additionally needs a Fief admin token (resolved by the
   * production resolver via `ProviderConnectionRepo.getDecryptedSecrets`)
   * and a `ReconciliationFlagRepo`.
   *
   * `user_field.updated` deliberately runs through THIS handler (not its
   * own) so the connection-resolution + loop-prevention surface stays
   * unified; the use case discriminates internally on `payload.type`.
   *
   * Keys MUST exactly match `WebhookEvent.type` from
   * `opensensor-fief/fief/services/webhooks/models.py`:
   *   `UserPermissionCreated.key()` = `"user_permission.created"`
   *   `UserPermissionDeleted.key()` = `"user_permission.deleted"`
   *   `UserRoleCreated.key()`       = `"user_role.created"`
   *   `UserRoleDeleted.key()`       = `"user_role.deleted"`
   *   `UserFieldUpdated.key()`      = `"user_field.updated"`
   */
  const permissionRoleFieldUseCase = new PermissionRoleFieldUseCase({
    identityMapRepo: deps.identityMapRepo,
    saleorClient: deps.saleorClient,
    fiefAdmin: deps.fiefAdmin,
    reconciliationFlagRepo: deps.reconciliationFlagRepo,
  });

  const permissionRoleFieldHandler = async (
    payload: WebhookEventPayload,
  ): Promise<Result<unknown, RegisterHandlersError | PermissionRoleFieldUseCaseError>> => {
    const connectionResult = await deps.resolveConnectionForEvent(payload);

    if (connectionResult.isErr()) {
      logger.error("resolveConnectionForEvent failed for Fief permission/role/field event", {
        eventType: payload.type,
        eventId: payload.eventId,
        error: connectionResult.error,
      });

      return err(
        new RegisterHandlersError.ConnectionNotResolved(
          "Failed to resolve connection for Fief permission/role/field event",
          { cause: connectionResult.error },
        ),
      );
    }

    const context = connectionResult.value;

    if (context === null) {
      logger.warn(
        "No connection matched the Fief permission/role/field event — accepting without write",
        {
          eventType: payload.type,
          eventId: payload.eventId,
        },
      );

      return err(
        new RegisterHandlersError.ConnectionNotResolved(
          "No connection matches this Fief permission/role/field event (resolver returned null)",
        ),
      );
    }

    /*
     * `user_field.updated` does NOT need an admin token (it raises a
     * flag without re-fetching any user). The other four event types DO
     * need one. We only enforce the presence check at the use-case
     * boundary so a misconfigured resolver surfaces a typed error rather
     * than crashing on undefined.
     */
    const adminTokenForUseCase: FiefAdminToken =
      context.adminToken ?? ("" as unknown as FiefAdminToken);

    return permissionRoleFieldUseCase.execute({
      saleorApiUrl: context.saleorApiUrl,
      claimMapping: context.claimMapping,
      adminToken: adminTokenForUseCase,
      payload,
    });
  };

  deps.eventRouter
    .registerHandler("user_permission.created", permissionRoleFieldHandler)
    .registerHandler("user_permission.deleted", permissionRoleFieldHandler)
    .registerHandler("user_role.created", permissionRoleFieldHandler)
    .registerHandler("user_role.deleted", permissionRoleFieldHandler)
    .registerHandler("user_field.updated", permissionRoleFieldHandler);

  return deps.eventRouter;
};

/**
 * Helper for tests: synchronous variant of the resolver factory that
 * always returns the same context. Avoids tests needing to spell out
 * the Promise<Result> shape inline.
 */
export const buildFixedConnectionResolver =
  (context: ResolvedConnectionContext | null): ResolveConnectionForEvent =>
  async () =>
    ok(context);
