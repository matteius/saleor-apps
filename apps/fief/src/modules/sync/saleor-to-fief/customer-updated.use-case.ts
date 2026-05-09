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
  createSyncSeq,
  type FiefUserId,
  FiefUserIdSchema,
  type SaleorApiUrl,
} from "@/modules/identity-map/identity-map";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { createProviderConnectionId } from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { FIEF_SYNC_ORIGIN_KEY, type SyncOrigin } from "@/modules/sync/loop-guard";

/*
 * T27 — Saleor → Fief CUSTOMER_UPDATED use case.
 *
 * Mirrors T26 (CUSTOMER_CREATED) in shape; the route handler verifies the
 * Saleor signature, applies the kill switch, pre-filters origin-marker echoes
 * before enqueueing onto T52's outbound queue, and the queue worker dispatches
 * to this use case.
 *
 * Plan-mandated steps (T27):
 *   a. Resolve which `ProviderConnection` to use via T9 channel config. Same
 *      gotcha as T26 — Saleor's User type has no channel slug, so we honor an
 *      operator-stamped `_fief_channel` metadata key when present and fall
 *      back to `defaultConnectionId` otherwise. Direct repo read + branch on
 *      slug-or-default beats T12's full resolver because the resolver requires
 *      a real `ChannelSlug` and would force a synthetic placeholder for the
 *      no-hint case.
 *   b. Find the bound Fief user. Two-step lookup:
 *        i.  identity_map row by `(saleorApiUrl, saleorUserId)` — the common
 *            case. Already-bound customers go straight to PATCH.
 *        ii. If identity_map miss, email lookup via `iterateUsers` — handles
 *            the "operator wired the install AFTER the customer existed and
 *            the binding got out of sync" repair path. Match → PATCH that
 *            user + bind identity_map (`syncSeq=1`, fresh row).
 *        iii.Email miss too → `noFiefUser` outcome (no provisioning here;
 *            T26 owns CREATE; T27 only patches existing rows).
 *   c. PATCH Fief user via T5 `updateUser` with allowed fields:
 *      `email`, `email_verified`, `fields.first_name`, `fields.last_name`.
 *      We do NOT propagate `is_active` here — disable/enable lives in T29
 *      (CUSTOMER_DELETED) and Fief-side admin actions; conflating them would
 *      let a partial Saleor update deactivate a Fief account.
 *   d. Bump identity_map seq via T10 `upsert`. The repo's monotonic guard
 *      keeps the stored value safe under out-of-order webhook delivery.
 *   e. Tag origin marker `"saleor"` + bump seq on the Saleor side: same
 *      follow-up Saleor metadata write as T26, deferred to the worker layer.
 *
 * Loop-prevention defense lives in TWO places (route + use case) — see T26
 * notes; same rationale here.
 *
 * Outcome shape: callers (the queue worker) need to distinguish "did real
 * work" (info), "skipped intentionally" (debug only), "no Fief user yet"
 * (warn — operator-actionable), "no connection" (warn). Errors propagate as
 * `Err` because the queue worker's retry logic depends on a `Err`-typed
 * failure to schedule a backoff.
 */

const logger = createLogger("modules.sync.saleor-to-fief.CustomerUpdatedUseCase");

/** Sentinel queue eventType. Mirrored across T26/T27/T28/T29. */
export const CUSTOMER_UPDATED_EVENT_TYPE = "saleor.customer_updated" as const;

export const CustomerUpdatedUseCaseError = BaseError.subclass("CustomerUpdatedUseCaseError", {
  props: {
    _brand: "FiefApp.CustomerUpdated.UseCaseError" as const,
  },
});

export type CustomerUpdatedUseCaseErrorInstance = InstanceType<typeof CustomerUpdatedUseCaseError>;

/**
 * Job payload enqueued by the route. The use case consumes this verbatim.
 * Identical shape to T26's `CustomerCreatedJobPayload` so a future shared
 * extractor can collapse them — kept separate for now to avoid coupling the
 * two events.
 */
export interface CustomerUpdatedJobPayload {
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
 * Outcome reported back to the queue worker. The worker treats every
 * non-`Err` outcome as success (no retry needed) — `outcome` is for log +
 * dashboard visibility, not control flow.
 */
export type CustomerUpdatedOutcome =
  | { outcome: "synced"; patched: true; fiefUserId: FiefUserId }
  | { outcome: "skipped"; reason: "kill-switch" | "origin-fief" }
  | { outcome: "noConnection"; reason: "no-config" | "no-default" | "slug-disabled" }
  | { outcome: "noFiefUser"; reason: "no-binding-and-no-email-match" };

export interface CustomerUpdatedUseCaseDeps {
  channelConfigurationRepo: Pick<IChannelConfigurationRepo, "get">;
  providerConnectionRepo: Pick<ProviderConnectionRepo, "get" | "getDecryptedSecrets">;
  /**
   * Subset of `FiefAdminApiClient` we touch. Typed loosely so tests can stub
   * without constructing a real client.
   */
  fiefAdmin: Pick<FiefAdminApiClient, "iterateUsers" | "updateUser">;
  identityMapRepo: Pick<IdentityMapRepo, "upsert" | "getBySaleorUser">;
  /**
   * Injected so tests don't need to stub `@/lib/kill-switches` at module
   * scope. Production wiring passes the real `isSaleorToFiefDisabled`.
   */
  isSaleorToFiefDisabled: () => boolean;
}

const ORIGIN_FIEF: SyncOrigin = "fief";

const findOriginMarker = (
  metadata: ReadonlyArray<{ key: string; value: string }>,
): SyncOrigin | undefined => {
  const entry = metadata.find((m) => m.key === FIEF_SYNC_ORIGIN_KEY);

  if (!entry) return undefined;
  if (entry.value === "fief" || entry.value === "saleor") return entry.value;

  return undefined;
};

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

export class CustomerUpdatedUseCase {
  private readonly deps: CustomerUpdatedUseCaseDeps;

