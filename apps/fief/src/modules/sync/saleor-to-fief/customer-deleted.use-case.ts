// cspell:ignore footgun recognise kwargs setattr

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import {
  type ChannelConfiguration,
  type ConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefAdminTokenSchema } from "@/modules/fief-client/admin-api-types";
import {
  createSaleorUserId,
  type FiefUserId,
  type SaleorApiUrl,
} from "@/modules/identity-map/identity-map";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { createProviderConnectionId } from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { FIEF_SYNC_ORIGIN_KEY, type SyncOrigin } from "@/modules/sync/loop-guard";

/*
 * T29 — Saleor → Fief CUSTOMER_DELETED use case.
 *
 * Mirrors T26/T27 in shape; the route handler verifies the Saleor signature,
 * applies the kill switch, pre-filters origin-marker echoes before enqueueing
 * onto T52's outbound queue, and the queue worker dispatches to this use case.
 *
 * Plan-mandated steps (T29):
 *   a. Resolve which `ProviderConnection` to use via T9 channel config. Same
 *      gotcha as T26/T27 — Saleor's User type has no channel slug; the route
 *      extracts an operator-stamped `_fief_channel` metadata key when present
 *      and the use case falls back to `defaultConnectionId` otherwise. Direct
 *      repo read + branch on slug-or-default beats T12's full resolver because
 *      the resolver requires a real `ChannelSlug` and would force a synthetic
 *      placeholder for the no-hint case.
 *   b. Look up the bound Fief user via identity_map (`getBySaleorUser`). On
 *      miss this is an idempotent no-op (`noFiefUser`) — Saleor may emit
 *      CUSTOMER_DELETED for a customer that was never wired into Fief (the
 *      operator added the connection AFTER the customer existed and before
 *      reconciliation ran). No need to fall back to email lookup the way T27
 *      does: with no binding there is nothing for us to deactivate, and email
 *      lookup at delete-time is a footgun (we'd risk deactivating an
 *      incidentally-matched Fief account that was never bound to this Saleor
 *      customer).
 *   c. **Deactivate, do NOT hard-delete** (PRD §F2.5). PATCH the Fief user
 *      via T5 `updateUser({ is_active: false })`. Hard-delete is intentionally
 *      out-of-scope for T5 — the audit trail (subscription history,
 *      compliance) outweighs any storage concern. T29 mirrors T24's policy on
 *      the Fief side.
 *   d. **Leave identity_map intact** for audit. Future reconciliation runs
 *      (T30/T32) will surface the mismatch (Saleor side gone, Fief side
 *      deactivated) as a `stale_mapping` row in T30's drift report; the
 *      operator can clean it up via T38's repair UI if they want.
 *   e. Tag origin marker `"saleor"` on the Fief side via the `fields` bag.
 *      Per the brief: "Tag origin `saleor` + bump seq on Fief side." We stamp
 *      `fef_sync_origin: "saleor"` into Fief user `fields` so the symmetric
 *      Fief-side handler (T24's `UserUpdated`) can recognise the deactivation
 *      as Saleor-originated and skip echoing it back. Seq bump is omitted —
 *      identity_map is untouched per (d), and a deactivated user receives no
 *      further updates.
 *
 * Loop-prevention defense lives in TWO places (route + use case) — see T26
 * notes; same rationale here.
 *
 * Outcome shape: callers (the queue worker) need to distinguish "did real
 * work" (info), "skipped intentionally" (debug only), "no Fief user yet"
 * (warn — operator-actionable, no error), "no connection" (warn). Errors
 * propagate as `Err` because the queue worker's retry logic depends on a
 * `Err`-typed failure to schedule a backoff.
 */

const logger = createLogger("modules.sync.saleor-to-fief.CustomerDeletedUseCase");

/** Sentinel queue eventType. Mirrored across T26/T27/T28/T29. */
export const CUSTOMER_DELETED_EVENT_TYPE = "saleor.customer_deleted" as const;

export const CustomerDeletedUseCaseError = BaseError.subclass("CustomerDeletedUseCaseError", {
  props: {
    _brand: "FiefApp.CustomerDeleted.UseCaseError" as const,
  },
});

export type CustomerDeletedUseCaseErrorInstance = InstanceType<typeof CustomerDeletedUseCaseError>;

/**
 * Job payload enqueued by the route. The use case consumes this verbatim.
 * Shape parity with T26/T27/T28's payloads (a future shared extractor can
 * collapse them) — kept separate for now to avoid coupling the events.
 */
export interface CustomerDeletedJobPayload {
  saleorApiUrl: SaleorApiUrl;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    isActive: boolean;
    isConfirmed: boolean;
    languageCode: string;
    metadata: ReadonlyArray<{ key: string; value: string }>;
    privateMetadata: ReadonlyArray<{ key: string; value: string }>;
  };
  channelSlug: string | null;
}

