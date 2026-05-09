import { randomBytes } from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import {
  FiefAdminTokenSchema,
  FiefClientIdSchema,
  FiefTenantIdSchema,
  FiefWebhookIdSchema,
} from "@/modules/fief-client/admin-api-types";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type AllowedOrigin,
  createFiefBaseUrl,
  createFiefClientId,
  type ProviderConnection,
  type ProviderConnectionCreateInput,
  type ProviderConnectionName,
} from "../provider-connection";
import {
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "../provider-connection-repo";
import {
  type FiefAdminBootstrapInput,
  type FiefWebhookEventList,
  type ProviderConnectionLifecycleError,
} from "./types";

/*
 * T17 — `CreateConnectionUseCase`.
 *
 * One end-to-end "stand up a tenant" call: provisions a Fief OIDC client,
 * provisions a Fief webhook subscriber pointed at our `/api/webhooks/fief`
 * route (with the connectionId as a query param so the receiver can route
 * to the right config), generates a per-connection branding signing key
 * (T15 wire-format compatible — UTF-8 hex string consumed by HMAC), then
 * persists the whole bundle via T8's repo (which encrypts every secret slot
 * via T4 on the way in).
 *
 * Failure handling
 * ----------------
 *
 * The Fief side is provisioned BEFORE the local persist. If Fief succeeds
 * but Mongo persist fails, the use case attempts a best-effort cleanup
 * (delete the Fief client + webhook) so we don't leak orphan Fief resources.
 * The cleanup itself is logged but not surfaced — the caller sees the
 * original persist error so they understand the root cause.
 *
 * Branding signing key
 * --------------------
 *
 * Per T15's algo doc: the Fief verifier consumes the key as UTF-8 bytes
 * fed into HMAC-SHA256. To keep the key printable + URL-safe (so it can be
 * shown / copied in the operator UI when needed) we encode 32 random bytes
 * as lowercase hex. 64 chars = 32 bytes of entropy = >256 bits, way past
 * the HMAC-SHA256 collision floor.
 */

const SIGNING_KEY_BYTES = 32; // 32 bytes -> 64 hex chars; matches T15's spec

export const CreateConnectionError = {
  FiefProvisioningFailed: BaseError.subclass("CreateConnectionFiefProvisioningFailedError", {
    props: { _brand: "FiefApp.CreateConnection.FiefProvisioningFailed" as const },
  }),
  PersistFailed: BaseError.subclass("CreateConnectionPersistFailedError", {
    props: { _brand: "FiefApp.CreateConnection.PersistFailed" as const },
  }),
};

export type CreateConnectionError =
  | InstanceType<(typeof CreateConnectionError)["FiefProvisioningFailed"]>
  | InstanceType<(typeof CreateConnectionError)["PersistFailed"]>;

export interface CreateConnectionUseCaseInput {
  saleorApiUrl: SaleorApiUrl;
  name: ProviderConnectionName;
  /**
   * Connection-scoped Fief admin bootstrap config: where the tenant lives
   * (`baseUrl`/`tenantId`) and the admin token used to provision the client +
   * webhook. Stored as the connection's per-record admin token after
   * encryption.
   */
  fief: FiefAdminBootstrapInput & {
    /** Display name used when creating the Fief OIDC client. */
    clientName: string;
    /** Allowed redirect URIs for the OIDC client. Must be non-empty. */
    redirectUris: string[];
  };
  branding: {
    allowedOrigins: AllowedOrigin[];
  };
  /**
   * URL the Fief webhook subscriber will deliver events to. The use-case
   * appends `?connectionId={id}` so the T22 receiver can route to the right
   * config without a full `saleorApiUrl` lookup.
   */
  webhookReceiverBaseUrl: string;
  /** Fief event types to subscribe to. Defaults to user lifecycle events. */
  webhookEvents?: FiefWebhookEventList;
  /**
   * Claim mappings to seed the connection with. Operators can edit these
   * later via T36's UI.
   */
  claimMapping: ProviderConnectionCreateInput["claimMapping"];
}

const DEFAULT_WEBHOOK_EVENTS: FiefWebhookEventList = [
  "user.created",
  "user.updated",
  "user.deleted",
];

export interface CreateConnectionUseCaseDeps {
  repo: ProviderConnectionRepo;
  fiefAdmin: FiefAdminApiClient;
  /** Cryptographically-secure random byte source. Test seam. */
  randomBytesImpl?: (n: number) => Buffer;
}

export class CreateConnectionUseCase {
  private readonly repo: ProviderConnectionRepo;
  private readonly fiefAdmin: FiefAdminApiClient;
  private readonly randomBytesImpl: (n: number) => Buffer;
  private readonly logger = createLogger("provider-connections.create-connection");

  constructor(deps: CreateConnectionUseCaseDeps) {
    this.repo = deps.repo;
    this.fiefAdmin = deps.fiefAdmin;
    this.randomBytesImpl = deps.randomBytesImpl ?? ((n) => randomBytes(n));
  }

  async execute(
    input: CreateConnectionUseCaseInput,
  ): Promise<Result<ProviderConnection, ProviderConnectionLifecycleError>> {
    const adminToken = FiefAdminTokenSchema.parse(input.fief.adminToken);
    const tenantId = FiefTenantIdSchema.parse(input.fief.tenantId);
    const baseUrl = createFiefBaseUrl(input.fief.baseUrl);

    /*
     * Step 1 — provision the Fief OIDC client.
     */
    const clientResult = await this.fiefAdmin.createClient(adminToken, {
      name: input.fief.clientName,
      first_party: true,
      client_type: "confidential",
      redirect_uris: input.fief.redirectUris,
      tenant_id: tenantId,
    });

    if (clientResult.isErr()) {
      this.logger.error("Failed to create Fief OIDC client", {
        saleorApiUrl: input.saleorApiUrl,
        error: clientResult.error,
      });

      return err(
        new CreateConnectionError.FiefProvisioningFailed(
          "Failed to create Fief OIDC client during connection provisioning",
          { cause: clientResult.error },
        ),
      );
    }

    const fiefClient = clientResult.value;
    const fiefClientUuid = FiefClientIdSchema.parse(fiefClient.id);

    /*
     * Step 2 — provision the Fief webhook subscriber. The `connectionId` is
     * not yet known (we generate UUIDs in the repo on insert), so we register
     * with a sentinel placeholder and patch the URL after the local persist
     * succeeds. The trade-off: the webhook URL temporarily carries
     * `connectionId=__pending__`; if Fief manages to deliver an event before
     * we patch (microseconds) it would 404 in T22, which falls into the
     * "orphan event → 410 Gone" path that T22 already handles.
     *
     * Cleaner alternative: pre-generate the UUID here and pass it down. We
     * pick the "patch later" path because the repo owns id-gen (single source
     * of truth for `ProviderConnectionId` minting) — overriding it from the
     * use case would mean threading a `withId` option through T8.
     */
    const placeholderUrl = appendConnectionIdQuery(input.webhookReceiverBaseUrl, "__pending__");
    const webhookResult = await this.fiefAdmin.createWebhook(adminToken, {
      url: placeholderUrl,
      events: input.webhookEvents ?? DEFAULT_WEBHOOK_EVENTS,
    });

    if (webhookResult.isErr()) {
      this.logger.error("Failed to create Fief webhook subscriber", {
        saleorApiUrl: input.saleorApiUrl,
        error: webhookResult.error,
      });
      // Roll back the client we just created.
      await this.bestEffortDeleteClient(adminToken, fiefClientUuid);

      return err(
        new CreateConnectionError.FiefProvisioningFailed(
          "Failed to create Fief webhook subscriber during connection provisioning",
          { cause: webhookResult.error },
        ),
      );
    }

    const webhook = webhookResult.value;
    const webhookId = FiefWebhookIdSchema.parse(webhook.id);

    /*
     * Step 3 — derive a per-connection branding signing key. T15's algo
     * consumes the key as UTF-8 bytes; printable hex keeps that safe.
     */
    const signingKey = this.randomBytesImpl(SIGNING_KEY_BYTES).toString("hex");

    /*
     * Step 4 — persist locally (encrypts secrets en route).
     */
    const persisted = await this.repo.create(input.saleorApiUrl, {
      saleorApiUrl: input.saleorApiUrl as ProviderConnectionCreateInput["saleorApiUrl"],
      name: input.name,
      fief: {
        baseUrl,
        tenantId,
        clientId: createFiefClientId(fiefClient.client_id),
        webhookId,
        clientSecret: fiefClient.client_secret,
        pendingClientSecret: null,
        adminToken: input.fief.adminToken,
        webhookSecret: webhook.secret,
        pendingWebhookSecret: null,
      },
      branding: {
        signingKey,
        allowedOrigins: input.branding.allowedOrigins,
      },
      claimMapping: input.claimMapping,
    });

    if (persisted.isErr()) {
      this.logger.error("Failed to persist provider connection — rolling back Fief side", {
        saleorApiUrl: input.saleorApiUrl,
        error: persisted.error,
      });
      await this.bestEffortDeleteWebhook(adminToken, webhookId);
      await this.bestEffortDeleteClient(adminToken, fiefClientUuid);

      return err(
        new CreateConnectionError.PersistFailed(
          "Failed to persist provider connection after Fief provisioning",
          { cause: persisted.error },
        ),
      );
    }

    const connection = persisted.value;

    /*
     * Step 5 — patch the webhook URL now that we know the connection id.
     * If this fails we DO NOT roll back: the connection is persisted and
     * usable for outbound (Saleor → Fief); only inbound webhooks would
     * misfire, which T34 (reconciliation tooling) can repair.
     */
    const patchResult = await this.fiefAdmin.updateWebhook(adminToken, webhookId, {
      url: appendConnectionIdQuery(input.webhookReceiverBaseUrl, connection.id),
    });

    if (patchResult.isErr()) {
      this.logger.error(
        "Created connection but failed to patch Fief webhook URL with connectionId — operator must run reconciliation",
        {
          connectionId: connection.id,
          webhookId,
          saleorApiUrl: input.saleorApiUrl,
          error: patchResult.error,
        },
      );
    }

    return ok(connection);
  }

  private async bestEffortDeleteClient(
    token: ReturnType<(typeof FiefAdminTokenSchema)["parse"]>,
    id: ReturnType<(typeof FiefClientIdSchema)["parse"]>,
  ): Promise<void> {
    const result = await this.fiefAdmin.deleteClient(token, id);

    if (result.isErr()) {
      this.logger.warn(
        "Best-effort Fief client cleanup failed; manual intervention may be needed",
        {
          clientId: id,
          error: result.error,
        },
      );
    }
  }

  private async bestEffortDeleteWebhook(
    token: ReturnType<(typeof FiefAdminTokenSchema)["parse"]>,
    id: ReturnType<(typeof FiefWebhookIdSchema)["parse"]>,
  ): Promise<void> {
    const result = await this.fiefAdmin.deleteWebhook(token, id);

    if (result.isErr()) {
      this.logger.warn(
        "Best-effort Fief webhook cleanup failed; manual intervention may be needed",
        {
          webhookId: id,
          error: result.error,
        },
      );
    }
  }
}

/**
 * Append `connectionId={id}` to a URL, preserving any existing query string.
 * Exported for the test suite — production callers go through the use case.
 */
export const appendConnectionIdQuery = (baseUrl: string, connectionId: string): string => {
  const separator = baseUrl.includes("?") ? "&" : "?";

  return `${baseUrl}${separator}connectionId=${encodeURIComponent(connectionId)}`;
};

// Re-export so callers don't need to import from a sibling module.
export { ProviderConnectionRepoError };