  constructor(deps: CustomerUpdatedUseCaseDeps) {
    this.deps = deps;
  }

  async execute(
    payload: CustomerUpdatedJobPayload,
  ): Promise<Result<CustomerUpdatedOutcome, CustomerUpdatedUseCaseErrorInstance>> {
    /*
     * Step 0 — kill switch + origin echo defense. Both checks repeat the
     * route's filtering. Re-checked here because:
     *   - kill switch can flip TRUE between enqueue and dispatch;
     *   - origin echo: a queue row enqueued before a deploy that added the
     *     loop guard would not have been filtered.
     */
    if (this.deps.isSaleorToFiefDisabled()) {
      logger.debug("kill switch active; skipping customer-updated sync", {
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
        new CustomerUpdatedUseCaseError(
          "Failed to load channel configuration for CUSTOMER_UPDATED dispatch",
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
     * Step 2 — load the connection (encrypted) + decrypt the admin token.
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
        new CustomerUpdatedUseCaseError(
          "Failed to load provider connection while dispatching CUSTOMER_UPDATED",
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
        new CustomerUpdatedUseCaseError(
          "Failed to decrypt admin token while dispatching CUSTOMER_UPDATED",
          { cause: decryptedResult.error },
        ),
      );
    }

    const adminToken = FiefAdminTokenSchema.parse(decryptedResult.value.fief.adminToken);

    /*
     * Step 3 — find the bound Fief user. Two-step lookup; identity_map first,
     * email fallback if no binding exists yet.
     */
    const saleorUserIdResult = createSaleorUserId(payload.user.id);

    if (saleorUserIdResult.isErr()) {
      return err(
        new CustomerUpdatedUseCaseError("Saleor user id could not be branded as SaleorUserId", {
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
        new CustomerUpdatedUseCaseError(
          "Failed to read identity_map while dispatching CUSTOMER_UPDATED",
          { cause: identityRowResult.error },
        ),
      );
    }

    const identityRow = identityRowResult.value;

    let fiefUserId: FiefUserId;
    let nextSeq: number;

    if (identityRow) {
      fiefUserId = identityRow.fiefUserId;
      /*
       * Bump the existing seq monotonically. The repo's no-regression guard
       * keeps the stored value safe — but we still compute a strictly
       * higher value so an in-order delivery actually advances the seq.
       */
      nextSeq = (identityRow.lastSyncSeq as unknown as number) + 1;
    } else {
      /*
       * No binding yet — try the email-lookup repair path. Same
       * `iterateUsers` filter shape as T26 to keep the upstream parity.
       */
      let matched: { id: string } | null = null;

      try {
        for await (const user of this.deps.fiefAdmin.iterateUsers(adminToken, {
          limit: 5,
          extra: { email: payload.user.email },
        })) {
          if (
            typeof user === "object" &&
            user !== null &&
            "email" in user &&
            (user as { email: string }).email.toLowerCase() === payload.user.email.toLowerCase()
          ) {
            matched = user as { id: string };
            break;
          }
        }
      } catch (error) {
        return err(
          new CustomerUpdatedUseCaseError("Failed to query Fief for existing user by email", {
            cause: error,
          }),
        );
      }

      if (!matched) {
        logger.warn("no Fief user bound to Saleor customer and no email match; skipping update", {
          saleorApiUrl: payload.saleorApiUrl,
          saleorUserId: payload.user.id,
        });

        return ok({ outcome: "noFiefUser", reason: "no-binding-and-no-email-match" });
      }

      fiefUserId = FiefUserIdSchema.parse(matched.id);
      /*
       * First-time bind for this customer (the email-match repair path).
       * Seq starts at 1 — the same baseline T26's CREATE path uses.
       */
      nextSeq = 1;
    }

    /*
     * Step 4 — PATCH Fief user with the allowed-field whitelist. We
     * deliberately omit `is_active` (see module doc-comment).
     */
    const updateResult = await this.deps.fiefAdmin.updateUser(adminToken, fiefUserId, {
      email: payload.user.email,
      email_verified: payload.user.isConfirmed,
      fields: {
        first_name: payload.user.firstName,
        last_name: payload.user.lastName,
      },
    });

    if (updateResult.isErr()) {
      return err(
        new CustomerUpdatedUseCaseError(
          "Failed to update Fief user during CUSTOMER_UPDATED dispatch",
          { cause: updateResult.error },
        ),
      );
    }

    /*
     * Step 5 — bump identity_map seq.
     */
    const seqResult = createSyncSeq(nextSeq);

    if (seqResult.isErr()) {
      return err(
        new CustomerUpdatedUseCaseError("Could not construct next SyncSeq", {
          cause: seqResult.error,
        }),
      );
    }

    const upsertResult = await this.deps.identityMapRepo.upsert({
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: saleorUserIdResult.value,
      fiefUserId,
      syncSeq: seqResult.value,
    });

    if (upsertResult.isErr()) {
      return err(
        new CustomerUpdatedUseCaseError("Failed to upsert identity_map after Fief patch", {
          cause: upsertResult.error,
        }),
      );
    }

    logger.info("CUSTOMER_UPDATED patched Fief user", {
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: payload.user.id,
    });

    return ok({ outcome: "synced", patched: true, fiefUserId });
  }
}
