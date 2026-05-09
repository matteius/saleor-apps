import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefAdminTokenSchema, FiefClientIdSchema } from "@/modules/fief-client/admin-api-types";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type AllowedOrigin,
  type ClaimMappingEntry,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderConnectionName,
} from "../provider-connection";
import { type ProviderConnectionRepo } from "../provider-connection-repo";
import { type ProviderConnectionLifecycleError } from "./types";

/*
 * T17 — `UpdateConnectionUseCase`.
 *
 * Patches mutable fields on a connection. Specifically does NOT expose the
 * encrypted-secret slots — those live behind `RotateConnectionSecretUseCase`
 * so the audit trail for a secret-roll is explicit + the dual-secret window
 * is enforced.
 *
 * Side-effect on Fief: when `branding.allowedOrigins` is patched we mirror
 * the change to the Fief OIDC client's `redirect_uris` so authorization
 * codes redirect back to an URL the operator approved. We treat the storefront
 * origin and the redirect URI host as the same trust boundary; if they ever
 * need to diverge we'll add a separate field.
 */

export const UpdateConnectionError = {
  NotFound: BaseError.subclass("UpdateConnectionNotFoundError", {
    props: { _brand: "FiefApp.UpdateConnection.NotFound" as const },
  }),
  FiefSyncFailed: BaseError.subclass("UpdateConnectionFiefSyncFailedError", {
    props: { _brand: "FiefApp.UpdateConnection.FiefSyncFailed" as const },
  }),
  PersistFailed: BaseError.subclass("UpdateConnectionPersistFailedError", {
    props: { _brand: "FiefApp.UpdateConnection.PersistFailed" as const },
  }),
};

export type UpdateConnectionError =
  | InstanceType<(typeof UpdateConnectionError)["NotFound"]>
  | InstanceType<(typeof UpdateConnectionError)["FiefSyncFailed"]>
  | InstanceType<(typeof UpdateConnectionError)["PersistFailed"]>;

export interface UpdateConnectionUseCaseInput {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
  patch: {
    name?: ProviderConnectionName;
    branding?: {
      allowedOrigins?: AllowedOrigin[];
    };
    claimMapping?: ClaimMappingEntry[];
  };
}

export interface UpdateConnectionUseCaseDeps {
  repo: ProviderConnectionRepo;
  fiefAdmin: FiefAdminApiClient;
}

export class UpdateConnectionUseCase {
  private readonly repo: ProviderConnectionRepo;
  private readonly fiefAdmin: FiefAdminApiClient;
  private readonly logger = createLogger("provider-connections.update-connection");

  constructor(deps: UpdateConnectionUseCaseDeps) {
    this.repo = deps.repo;
    this.fiefAdmin = deps.fiefAdmin;
  }

  async execute(
    input: UpdateConnectionUseCaseInput,
  ): Promise<Result<ProviderConnection, ProviderConnectionLifecycleError>> {
    /*
     * Load existing — needed both to surface a clean NotFound and to access
     * the encrypted admin token + Fief clientId for the redirect-URI patch.
     */
    const existing = await this.repo.get({
      saleorApiUrl: input.saleorApiUrl,
      id: input.id,
    });

    if (existing.isErr()) {
      // Repo's NotFound surfaces directly; FailureFetching wraps as PersistFailed.
      const cause = existing.error;

      if (cause.constructor.name === "ProviderConnectionNotFoundError") {
        return err(
          new UpdateConnectionError.NotFound(
            `provider_connection ${input.id} not found for ${input.saleorApiUrl}`,
            { cause },
          ),
        );
      }

      return err(
        new UpdateConnectionError.PersistFailed(
          "Failed to load existing provider_connection for update",
          { cause },
        ),
      );
    }

    const connection = existing.value;
    const newOrigins = input.patch.branding?.allowedOrigins;

    /*
     * Decide if a Fief-side patch is required. We compare to the previously
     * stored origins and skip the network call when nothing changed.
     */
    const originsChanged =
      newOrigins !== undefined && !sameOrigins(connection.branding.allowedOrigins, newOrigins);

    if (originsChanged) {
      const decrypted = await this.repo.getDecryptedSecrets({
        saleorApiUrl: input.saleorApiUrl,
        id: input.id,
      });

      if (decrypted.isErr()) {
        return err(
          new UpdateConnectionError.PersistFailed(
            "Failed to decrypt admin token while updating Fief redirect URIs",
            { cause: decrypted.error },
          ),
        );
      }

      const adminToken = FiefAdminTokenSchema.parse(decrypted.value.fief.adminToken);
      const fiefClientId = FiefClientIdSchema.parse(connection.fief.clientId);
      const redirectUris = newOrigins!.map((origin) => origin.toString());

      const patchResult = await this.fiefAdmin.updateClient(adminToken, fiefClientId, {
        redirect_uris: redirectUris,
      });

      if (patchResult.isErr()) {
        this.logger.error("Failed to patch Fief client redirect_uris on origin update", {
          connectionId: input.id,
          error: patchResult.error,
        });

        return err(
          new UpdateConnectionError.FiefSyncFailed(
            "Failed to update Fief OIDC client redirect_uris",
            { cause: patchResult.error },
          ),
        );
      }
    }

    /*
     * Persist the local patch. We pass the original branding/claim-mapping
     * objects through the repo so the secret slots stay untouched (the
     * repo's update() only re-encrypts slots present in the patch).
     */
    const persisted = await this.repo.update(
      { saleorApiUrl: input.saleorApiUrl, id: input.id },
      {
        ...(input.patch.name !== undefined ? { name: input.patch.name } : {}),
        ...(input.patch.branding?.allowedOrigins !== undefined
          ? { branding: { allowedOrigins: input.patch.branding.allowedOrigins } }
          : {}),
        ...(input.patch.claimMapping !== undefined
          ? { claimMapping: input.patch.claimMapping }
          : {}),
      },
    );

    if (persisted.isErr()) {
      const cause = persisted.error;

      if (cause.constructor.name === "ProviderConnectionNotFoundError") {
        return err(
          new UpdateConnectionError.NotFound(
            `provider_connection ${input.id} disappeared mid-update`,
            { cause },
          ),
        );
      }

      return err(
        new UpdateConnectionError.PersistFailed("Failed to persist provider_connection update", {
          cause,
        }),
      );
    }

    return ok(persisted.value);
  }
}

const sameOrigins = (a: readonly AllowedOrigin[], b: readonly AllowedOrigin[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedA = [...a].map((o) => o.toString()).sort();
  const sortedB = [...b].map((o) => o.toString()).sort();

  for (let i = 0; i < sortedA.length; i += 1) {
    if (sortedA[i] !== sortedB[i]) return false;
  }

  return true;
};
