// cspell:ignore passwordless

import { randomBytes } from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import {
  type ChannelConfiguration,
  type ConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefAdminTokenSchema, FiefTenantIdSchema } from "@/modules/fief-client/admin-api-types";
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
 * T26 — Saleor → Fief CUSTOMER_CREATED use case.
 *
 * The route handler (`route.ts`) verifies the Saleor signature, applies the
 * kill switch, and pre-filters origin-marker echoes before enqueueing a job
 * onto T52's outbound queue. This use case is what the queue worker
 * dispatches.
 *
 * Why a separate "use case from the route" split: the queue worker is a
 * background process that has its own retry / DLQ semantics; the route
 * handler must respond to Saleor in <3s (Saleor's webhook timeout). All Fief
 * I/O lives here so the route stays I/O-free except for the enqueue write.
 *
 * Plan-mandated steps (T26):
 *   a. Resolve which `ProviderConnection` to use via T9 channel config.
 *      Saleor's User type does NOT carry a channel slug. If the operator has
 *      stamped a `_fief_channel` metadata key on the customer we honor it;
 *      otherwise we fall back to `defaultConnectionId`. The use case never
 *      uses T12's full resolver here — it would force a synthetic
 *      `ChannelSlug` for the no-hint case which makes the resolver's
 *      "no override matched" path pointlessly indirect. Reading the config
 *      directly + branching on (slug match | default) is honest about the
 *      data we actually have.
 *   b. Look up Fief user by email via `iterateUsers` filtered by `email`.
 *      Existing match → bind identity_map only (idempotent on email
 *      collision per the plan). No `createUser` call.
 *   c. Otherwise, `createUser` with email + claim-derived fields, get the
 *      assigned `fiefUserId`.
 *   d. Upsert identity_map (T10) with the fresh mapping. The repo's
 *      `wasInserted` flag tells us whether we won the race against another
 *      caller (e.g. T19's auth handler firing concurrently); we don't
 *      branch on it here because either way the mapping is bound.
 *   e. Tag origin marker `"saleor"` + bump seq. This is a follow-up
 *      Saleor metadata write that the queue worker performs AFTER this use
 *      case (not implemented in T26 because the metadata write would
 *      trigger CUSTOMER_METADATA_UPDATED which is T28's surface; the loop
 *      guard catches the echo on the way back). Documented in the plan
 *      as a T28 dependency.
 *
 * Loop-prevention defense: the route filters origin-marker payloads before
 * enqueue, but the queue may carry pre-deploy rows. We re-check here so
 * old jobs don't accidentally bypass the loop guard after a deploy bump.
 *
 * Outcome shape: callers (the queue worker) need to distinguish "did real
 * work" (worth logging at info), "skipped intentionally" (debug only), and
 * "no connection" (warn, but not an error). Errors propagate as `Err`
 * because the queue worker's retry logic depends on a thrown / `Err`-typed
 * failure to schedule a backoff.
 */

const logger = createLogger("modules.sync.saleor-to-fief.CustomerCreatedUseCase");

/** Sentinel queue eventType. Mirrored across T27/T28/T29. */
export const CUSTOMER_CREATED_EVENT_TYPE = "saleor.customer_created" as const;

export const CustomerCreatedUseCaseError = BaseError.subclass("CustomerCreatedUseCaseError", {
  props: {
    _brand: "FiefApp.CustomerCreated.UseCaseError" as const,
  },
});

export type CustomerCreatedUseCaseErrorInstance = InstanceType<typeof CustomerCreatedUseCaseError>;

/**
 * Job payload enqueued by the route. The use case consumes this verbatim.
 *
 * Note: the queue persists `payload: unknown` per T52, so the worker must
 * structurally validate before invoking — we keep this interface narrow so
 * the dispatcher (a follow-up wiring step) has a clear schema to validate
 * against.
 */
export interface CustomerCreatedJobPayload {
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
   * Operator-supplied channel hint, if any. Saleor's CUSTOMER_CREATED
   * payload does not carry a channel slug, so the route extracts an
   * optional `_fief_channel` metadata key when present. `null` means
   * "fall back to defaultConnectionId".
   */
  channelSlug: string | null;
}

/**
 * Outcome reported back to the queue worker. The worker treats `synced`
 * and `skipped` and `noConnection` all as success (no retry needed) — the
 * `outcome` field is for log + dashboard visibility, not control flow.
 */
export type CustomerCreatedOutcome =
  | { outcome: "synced"; createdFiefUser: boolean; fiefUserId: FiefUserId }
  | {
      outcome: "skipped";
      reason: "kill-switch" | "origin-fief";
    }
  | { outcome: "noConnection"; reason: "no-config" | "no-default" | "slug-disabled" };

export interface CustomerCreatedUseCaseDeps {
  channelConfigurationRepo: Pick<IChannelConfigurationRepo, "get">;
  providerConnectionRepo: Pick<ProviderConnectionRepo, "get" | "getDecryptedSecrets">;
  /**
   * Subset of `FiefAdminApiClient` we touch. Typed loosely so tests can
   * stub without constructing a real client (which requires a live config
   * + retry settings).
   */
  fiefAdmin: Pick<FiefAdminApiClient, "iterateUsers" | "createUser">;
  identityMapRepo: Pick<IdentityMapRepo, "upsert">;
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
 * Resolve which connection to load. Priority:
 *   1. If `channelSlug` is supplied, look for a matching override.
 *      `connectionId === "disabled"` → `slug-disabled` (caller treats as
 *      noConnection — operator opted this slug out).
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

export class CustomerCreatedUseCase {
  private readonly deps: CustomerCreatedUseCaseDeps;

  constructor(deps: CustomerCreatedUseCaseDeps) {
    this.deps = deps;
  }

  async execute(
    payload: CustomerCreatedJobPayload,
  ): Promise<Result<CustomerCreatedOutcome, CustomerCreatedUseCaseErrorInstance>> {
    /*
     * Step 0 — kill switch + origin echo defense. Both checks repeat the
     * route's filtering. We re-check because:
     *   - kill switch can flip to TRUE between enqueue and dispatch (the
     *     job sat in the queue while the operator paused outbound sync);
     *   - origin echo: a queue row enqueued before a deploy that added the
     *     loop guard would not have been filtered; running them through
     *     the use case after a deploy must not cause a feedback loop.
     */
    if (this.deps.isSaleorToFiefDisabled()) {
      logger.debug("kill switch active; skipping customer-created sync", {
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
     * Step 1 — resolve the connection to sync into. Direct repo read +
     * branching is preferred to T12's full resolver here; see module
     * doc-comment.
     */
    const configResult = await this.deps.channelConfigurationRepo.get(payload.saleorApiUrl);

    if (configResult.isErr()) {
      return err(
        new CustomerCreatedUseCaseError(
          "Failed to load channel configuration for CUSTOMER_CREATED dispatch",
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
     * The two repo calls deliberately go in series: a missing connection
     * is the actionable signal; decrypting before that returns is wasted
     * work.
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
        new CustomerCreatedUseCaseError(
          "Failed to load provider connection while dispatching CUSTOMER_CREATED",
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
        new CustomerCreatedUseCaseError(
          "Failed to decrypt admin token while dispatching CUSTOMER_CREATED",
          { cause: decryptedResult.error },
        ),
      );
    }

    const adminToken = FiefAdminTokenSchema.parse(decryptedResult.value.fief.adminToken);
    const tenantId = FiefTenantIdSchema.parse(connection.fief.tenantId);

    /*
     * Step 3 — find-or-create on Fief side. We use `iterateUsers` with the
     * `extra: { email }` filter so the upstream returns at most one
     * candidate (Fief deduplicates emails per tenant). We still iterate
     * defensively in case the upstream interprets the filter as
     * `query`-style "starts-with" — we equality-check the email on each
     * yielded row.
     */
    let existing: { id: string } | null = null;

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
          existing = user as { id: string };
          break;
        }
      }
    } catch (error) {
      return err(
        new CustomerCreatedUseCaseError("Failed to query Fief for existing user by email", {
          cause: error,
        }),
      );
    }

    let fiefUserId: FiefUserId;
    let createdFiefUser = false;

    if (existing) {
      fiefUserId = FiefUserIdSchema.parse(existing.id);
      logger.info("email-collision: reusing existing Fief user", {
        saleorApiUrl: payload.saleorApiUrl,
        saleorUserId: payload.user.id,
      });
    } else {
      /*
       * Fief admin /users/ accepts a password field. We mint a
       * cryptographically-random placeholder per the FIXME in T5 — the
       * operator-facing flow is "user logs in via Fief and rotates"
       * (passwordless via email link is the typical first-login). 32
       * random bytes produces a 64-char hex string well above any
       * password-policy floor.
       */
      const password = randomPlaceholderPassword();
      const createResult = await this.deps.fiefAdmin.createUser(adminToken, {
        email: payload.user.email,
        password,
        email_verified: payload.user.isConfirmed,
        tenant_id: tenantId,
        fields: {
          first_name: payload.user.firstName,
          last_name: payload.user.lastName,
        },
      });

      if (createResult.isErr()) {
        return err(
          new CustomerCreatedUseCaseError(
            "Failed to create Fief user during CUSTOMER_CREATED dispatch",
            { cause: createResult.error },
          ),
        );
      }

      fiefUserId = createResult.value.id;
      createdFiefUser = true;
      logger.info("created new Fief user from Saleor CUSTOMER_CREATED", {
        saleorApiUrl: payload.saleorApiUrl,
        saleorUserId: payload.user.id,
      });
    }

    /*
     * Step 4 — bind identity_map. Initial seq is 1; subsequent updates
     * (T27) increment via the seq counter pulled from existing row state.
     * The upsert refuses to regress seq — see T10's contract.
     */
    const saleorUserIdResult = createSaleorUserId(payload.user.id);

    if (saleorUserIdResult.isErr()) {
      return err(
        new CustomerCreatedUseCaseError("Saleor user id could not be branded as SaleorUserId", {
          cause: saleorUserIdResult.error,
        }),
      );
    }

    const seqResult = createSyncSeq(1);

    if (seqResult.isErr()) {
      // Should never happen — `1` is a valid SyncSeq — but be honest about typing.
      return err(
        new CustomerCreatedUseCaseError("Could not construct initial SyncSeq", {
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
        new CustomerCreatedUseCaseError("Failed to upsert identity_map after Fief sync", {
          cause: upsertResult.error,
        }),
      );
    }

    return ok({ outcome: "synced", createdFiefUser, fiefUserId });
  }
}

/*
 * Cryptographically-random hex string. 32 bytes → 64 hex chars (>256 bits
 * entropy). The use case is only invoked from the worker, which is
 * nodejs-only, so `node:crypto` is fine.
 */
function randomPlaceholderPassword(): string {
  return randomBytes(32).toString("hex");
}
