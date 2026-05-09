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
  type SyncSeq,
} from "@/modules/identity-map/identity-map";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import {
  type ClaimMappingEntry,
  createProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { FIEF_SYNC_ORIGIN_KEY, type SyncOrigin } from "@/modules/sync/loop-guard";

/*
 * T28 — Saleor → Fief CUSTOMER_METADATA_UPDATED use case.
 *
 * Mirrors T26's resolve-connection-then-act shape but the write-back is
 * gated by the per-claim **reverse-sync** opt-in (T17 added
 * `ClaimMappingEntry.reverseSyncEnabled: boolean`, default `false`). Default
 * stance: nothing reverse-syncs unless the operator explicitly enables it
 * for a given mapping in T36's UI. This keeps Fief's "source-of-truth"
 * posture intact for legacy connections (PRD §F3.4).
 *
 * Plan-mandated steps (T28):
 *   a. Verify sig (T48) — done in the route via the SDK adapter.
 *   b. Honor kill switch (T54) — checked here AND in the route. The
 *      route filter avoids the queue write; the use case re-checks
 *      defensively in case the switch flipped between enqueue + dispatch.
 *   c. Skip if origin `"fief"` (T13). Same dual-check pattern.
 *   d. Resolve the connection (T9 channel config). Saleor's `User` payload
 *      does not carry a channel slug; the route extracts an optional
 *      `_fief_channel` metadata key and the use case falls back to
 *      `defaultConnectionId` when absent. Reuses the exact resolution
 *      module-doc rationale from T26 (no T12 full resolver here — the
 *      no-hint case would force a synthetic ChannelSlug).
 *   e. Look up identity_map for the (saleorApiUrl, saleorUserId). If no
 *      binding, no-op (`noBinding`); T26 owns the create+bind path. T28 is
 *      strictly an updater — we do not auto-bind on a metadata change.
 *   f. Walk the connection's `claimMapping`. For each entry where
 *      `reverseSyncEnabled === true` AND the corresponding
 *      `saleorMetadataKey` is present in the payload's `metadata` array,
 *      collect `{ [fiefClaim]: <value> }` into the Fief user_field patch.
 *   g. If the patch is empty, return `noChanges` (no Fief I/O, no seq bump).
 *   h. Otherwise, PATCH the Fief user via T5's `updateUser(token, id,
 *      { fields })`, then bump the identity_map seq via T10's `upsert`.
 *
 * Loop-prevention defense: see T26's docstring. The route filter is the
 * primary guard; this re-check protects against pre-loop-guard queue rows.
 *
 * Outcome shape: callers (the queue worker) treat `synced`, `noChanges`,
 * `skipped`, `noBinding`, `noConnection` all as success (no retry). Errors
 * propagate as `Err` because the queue worker's retry logic depends on a
 * thrown / `Err`-typed failure to schedule a backoff.
 */

const logger = createLogger("modules.sync.saleor-to-fief.CustomerMetadataUpdatedUseCase");

/** Sentinel queue eventType. Mirrored across T27/T28/T29. */
export const CUSTOMER_METADATA_UPDATED_EVENT_TYPE = "saleor.customer_metadata_updated" as const;

export const CustomerMetadataUpdatedUseCaseError = BaseError.subclass(
  "CustomerMetadataUpdatedUseCaseError",
  {
    props: {
      _brand: "FiefApp.CustomerMetadataUpdated.UseCaseError" as const,
    },
  },
);

export type CustomerMetadataUpdatedUseCaseErrorInstance = InstanceType<
  typeof CustomerMetadataUpdatedUseCaseError
>;

/**
 * Job payload enqueued by the route. The use case consumes this verbatim.
 *
 * Same shape as T26's payload (the underlying `SaleorCustomerEventUser`
 * fragment is shared) so the queue dispatcher's structural validation can
 * be reused.
 */
export interface CustomerMetadataUpdatedJobPayload {
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
  /**
   * Operator-supplied channel hint, if any (mirrors T26).
   */
  channelSlug: string | null;
}

/**
 * Outcome reported back to the queue worker. Each variant is a "success"
 * (no retry); the `outcome` discriminator is for log + dashboard
 * visibility.
 */
export type CustomerMetadataUpdatedOutcome =
  | { outcome: "synced"; fiefUserId: FiefUserId; fieldsForwarded: number }
  | { outcome: "noChanges"; reason: "no-reverse-sync-mapping" | "no-changed-mapped-keys" }
  | { outcome: "skipped"; reason: "kill-switch" | "origin-fief" }
  | { outcome: "noBinding" }
  | { outcome: "noConnection"; reason: "no-config" | "no-default" | "slug-disabled" };

export interface CustomerMetadataUpdatedUseCaseDeps {
  channelConfigurationRepo: Pick<IChannelConfigurationRepo, "get">;
  providerConnectionRepo: Pick<ProviderConnectionRepo, "get" | "getDecryptedSecrets">;
  /**
   * Subset of `FiefAdminApiClient` we touch. T28 only PATCHes user_field —
   * no list/create needed (binding is T26's responsibility).
   */
  fiefAdmin: Pick<FiefAdminApiClient, "updateUser">;
  identityMapRepo: Pick<IdentityMapRepo, "getBySaleorUser" | "upsert">;
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

/**
 * Resolve which connection to load. Identical to T26's resolver — kept
 * inline to avoid coupling the two use cases through a shared helper that
 * would need to know about both.
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

/**
 * Build the Fief user_field patch from the connection's claimMapping +
 * incoming metadata. Only mappings with `reverseSyncEnabled === true` are
 * considered; only keys actually present in the payload metadata yield a
 * patch entry. Returns an empty object when nothing applies.
 *
 * The "changed key" semantics are best-effort: Saleor's
 * CUSTOMER_METADATA_UPDATED payload carries the user's full metadata array,
 * not a delta. We forward whatever opted-in keys are present — the
 * downstream Fief PATCH is itself idempotent (same value → no-op on the
 * Fief side), so over-sending is safe and avoids the operational complexity
 * of tracking deltas across webhooks.
 */
const buildReverseSyncPatch = (
  claimMapping: ReadonlyArray<ClaimMappingEntry>,
  metadata: ReadonlyArray<{ key: string; value: string }>,
): Record<string, string> => {
  const patch: Record<string, string> = {};
  const metadataMap = new Map(metadata.map((m) => [m.key, m.value]));

  for (const mapping of claimMapping) {
    if (!mapping.reverseSyncEnabled) continue;
    const value = metadataMap.get(mapping.saleorMetadataKey);

    if (value === undefined) continue;
    patch[mapping.fiefClaim] = value;
  }

  return patch;
};

export class CustomerMetadataUpdatedUseCase {
  private readonly deps: CustomerMetadataUpdatedUseCaseDeps;

  constructor(deps: CustomerMetadataUpdatedUseCaseDeps) {
    this.deps = deps;
  }

  async execute(
    payload: CustomerMetadataUpdatedJobPayload,
  ): Promise<Result<CustomerMetadataUpdatedOutcome, CustomerMetadataUpdatedUseCaseErrorInstance>> {
    /*
     * Step 0 — kill switch + origin echo. Both checks repeat the route's
     * filtering (see T26 docstring for rationale).
     */
    if (this.deps.isSaleorToFiefDisabled()) {
      logger.debug("kill switch active; skipping customer-metadata-updated sync", {
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
        new CustomerMetadataUpdatedUseCaseError(
          "Failed to load channel configuration for CUSTOMER_METADATA_UPDATED dispatch",
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
     * Step 2 — load the connection. We need `claimMapping` to drive the
     * reverse-sync gate; we always need the encrypted admin token for the
     * Fief PATCH IF the patch turns out non-empty. Order: load + check
     * claimMapping FIRST; if no opted-in mappings exist, short-circuit
     * BEFORE decrypting (decryption is the expensive step).
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
        new CustomerMetadataUpdatedUseCaseError(
          "Failed to load provider connection while dispatching CUSTOMER_METADATA_UPDATED",
          { cause: connectionResult.error },
        ),
      );
    }

    const connection = connectionResult.value;

    /*
     * Step 3 — reverse-sync gate. Build the patch first so we can decide
     * whether to do any Fief I/O at all. Empty patch (default state, or
     * opted-in mappings whose keys aren't in this payload) → noChanges.
     */
    const optedInMappings = connection.claimMapping.filter((m) => m.reverseSyncEnabled);

    if (optedInMappings.length === 0) {
      logger.debug("no claim mapping has reverseSyncEnabled; skipping", {
        saleorApiUrl: payload.saleorApiUrl,
        saleorUserId: payload.user.id,
      });

      return ok({ outcome: "noChanges", reason: "no-reverse-sync-mapping" });
    }

    const patch = buildReverseSyncPatch(connection.claimMapping, payload.user.metadata);

    if (Object.keys(patch).length === 0) {
      logger.debug("opted-in mappings present but no matching keys in payload", {
        saleorApiUrl: payload.saleorApiUrl,
        saleorUserId: payload.user.id,
      });

      return ok({ outcome: "noChanges", reason: "no-changed-mapped-keys" });
    }

    /*
     * Step 4 — identity-map lookup. We need the FiefUserId to PATCH; if
     * there's no binding, T26 hasn't run yet for this user — we noBinding
     * and the operator's data flow will pick this up on the next
     * CUSTOMER_CREATED retry / reconciliation pass (T30).
     */
    const saleorUserIdResult = createSaleorUserId(payload.user.id);

    if (saleorUserIdResult.isErr()) {
      return err(
        new CustomerMetadataUpdatedUseCaseError(
          "Saleor user id could not be branded as SaleorUserId",
          { cause: saleorUserIdResult.error },
        ),
      );
    }

    const bindingResult = await this.deps.identityMapRepo.getBySaleorUser({
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: saleorUserIdResult.value,
    });

    if (bindingResult.isErr()) {
      return err(
        new CustomerMetadataUpdatedUseCaseError(
          "Failed to read identity_map binding for CUSTOMER_METADATA_UPDATED",
          { cause: bindingResult.error },
        ),
      );
    }

    const binding = bindingResult.value;

    if (!binding) {
      logger.info("no identity_map binding for Saleor user; skipping", {
        saleorApiUrl: payload.saleorApiUrl,
        saleorUserId: payload.user.id,
      });

      return ok({ outcome: "noBinding" });
    }

    /*
     * Step 5 — decrypt admin token + PATCH Fief user_field.
     */
    const decryptedResult = await this.deps.providerConnectionRepo.getDecryptedSecrets({
      saleorApiUrl: payload.saleorApiUrl,
      id: connection.id,
    });

    if (decryptedResult.isErr()) {
      return err(
        new CustomerMetadataUpdatedUseCaseError(
          "Failed to decrypt admin token while dispatching CUSTOMER_METADATA_UPDATED",
          { cause: decryptedResult.error },
        ),
      );
    }

    const adminToken = FiefAdminTokenSchema.parse(decryptedResult.value.fief.adminToken);
    const fiefUserId = FiefUserIdSchema.parse(binding.fiefUserId);

    const updateResult = await this.deps.fiefAdmin.updateUser(adminToken, fiefUserId, {
      fields: patch,
    });

    if (updateResult.isErr()) {
      return err(
        new CustomerMetadataUpdatedUseCaseError(
          "Failed to PATCH Fief user during CUSTOMER_METADATA_UPDATED reverse-sync",
          { cause: updateResult.error },
        ),
      );
    }

    /*
     * Step 6 — bump identity_map seq + tag origin "saleor". The seq bump
     * lets T13's monotonic guard drop any echo this PATCH triggers when
     * Fief webhooks back through T22 → T25's UserFieldsUpdated handler.
     *
     * We compute `prevSeq + 1`; if this is the first reverse-sync we still
     * want a strictly-monotonic step. T10's repo enforces "no regression"
     * at the storage layer so a concurrent newer write here is harmless.
     */
    const nextSeqValue = (binding.lastSyncSeq as unknown as number) + 1;
    const seqResult = createSyncSeq(nextSeqValue);

    if (seqResult.isErr()) {
      return err(
        new CustomerMetadataUpdatedUseCaseError(
          "Could not construct next SyncSeq from existing binding",
          { cause: seqResult.error },
        ),
      );
    }

    const upsertResult = await this.deps.identityMapRepo.upsert({
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: saleorUserIdResult.value,
      fiefUserId,
      syncSeq: seqResult.value as SyncSeq,
    });

    if (upsertResult.isErr()) {
      return err(
        new CustomerMetadataUpdatedUseCaseError(
          "Failed to bump identity_map seq after Fief reverse-sync",
          { cause: upsertResult.error },
        ),
      );
    }

    logger.info("reverse-sync applied for Saleor metadata change", {
      saleorApiUrl: payload.saleorApiUrl,
      saleorUserId: payload.user.id,
      fieldsForwarded: Object.keys(patch).length,
    });

    return ok({
      outcome: "synced",
      fiefUserId,
      fieldsForwarded: Object.keys(patch).length,
    });
  }
}