/**
 * Outcome reported back to the queue worker. Every non-`Err` outcome is
 * success (no retry needed) — `outcome` is for log + dashboard visibility,
 * not control flow.
 */
export type CustomerDeletedOutcome =
  | { outcome: "deactivated"; fiefUserId: FiefUserId }
  | { outcome: "skipped"; reason: "kill-switch" | "origin-fief" }
  | { outcome: "noConnection"; reason: "no-config" | "no-default" | "slug-disabled" }
  | { outcome: "noFiefUser"; reason: "no-binding" };

export interface CustomerDeletedUseCaseDeps {
  channelConfigurationRepo: Pick<IChannelConfigurationRepo, "get">;
  providerConnectionRepo: Pick<ProviderConnectionRepo, "get" | "getDecryptedSecrets">;
  /**
   * Subset of `FiefAdminApiClient` we touch. Typed loosely so tests can stub
   * without constructing a real client (which requires live config + retry
   * settings).
   */
  fiefAdmin: Pick<FiefAdminApiClient, "updateUser">;
  identityMapRepo: Pick<IdentityMapRepo, "getBySaleorUser">;
  /**
   * Injected so tests don't need to stub `@/lib/kill-switches` at module
   * scope. Production wiring passes the real `isSaleorToFiefDisabled`.
   */
  isSaleorToFiefDisabled: () => boolean;
}

const ORIGIN_FIEF: SyncOrigin = "fief";
const ORIGIN_SALEOR: SyncOrigin = "saleor";

const findOriginMarker = (
  metadata: ReadonlyArray<{ key: string; value: string }>,
): SyncOrigin | undefined => {
  const entry = metadata.find((m) => m.key === FIEF_SYNC_ORIGIN_KEY);

  if (!entry) return undefined;
  if (entry.value === "fief" || entry.value === "saleor") return entry.value;

  return undefined;
};

/**
 * Resolve which connection to load. Priority:
 *   1. If `channelSlug` is supplied, look for a matching override.
 *      `connectionId === "disabled"` → `slug-disabled`.
 *   2. Otherwise (no slug or slug had no override), `defaultConnectionId`.
 *   3. Null default → `no-default` noConnection.
 */
const resolveConnectionId = (
  config: ChannelConfiguration,
  channelSlug: string | null,
):
  | { kind: "use"; connectionId: ConnectionId }
  | { kind: "noConnection"; reason: "no-default" | "slug-disabled" } => {
  if (channelSlug !== null) {
    const override = config.overrides.find(
      (o) => (o.channelSlug as unknown as string) === channelSlug,
    );

    if (override) {
      if (override.connectionId === "disabled") {
        return { kind: "noConnection", reason: "slug-disabled" };
      }

      return { kind: "use", connectionId: override.connectionId };
    }
  }

  if (config.defaultConnectionId === null) {
    return { kind: "noConnection", reason: "no-default" };
  }

  return { kind: "use", connectionId: config.defaultConnectionId };
};

export class CustomerDeletedUseCase {
  private readonly deps: CustomerDeletedUseCaseDeps;

  constructor(deps: CustomerDeletedUseCaseDeps) {
    this.deps = deps;
  }

