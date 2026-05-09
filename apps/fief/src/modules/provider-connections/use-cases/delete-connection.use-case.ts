import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefAdminTokenSchema, FiefClientIdSchema } from "@/modules/fief-client/admin-api-types";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type ProviderConnectionId } from "../provider-connection";
import { type ProviderConnectionRepo } from "../provider-connection-repo";
import { type ProviderConnectionLifecycleError } from "./types";

/*
 * T17 — `DeleteConnectionUseCase`.
 *
 * Per PRD §F2.5 / T29: deletion is a **soft-delete** of the connection
 * (preserves `identity_map` rows for audit + revival), but **hard-delete**
 * of the Fief side (OIDC client + webhook subscriber). The Fief side has
 * no business surviving — leaving an orphaned OIDC client in Fief is a
 * security smell (an old admin token could still issue with it).
 *
 * Failure semantics
 * -----------------
 *
 * Fief deletes are best-effort. If the Fief client / webhook is already
 * gone (404), we treat that as success — we're trying to make the world
 * match our intent, not assert we were the agent that did so. Any other
 * Fief error short-circuits the local soft-delete: we don't want a stale
 * Fief client/webhook surviving an apparent successful delete on our side.
 *
 * If the local soft-delete fails AFTER Fief succeeded, the connection is
 * unreachable from the auth plane (Fief client gone) but still appears in
 * the operator UI with `softDeletedAt: null`. The operator can retry the
 * delete; the use case tolerates the second call (Fief 404 → ok, repo
 * soft-delete is idempotent).
 */

export const DeleteConnectionError = {
  NotFound: BaseError.subclass("DeleteConnectionNotFoundError", {
    props: { _brand: "FiefApp.DeleteConnection.NotFound" as const },
  }),
  FiefDeprovisioningFailed: BaseError.subclass("DeleteConnectionFiefDeprovisioningFailedError", {
    props: { _brand: "FiefApp.DeleteConnection.FiefDeprovisioningFailed" as const },
  }),
  PersistFailed: BaseError.subclass("DeleteConnectionPersistFailedError", {
    props: { _brand: "FiefApp.DeleteConnection.PersistFailed" as const },
  }),
};

export type DeleteConnectionError =
  | InstanceType<(typeof DeleteConnectionError)["NotFound"]>
  | InstanceType<(typeof DeleteConnectionError)["FiefDeprovisioningFailed"]>
  | InstanceType<(typeof DeleteConnectionError)["PersistFailed"]>;

export interface DeleteConnectionUseCaseInput {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
}

export interface DeleteConnectionUseCaseDeps {
  repo: ProviderConnectionRepo;
  fiefAdmin: FiefAdminApiClient;
}

export class DeleteConnectionUseCase {
  private readonly repo: ProviderConnectionRepo;
  private readonly fiefAdmin: FiefAdminApiClient;
  private readonly logger = createLogger("provider-connections.delete-connection");

  constructor(deps: DeleteConnectionUseCaseDeps) {
    this.repo = deps.repo;
    this.fiefAdmin = deps.fiefAdmin;
  }

  async execute(
    input: DeleteConnectionUseCaseInput,
  ): Promise<Result<void, ProviderConnectionLifecycleError>> {
    const existing = await this.repo.get({
      saleorApiUrl: input.saleorApiUrl,
      id: input.id,
      /*
       * We don't include soft-deleted here — calling delete on a soft-deleted
       * row is a no-op (idempotent). Operator can re-soft-delete with no work.
       */
    });

    if (existing.isErr()) {
      const cause = existing.error;

      if (cause.constructor.name === "ProviderConnectionNotFoundError") {
        return err(
          new DeleteConnectionError.NotFound(
            `provider_connection ${input.id} not found for ${input.saleorApiUrl}`,
            { cause },
          ),
        );
      }

      return err(
        new DeleteConnectionError.PersistFailed(
          "Failed to load provider_connection during delete",
          { cause },
        ),
      );
    }

    const connection = existing.value;
    const decrypted = await this.repo.getDecryptedSecrets({
      saleorApiUrl: input.saleorApiUrl,
      id: input.id,
    });

    if (decrypted.isErr()) {
      return err(
        new DeleteConnectionError.PersistFailed(
          "Failed to decrypt admin token while deleting connection",
          { cause: decrypted.error },
        ),
      );
    }

    const adminToken = FiefAdminTokenSchema.parse(decrypted.value.fief.adminToken);
    const fiefClientId = FiefClientIdSchema.parse(connection.fief.clientId);

    /*
     * Step 1 — delete the Fief OIDC client. 404 is treated as success
     * (already gone is the intent state). Any other failure aborts.
     */
    const clientDelete = await this.fiefAdmin.deleteClient(adminToken, fiefClientId);

    if (
      clientDelete.isErr() &&
      clientDelete.error.constructor.name !== "FiefAdminApiNotFoundError"
    ) {
      this.logger.error("Failed to delete Fief OIDC client during connection delete", {
        connectionId: input.id,
        clientId: fiefClientId,
        error: clientDelete.error,
      });

      return err(
        new DeleteConnectionError.FiefDeprovisioningFailed(
          "Failed to delete Fief OIDC client during connection delete",
          { cause: clientDelete.error },
        ),
      );
    }

    /*
     * Step 2 — delete the Fief webhook subscriber. Same 404-tolerant logic.
     * Skipped entirely for legacy connections that don't track a webhook id.
     */
    if (connection.fief.webhookId !== null) {
      const webhookDelete = await this.fiefAdmin.deleteWebhook(
        adminToken,
        connection.fief.webhookId,
      );

      if (
        webhookDelete.isErr() &&
        webhookDelete.error.constructor.name !== "FiefAdminApiNotFoundError"
      ) {
        this.logger.error("Failed to delete Fief webhook subscriber during connection delete", {
          connectionId: input.id,
          webhookId: connection.fief.webhookId,
          error: webhookDelete.error,
        });

        return err(
          new DeleteConnectionError.FiefDeprovisioningFailed(
            "Failed to delete Fief webhook subscriber during connection delete",
            { cause: webhookDelete.error },
          ),
        );
      }
    } else {
      this.logger.warn(
        "Connection has no Fief webhookId; skipping Fief webhook delete (legacy connection)",
        { connectionId: input.id },
      );
    }

    /*
     * Step 3 — soft-delete locally. Preserves identity_map per PRD §F2.5.
     */
    const softDelete = await this.repo.softDelete({
      saleorApiUrl: input.saleorApiUrl,
      id: input.id,
    });

    if (softDelete.isErr()) {
      const cause = softDelete.error;

      if (cause.constructor.name === "ProviderConnectionNotFoundError") {
        // Disappeared between our load and our soft-delete — treat as ok.
        return ok(undefined);
      }

      return err(
        new DeleteConnectionError.PersistFailed("Failed to soft-delete provider_connection", {
          cause,
        }),
      );
    }

    return ok(undefined);
  }
}
