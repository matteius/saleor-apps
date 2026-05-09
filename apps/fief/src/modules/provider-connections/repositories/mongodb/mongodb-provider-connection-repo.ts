import { randomUUID } from "node:crypto";

import { type Collection, type Filter, type ObjectId } from "mongodb";
import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { createFiefEncryptor, type RotatingFiefEncryptor } from "@/modules/crypto/encryptor";
import { getMongoClient, getMongoDatabaseName } from "@/modules/db/mongo-client";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  createEncryptedSecret,
  createProviderConnectionId,
  type DecryptedProviderConnectionSecrets,
  parseProviderConnection,
  type ProviderConnection,
  type ProviderConnectionCreateInput,
  type ProviderConnectionId,
  type ProviderConnectionUpdateInput,
} from "../../provider-connection";
import {
  type GetProviderConnectionAccess,
  type ListProviderConnectionsAccess,
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "../../provider-connection-repo";

/*
 * T8 — MongoDB-backed `ProviderConnectionRepo`.
 *
 * Implementation notes:
 *
 *   - Collection: `provider_connections`. Indexes are managed by the T53
 *     migration runner via `migrations.ts` in this directory — the repo does
 *     NOT create indexes lazily so we don't race with rolling-deploy boots.
 *
 *   - Encryption: every secret slot in `ProviderConnectionCreateInput` /
 *     `ProviderConnectionUpdateInput` carries plaintext; the repo runs each
 *     value through `RotatingFiefEncryptor.encrypt()` and stores the
 *     ciphertext. Reads return the encrypted shape; `getDecryptedSecrets()`
 *     is the only path that returns plaintext, and it's wrapped in a
 *     `Result` so logs that auto-format errors don't accidentally serialize
 *     plaintext.
 *
 *   - Soft-delete: `softDelete()` writes a `Date` to `softDeletedAt`. List /
 *     get exclude soft-deleted by default; callers opt in via
 *     `includeSoftDeleted: true`.
 *
 *   - Patch semantics on `update()`: only the secret slots present in the
 *     patch are re-encrypted. This avoids the "fetch → decrypt → mutate →
 *     re-encrypt" anti-pattern where every update would unnecessarily roll
 *     over the ciphertext (and obscure the real key-version state).
 */

const COLLECTION_NAME = "provider_connections";

const logger = createLogger("MongodbProviderConnectionRepo");

/** Mongo document shape — branded types collapsed to raw strings on the wire. */
interface MongoProviderConnectionDoc {
  _id?: ObjectId;
  id: string;
  saleorApiUrl: string;
  name: string;
  fief: {
    baseUrl: string;
    tenantId: string;
    clientId: string;
    encryptedClientSecret: string;
    encryptedPendingClientSecret: string | null;
    encryptedAdminToken: string;
    encryptedWebhookSecret: string;
    encryptedPendingWebhookSecret: string | null;
  };
  branding: {
    encryptedSigningKey: string;
    allowedOrigins: string[];
  };
  claimMapping: Array<{ fiefClaim: string; saleorMetadataKey: string; required: boolean }>;
  softDeletedAt: Date | null;
}

/**
 * Strip the Mongo-internal `_id` and run the rest through the schema parser
 * so the returned entity has the proper branded types attached.
 */
function docToEntity(
  raw: MongoProviderConnectionDoc,
): Result<
  ProviderConnection,
  InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
> {
  const { _id, ...rest } = raw;

  // Touch `_id` so lint can't flag it as unused — we intentionally drop it.
  void _id;

  const parsed = parseProviderConnection(rest);

  if (parsed.isErr()) {
    return err(
      new ProviderConnectionRepoError.FailureFetching(
        "Stored provider_connection failed schema validation",
        { cause: parsed.error },
      ),
    );
  }

  return ok(parsed.value);
}

export class MongodbProviderConnectionRepo implements ProviderConnectionRepo {
  private readonly encryptor: RotatingFiefEncryptor;
  private collectionPromise: Promise<Collection<MongoProviderConnectionDoc>> | null = null;

  /**
   * `encryptor` is injectable so unit tests can substitute a deterministic
   * one. Production callers leave it `undefined` and the constructor builds
   * the env-driven singleton via `createFiefEncryptor()`.
   */
  constructor(encryptor?: RotatingFiefEncryptor) {
    this.encryptor = encryptor ?? createFiefEncryptor();
  }

  private async getCollection(): Promise<Collection<MongoProviderConnectionDoc>> {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    this.collectionPromise = (async () => {
      const client = await getMongoClient();
      const db = client.db(getMongoDatabaseName());

      return db.collection<MongoProviderConnectionDoc>(COLLECTION_NAME);
    })();

    return this.collectionPromise;
  }

  async create(
    saleorApiUrl: SaleorApiUrl,
    input: ProviderConnectionCreateInput,
  ): Promise<
    Result<ProviderConnection, InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>>
  > {
    try {
      const collection = await this.getCollection();
      const id = createProviderConnectionId(randomUUID());

      const doc: MongoProviderConnectionDoc = {
        id,
        saleorApiUrl,
        name: input.name,
        fief: {
          baseUrl: input.fief.baseUrl,
          tenantId: input.fief.tenantId,
          clientId: input.fief.clientId,
          encryptedClientSecret: this.encryptor.encrypt(input.fief.clientSecret).ciphertext,
          encryptedPendingClientSecret:
            input.fief.pendingClientSecret == null
              ? null
              : this.encryptor.encrypt(input.fief.pendingClientSecret).ciphertext,
          encryptedAdminToken: this.encryptor.encrypt(input.fief.adminToken).ciphertext,
          encryptedWebhookSecret: this.encryptor.encrypt(input.fief.webhookSecret).ciphertext,
          encryptedPendingWebhookSecret:
            input.fief.pendingWebhookSecret == null
              ? null
              : this.encryptor.encrypt(input.fief.pendingWebhookSecret).ciphertext,
        },
        branding: {
          encryptedSigningKey: this.encryptor.encrypt(input.branding.signingKey).ciphertext,
          allowedOrigins: input.branding.allowedOrigins.map((origin) => origin.toString()),
        },
        claimMapping: input.claimMapping.map((entry) => ({
          fiefClaim: entry.fiefClaim,
          saleorMetadataKey: entry.saleorMetadataKey,
          required: entry.required,
        })),
        softDeletedAt: null,
      };

      await collection.insertOne(doc);

      const entity = docToEntity(doc);

      if (entity.isErr()) {
        return err(
          new ProviderConnectionRepoError.FailureSaving(
            "Inserted provider_connection failed re-validation",
            { cause: entity.error },
          ),
        );
      }

      logger.info("created provider_connection", {
        connectionId: id,
        saleorApiUrl,
      });

      return ok(entity.value);
    } catch (cause) {
      logger.error("failed to create provider_connection", {
        saleorApiUrl,
        error: cause instanceof Error ? cause.message : String(cause),
      });

      return err(
        new ProviderConnectionRepoError.FailureSaving("Failed to insert provider_connection", {
          cause,
        }),
      );
    }
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
    try {
      const collection = await this.getCollection();
      const filter: Filter<MongoProviderConnectionDoc> = {
        saleorApiUrl: access.saleorApiUrl,
        id: access.id,
      };

      if (!access.includeSoftDeleted) {
        filter.softDeletedAt = null;
      }

      const raw = await collection.findOne(filter);

      if (!raw) {
        return err(
          new ProviderConnectionRepoError.NotFound(
            `provider_connection ${access.id} not found for ${access.saleorApiUrl}`,
          ),
        );
      }

      return docToEntity(raw);
    } catch (cause) {
      return err(
        new ProviderConnectionRepoError.FailureFetching(
          "Failed to fetch provider_connection from MongoDB",
          { cause },
        ),
      );
    }
  }

  async list(
    access: ListProviderConnectionsAccess,
  ): Promise<
    Result<
      ProviderConnection[],
      InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    try {
      const collection = await this.getCollection();
      const filter: Filter<MongoProviderConnectionDoc> = {
        saleorApiUrl: access.saleorApiUrl,
      };

      if (!access.includeSoftDeleted) {
        filter.softDeletedAt = null;
      }

      const raws = await collection.find(filter).toArray();
      const entities: ProviderConnection[] = [];

      for (const raw of raws) {
        const entity = docToEntity(raw);

        if (entity.isErr()) {
          return err(entity.error);
        }
        entities.push(entity.value);
      }

      return ok(entities);
    } catch (cause) {
      return err(
        new ProviderConnectionRepoError.FailureFetching(
          "Failed to list provider_connections from MongoDB",
          { cause },
        ),
      );
    }
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
    try {
      const collection = await this.getCollection();

      /*
       * `set` is built up from the patch — Mongo dotted paths so we don't
       * overwrite the entire `fief` / `branding` sub-object.
       */
      const set: Record<string, unknown> = {};

      if (patch.name !== undefined) {
        set.name = patch.name;
      }

      if (patch.claimMapping !== undefined) {
        set.claimMapping = patch.claimMapping.map((entry) => ({
          fiefClaim: entry.fiefClaim,
          saleorMetadataKey: entry.saleorMetadataKey,
          required: entry.required,
        }));
      }

      if (patch.fief) {
        if (patch.fief.baseUrl !== undefined) {
          set["fief.baseUrl"] = patch.fief.baseUrl;
        }
        if (patch.fief.tenantId !== undefined) {
          set["fief.tenantId"] = patch.fief.tenantId;
        }
        if (patch.fief.clientId !== undefined) {
          set["fief.clientId"] = patch.fief.clientId;
        }
        if (patch.fief.clientSecret !== undefined) {
          set["fief.encryptedClientSecret"] = this.encryptor.encrypt(
            patch.fief.clientSecret,
          ).ciphertext;
        }
        if (patch.fief.pendingClientSecret !== undefined) {
          set["fief.encryptedPendingClientSecret"] =
            patch.fief.pendingClientSecret === null
              ? null
              : this.encryptor.encrypt(patch.fief.pendingClientSecret).ciphertext;
        }
        if (patch.fief.adminToken !== undefined) {
          set["fief.encryptedAdminToken"] = this.encryptor.encrypt(
            patch.fief.adminToken,
          ).ciphertext;
        }
        if (patch.fief.webhookSecret !== undefined) {
          set["fief.encryptedWebhookSecret"] = this.encryptor.encrypt(
            patch.fief.webhookSecret,
          ).ciphertext;
        }
        if (patch.fief.pendingWebhookSecret !== undefined) {
          set["fief.encryptedPendingWebhookSecret"] =
            patch.fief.pendingWebhookSecret === null
              ? null
              : this.encryptor.encrypt(patch.fief.pendingWebhookSecret).ciphertext;
        }
      }

      if (patch.branding) {
        if (patch.branding.signingKey !== undefined) {
          set["branding.encryptedSigningKey"] = this.encryptor.encrypt(
            patch.branding.signingKey,
          ).ciphertext;
        }
        if (patch.branding.allowedOrigins !== undefined) {
          set["branding.allowedOrigins"] = patch.branding.allowedOrigins.map((o) => o.toString());
        }
      }

      const result = await collection.findOneAndUpdate(
        { saleorApiUrl: access.saleorApiUrl, id: access.id },
        Object.keys(set).length > 0 ? { $set: set } : { $set: {} },
        { returnDocument: "after" },
      );

      if (!result) {
        return err(
          new ProviderConnectionRepoError.NotFound(
            `provider_connection ${access.id} not found for ${access.saleorApiUrl}`,
          ),
        );
      }

      const entity = docToEntity(result);

      if (entity.isErr()) {
        return err(
          new ProviderConnectionRepoError.FailureSaving(
            "Updated provider_connection failed re-validation",
            { cause: entity.error },
          ),
        );
      }

      return ok(entity.value);
    } catch (cause) {
      return err(
        new ProviderConnectionRepoError.FailureSaving("Failed to update provider_connection", {
          cause,
        }),
      );
    }
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
    try {
      const collection = await this.getCollection();

      const result = await collection.updateOne(
        { saleorApiUrl: access.saleorApiUrl, id: access.id },
        { $set: { softDeletedAt: new Date() } },
      );

      if (result.matchedCount === 0) {
        return err(
          new ProviderConnectionRepoError.NotFound(
            `provider_connection ${access.id} not found for ${access.saleorApiUrl}`,
          ),
        );
      }

      return ok(undefined);
    } catch (cause) {
      return err(
        new ProviderConnectionRepoError.FailureDeleting(
          "Failed to soft-delete provider_connection",
          { cause },
        ),
      );
    }
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
    try {
      const collection = await this.getCollection();

      const result = await collection.findOneAndUpdate(
        { saleorApiUrl: access.saleorApiUrl, id: access.id },
        { $set: { softDeletedAt: null } },
        { returnDocument: "after" },
      );

      if (!result) {
        return err(
          new ProviderConnectionRepoError.NotFound(
            `provider_connection ${access.id} not found for ${access.saleorApiUrl}`,
          ),
        );
      }

      return docToEntity(result).mapErr(
        (cause) =>
          new ProviderConnectionRepoError.FailureSaving(
            "Restored provider_connection failed re-validation",
            { cause },
          ),
      );
    } catch (cause) {
      return err(
        new ProviderConnectionRepoError.FailureSaving("Failed to restore provider_connection", {
          cause,
        }),
      );
    }
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

    if (fetched.isErr()) {
      return err(fetched.error);
    }

    const conn = fetched.value;

    /*
     * Decrypt each slot via T4's `RotatingFiefEncryptor`. Any failure short-
     * circuits with a `FailureDecrypting` error — we explicitly do NOT log
     * the plaintext (or even attempt to format the error with details that
     * could leak ciphertext) to keep the secret material out of structured
     * logs.
     */
    const tryDecrypt = (
      ciphertext: string,
    ): Result<string, InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>> => {
      const decrypted = this.encryptor.decrypt(ciphertext);

      if (decrypted.isErr()) {
        return err(
          new ProviderConnectionRepoError.FailureDecrypting(
            "Failed to decrypt provider_connection secret slot",
            { cause: decrypted.error },
          ),
        );
      }

      return ok(decrypted.value.plaintext);
    };

    const tryDecryptNullable = (
      ciphertext: string | null,
    ): Result<
      string | null,
      InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>
    > => {
      if (ciphertext === null) {
        return ok(null);
      }

      return tryDecrypt(ciphertext);
    };

    const clientSecret = tryDecrypt(conn.fief.encryptedClientSecret);

    if (clientSecret.isErr()) return err(clientSecret.error);
    const pendingClientSecret = tryDecryptNullable(conn.fief.encryptedPendingClientSecret);

    if (pendingClientSecret.isErr()) return err(pendingClientSecret.error);
    const adminToken = tryDecrypt(conn.fief.encryptedAdminToken);

    if (adminToken.isErr()) return err(adminToken.error);
    const webhookSecret = tryDecrypt(conn.fief.encryptedWebhookSecret);

    if (webhookSecret.isErr()) return err(webhookSecret.error);
    const pendingWebhookSecret = tryDecryptNullable(conn.fief.encryptedPendingWebhookSecret);

    if (pendingWebhookSecret.isErr()) return err(pendingWebhookSecret.error);
    const signingKey = tryDecrypt(conn.branding.encryptedSigningKey);

    if (signingKey.isErr()) return err(signingKey.error);

    return ok({
      fief: {
        clientSecret: clientSecret.value,
        pendingClientSecret: pendingClientSecret.value,
        adminToken: adminToken.value,
        webhookSecret: webhookSecret.value,
        pendingWebhookSecret: pendingWebhookSecret.value,
      },
      branding: {
        signingKey: signingKey.value,
      },
    });
  }
}

/*
 * Touch the `createEncryptedSecret` re-export so it's reachable from external
 * modules — used by tests/admin tooling that constructs entities directly.
 */
void createEncryptedSecret;