  async execute(
    payload: CustomerDeletedJobPayload,
  ): Promise<Result<CustomerDeletedOutcome, CustomerDeletedUseCaseErrorInstance>> {
    /*
     * Step 0 — kill switch + origin echo defense. Re-checked here because:
     *   - kill switch can flip TRUE between enqueue and dispatch;
     *   - origin echo: a queue row enqueued before a deploy that added the
     *     loop guard would not have been filtered.
     */
    if (this.deps.isSaleorToFiefDisabled()) {
      logger.debug("kill switch active; skipping customer-deleted sync", {
        saleorUserId: payload.user.id,
      });

      return ok({ outcome: "skipped", reason: "kill-switch" });
    }

    const incomingOrigin = findOriginMarker(payload.user.metadata);

    if (incomingOrigin === ORIGIN_FIEF) {
      logger.debug("loop-guard: origin=fief, skipping echo", {
        saleorUserId: payload.user.id,
      });

      return ok({ outcome: "skipped", reason: "origin-fief" });
    }

    /*
     * Step 1 — resolve the connection.
     */
    const configResult = await this.deps.channelConfigurationRepo.get(payload.saleorApiUrl);

    if (configResult.isErr()) {
      return err(
        new CustomerDeletedUseCaseError(
          "Failed to load channel configuration for CUSTOMER_DELETED dispatch",
          { cause: configResult.error },
        ),
      );
    }

    const config = configResult.value;

    if (!config) {
      logger.warn("no channel-configuration row for tenant; skipping", {
        saleorApiUrl: payload.saleorApiUrl,
      });

      return ok({ outcome: "noConnection", reason: "no-config" });
    }

    const resolved = resolveConnectionId(config, payload.channelSlug);

    if (resolved.kind === "noConnection") {
      logger.info("no connection resolved for customer; skipping", {
        saleorApiUrl: payload.saleorApiUrl,
        channelSlug: payload.channelSlug,
        reason: resolved.reason,
      });

      return ok({ outcome: "noConnection", reason: resolved.reason });
    }

    /*
     * Step 2 — look up the bound Fief user via identity_map. No email-fallback
     * for delete: we will not deactivate a Fief account we never bound to
     * this Saleor customer.
     */
    const saleorUserIdResult = createSaleorUserId(payload.user.id);

    if (saleorUserIdResult.isErr()) {
      return err(
        new CustomerDeletedUseCaseError("Saleor user id could not be branded as SaleorUserId", {
          cause: saleorUserIdResult.error,
        }),
      );
    }

    const identityRowResult = await this.deps.identityMapRepo.getBySaleorUser({
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: saleorUserIdResult.value,
    });

    if (identityRowResult.isErr()) {
      return err(
        new CustomerDeletedUseCaseError(
          "Failed to read identity_map while dispatching CUSTOMER_DELETED",
          { cause: identityRowResult.error },
        ),
      );
    }

    const identityRow = identityRowResult.value;

    if (!identityRow) {
      /*
       * Idempotent no-op. Common case: Saleor emits CUSTOMER_DELETED for a
       * customer that was never wired into Fief. Same `noFiefUser` outcome
       * shape T27 uses for its email-miss path.
       */
      logger.info("CUSTOMER_DELETED has no identity_map binding; idempotent no-op", {
        saleorApiUrl: payload.saleorApiUrl,
        saleorUserId: payload.user.id,
      });

      return ok({ outcome: "noFiefUser", reason: "no-binding" });
    }

    /*
     * Step 3 — load + decrypt the connection's admin token.
     */
    const providerConnectionId = createProviderConnectionId(
      resolved.connectionId as unknown as string,
    );
    const connectionResult = await this.deps.providerConnectionRepo.get({
      saleorApiUrl: payload.saleorApiUrl,
      id: providerConnectionId,
    });

    if (connectionResult.isErr()) {
      return err(
        new CustomerDeletedUseCaseError(
          "Failed to load provider connection while dispatching CUSTOMER_DELETED",
          { cause: connectionResult.error },
        ),
      );
    }

    const connection = connectionResult.value;
    const decryptedResult = await this.deps.providerConnectionRepo.getDecryptedSecrets({
      saleorApiUrl: payload.saleorApiUrl,
      id: connection.id,
    });

    if (decryptedResult.isErr()) {
      return err(
        new CustomerDeletedUseCaseError(
          "Failed to decrypt admin token while dispatching CUSTOMER_DELETED",
          { cause: decryptedResult.error },
        ),
      );
    }

    const adminToken = FiefAdminTokenSchema.parse(decryptedResult.value.fief.adminToken);
    const fiefUserId = identityRow.fiefUserId;

    /*
     * Step 4 — deactivate the Fief user. Per PRD §F2.5: deactivate, do NOT
     * hard-delete. Tag origin `"saleor"` on the Fief side via the `fields`
     * bag so a Fief-side handler that observes the resulting `UserUpdated`
     * event can recognise the deactivation as Saleor-originated and skip
     * echoing it back (loop-guard symmetric to T26/T27).
     *
     * `is_active` is exposed via T5's `FiefUserUpdateInputSchema` (the
     * upstream `set_user_attributes(**kwargs)` accepts it via `setattr`).
     */
    const updateResult = await this.deps.fiefAdmin.updateUser(adminToken, fiefUserId, {
      is_active: false,
      fields: {
        [FIEF_SYNC_ORIGIN_KEY]: ORIGIN_SALEOR,
      },
    });

    if (updateResult.isErr()) {
      return err(
        new CustomerDeletedUseCaseError(
          "Failed to deactivate Fief user during CUSTOMER_DELETED dispatch",
          { cause: updateResult.error },
        ),
      );
    }

    /*
     * Step 5 — identity_map intentionally NOT modified. Per the brief:
     * "Leave identity_map intact for audit." Reconciliation (T30/T32) will
     * surface the mismatch and the operator can resolve it via T38's repair
     * UI.
     */
    logger.info("CUSTOMER_DELETED deactivated Fief user; identity_map preserved for audit", {
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: payload.user.id,
      fiefUserId,
    });

    return ok({ outcome: "deactivated", fiefUserId });
  }
}
