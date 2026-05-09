// cspell:ignore upsert opensensor behaviour

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type EventRouter, type WebhookEventPayload } from "./event-router";
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
 */
export interface ResolvedConnectionContext {
  saleorApiUrl: SaleorApiUrl;
  claimMapping: readonly ClaimMappingProjectionEntry[];
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
   * T24 and T25 will append additional registerHandler calls below this
   * line. Keep T23's two calls together so the boot trace is readable.
   */

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
