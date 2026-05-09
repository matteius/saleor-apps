import { randomUUID } from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  createProviderConnectionId,
  type DecryptedProviderConnectionSecrets,
  type ProviderConnection,
  type ProviderConnectionCreateInput,
  type ProviderConnectionId,
  type ProviderConnectionUpdateInput,
} from "../provider-connection";
import {
  type GetProviderConnectionAccess,
  type ListProviderConnectionsAccess,
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "../provider-connection-repo";

/*
 * In-memory `ProviderConnectionRepo` for the T17 use-case tests.
 *
 * Stores a "shadow" plaintext map of secrets keyed by connection id so
 * `getDecryptedSecrets` round-trips cleanly without dragging in T4's real
 * encryptor. The persisted entity carries the encrypted brand on its
 * secret slots — to satisfy that brand we wrap the plaintext in a
 * `iv:cipher`-style placeholder that passes the schema's `min(1)` check.
 *
 * NOTE: not a production component; lives next to the use cases purely as
 * a test seam. Mongo-backed parity is exercised in the T8 repo test suite.
 */

const fakeCiphertext = (id: string, slot: string, value: string): string =>
  /*
   * Distinguish from real ciphertext (which is `${ivHex}:${cipherHex}`) to
   * make accidental cross-pollination obvious in test failures.
   */
  `inmem:${id}:${slot}:${Buffer.from(value, "utf-8").toString("base64")}`;

export class InMemoryProviderConnectionRepo implements ProviderConnectionRepo {
  private readonly connections: Map<string, ProviderConnection> = new Map();
  private readonly plaintextSecrets: Map<string, DecryptedProviderConnectionSecrets> = new Map();

  /** Test helper: peek at the persisted entity without going through `get()`. */
  peek(id: ProviderConnectionId): ProviderConnection | undefined {
    return this.connections.get(id as unknown as string);
  }

  async create(
    saleorApiUrl: SaleorApiUrl,
    input: ProviderConnectionCreateInput,
  ): Promise<
    Result<ProviderConnection, InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>>
  > {
    const id = createProviderConnectionId(randomUUID());
    const idStr = id as unknown as string;

    const entity: ProviderConnection = {
      id,
      saleorApiUrl,
      name: input.name,
      fief: {
        baseUrl: input.fief.baseUrl,
        tenantId: input.fief.tenantId,
        clientId: input.fief.clientId,
        webhookId: input.fief.webhookId ?? null,
        encryptedClientSecret: fakeCiphertext(
          idStr,
          "clientSecret",
          input.fief.clientSecret,
        ) as ProviderConnection["fief"]["encryptedClientSecret"],
        encryptedPendingClientSecret:
          input.fief.pendingClientSecret == null
            ? null
            : (fakeCiphertext(
                idStr,
                "pendingClientSecret",
                input.fief.pendingClientSecret,
              ) as ProviderConnection["fief"]["encryptedClientSecret"]),
        encryptedAdminToken: fakeCiphertext(
          idStr,
          "adminToken",
          input.fief.adminToken,
        ) as ProviderConnection["fief"]["encryptedAdminToken"],
        encryptedWebhookSecret: fakeCiphertext(
          idStr,
          "webhookSecret",
          input.fief.webhookSecret,
        ) as ProviderConnection["fief"]["encryptedWebhookSecret"],
        encryptedPendingWebhookSecret:
          input.fief.pendingWebhookSecret == null
            ? null
            : (fakeCiphertext(
                idStr,
                "pendingWebhookSecret",
                input.fief.pendingWebhookSecret,
              ) as ProviderConnection["fief"]["encryptedWebhookSecret"]),
      },
      branding: {
        encryptedSigningKey: fakeCiphertext(
          idStr,
          "signingKey",
          input.branding.signingKey,
        ) as ProviderConnection["branding"]["encryptedSigningKey"],
        allowedOrigins: [...input.branding.allowedOrigins],
      },
      claimMapping: input.claimMapping.map((entry) => ({ ...entry })),
      softDeletedAt: null,
    };

    this.connections.set(idStr, entity);
    this.plaintextSecrets.set(idStr, {
      fief: {
        clientSecret: input.fief.clientSecret,
        pendingClientSecret: input.fief.pendingClientSecret ?? null,
        adminToken: input.fief.adminToken,
        webhookSecret: input.fief.webhookSecret,
        pendingWebhookSecret: input.fief.pendingWebhookSecret ?? null,
      },
      branding: {
        signingKey: input.branding.signingKey,
      },
    });

    return ok(entity);
  }

  async get(
    access: GetProviderConnectionAccess,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    const entity = this.connections.get(access.id as unknown as string);

    if (!entity || entity.saleorApiUrl !== access.saleorApiUrl) {
      return err(
        new ProviderConnectionRepoError.NotFound(`provider_connection ${access.id} not found`),
      );
    }

    if (entity.softDeletedAt !== null && !access.includeSoftDeleted) {
      return err(
        new ProviderConnectionRepoError.NotFound(
          `provider_connection ${access.id} is soft-deleted`,
        ),
      );
    }

    return ok(entity);
  }

  async list(
    access: ListProviderConnectionsAccess,
  ): Promise<
    Result<
      ProviderConnection[],
      InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    const all = [...this.connections.values()].filter(
      (c) => c.saleorApiUrl === access.saleorApiUrl,
    );

    return ok(access.includeSoftDeleted ? all : all.filter((c) => c.softDeletedAt === null));
  }

  async update(
    access: { saleorApiUrl: SaleorApiUrl; id: ProviderConnectionId },
    patch: ProviderConnectionUpdateInput,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  > {
    const idStr = access.id as unknown as string;
    const entity = this.connections.get(idStr);

    if (!entity || entity.saleorApiUrl !== access.saleorApiUrl) {
      return err(
        new ProviderConnectionRepoError.NotFound(`provider_connection ${access.id} not found`),
      );
    }

    const plaintext = this.plaintextSecrets.get(idStr) ?? {
      fief: {
        clientSecret: "",
        pendingClientSecret: null,
        adminToken: "",
        webhookSecret: "",
        pendingWebhookSecret: null,
      },
      branding: { signingKey: "" },
    };

    const updated: ProviderConnection = {
      ...entity,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      fief: {
        ...entity.fief,
        ...(patch.fief?.baseUrl !== undefined ? { baseUrl: patch.fief.baseUrl } : {}),
        ...(patch.fief?.tenantId !== undefined ? { tenantId: patch.fief.tenantId } : {}),
        ...(patch.fief?.clientId !== undefined ? { clientId: patch.fief.clientId } : {}),
        ...(patch.fief?.webhookId !== undefined ? { webhookId: patch.fief.webhookId } : {}),
        ...(patch.fief?.clientSecret !== undefined
          ? {
              encryptedClientSecret: fakeCiphertext(
                idStr,
                "clientSecret",
                patch.fief.clientSecret,
              ) as ProviderConnection["fief"]["encryptedClientSecret"],
            }
          : {}),
        ...(patch.fief?.pendingClientSecret !== undefined
          ? {
              encryptedPendingClientSecret:
                patch.fief.pendingClientSecret === null
                  ? null
                  : (fakeCiphertext(
                      idStr,
                      "pendingClientSecret",
                      patch.fief.pendingClientSecret,
                    ) as ProviderConnection["fief"]["encryptedClientSecret"]),
            }
          : {}),
        ...(patch.fief?.adminToken !== undefined
          ? {
              encryptedAdminToken: fakeCiphertext(
                idStr,
                "adminToken",
                patch.fief.adminToken,
              ) as ProviderConnection["fief"]["encryptedAdminToken"],
            }
          : {}),
        ...(patch.fief?.webhookSecret !== undefined
          ? {
              encryptedWebhookSecret: fakeCiphertext(
                idStr,
                "webhookSecret",
                patch.fief.webhookSecret,
              ) as ProviderConnection["fief"]["encryptedWebhookSecret"],
            }
          : {}),
        ...(patch.fief?.pendingWebhookSecret !== undefined
          ? {
              encryptedPendingWebhookSecret:
                patch.fief.pendingWebhookSecret === null
                  ? null
                  : (fakeCiphertext(
                      idStr,
                      "pendingWebhookSecret",
                      patch.fief.pendingWebhookSecret,
                    ) as ProviderConnection["fief"]["encryptedWebhookSecret"]),
            }
          : {}),
      },
      branding: {
        ...entity.branding,
        ...(patch.branding?.signingKey !== undefined
          ? {
              encryptedSigningKey: fakeCiphertext(
                idStr,
                "signingKey",
                patch.branding.signingKey,
              ) as ProviderConnection["branding"]["encryptedSigningKey"],
            }
          : {}),
        ...(patch.branding?.allowedOrigins !== undefined
          ? { allowedOrigins: [...patch.branding.allowedOrigins] }
          : {}),
      },
      ...(patch.claimMapping !== undefined
        ? { claimMapping: patch.claimMapping.map((entry) => ({ ...entry })) }
        : {}),
    };

    this.connections.set(idStr, updated);

    // Mirror plaintext updates so getDecryptedSecrets round-trips.
    if (patch.fief) {
      const next = { ...plaintext.fief };

      if (patch.fief.clientSecret !== undefined) next.clientSecret = patch.fief.clientSecret;
      if (patch.fief.pendingClientSecret !== undefined)
        next.pendingClientSecret = patch.fief.pendingClientSecret;
      if (patch.fief.adminToken !== undefined) next.adminToken = patch.fief.adminToken;
      if (patch.fief.webhookSecret !== undefined) next.webhookSecret = patch.fief.webhookSecret;
      if (patch.fief.pendingWebhookSecret !== undefined)
        next.pendingWebhookSecret = patch.fief.pendingWebhookSecret;
      this.plaintextSecrets.set(idStr, { ...plaintext, fief: next });
    }
    if (patch.branding?.signingKey !== undefined) {
      this.plaintextSecrets.set(idStr, {
        ...this.plaintextSecrets.get(idStr)!,
        branding: { signingKey: patch.branding.signingKey },
      });
    }

    return ok(updated);
  }

  async softDelete(access: {
    saleorApiUrl: SaleorApiUrl;
    id: ProviderConnectionId;
  }): Promise<
    Result<
      void,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDeleting"]>
    >
  > {
    const idStr = access.id as unknown as string;
    const entity = this.connections.get(idStr);

    if (!entity || entity.saleorApiUrl !== access.saleorApiUrl) {
      return err(
        new ProviderConnectionRepoError.NotFound(`provider_connection ${access.id} not found`),
      );
    }

    this.connections.set(idStr, { ...entity, softDeletedAt: new Date() });

    return ok(undefined);
  }

  async restore(access: {
    saleorApiUrl: SaleorApiUrl;
    id: ProviderConnectionId;
  }): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  > {
    const idStr = access.id as unknown as string;
    const entity = this.connections.get(idStr);

    if (!entity || entity.saleorApiUrl !== access.saleorApiUrl) {
      return err(
        new ProviderConnectionRepoError.NotFound(`provider_connection ${access.id} not found`),
      );
    }

    const restored = { ...entity, softDeletedAt: null };

    this.connections.set(idStr, restored);

    return ok(restored);
  }

  async getDecryptedSecrets(
    access: GetProviderConnectionAccess,
  ): Promise<
    Result<
      DecryptedProviderConnectionSecrets,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>
    >
  > {
    const fetched = await this.get(access);

    if (fetched.isErr()) return err(fetched.error);

    const plaintext = this.plaintextSecrets.get(access.id as unknown as string);

    if (!plaintext) {
      return err(
        new ProviderConnectionRepoError.FailureDecrypting(
          "in-memory repo: no plaintext shadow for connection",
        ),
      );
    }

    return ok(plaintext);
  }
}
