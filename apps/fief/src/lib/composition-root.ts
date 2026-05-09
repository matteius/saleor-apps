import { err } from "neverthrow";

import { saleorApp } from "@/lib/saleor-app";
import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import {
  ChannelResolver,
  createChannelResolverCache,
} from "@/modules/channel-configuration/channel-resolver";
import { MongoChannelConfigurationRepo } from "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo";
import { createFiefEncryptor, type RotatingFiefEncryptor } from "@/modules/crypto/encryptor";
import { FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { type FiefBaseUrl } from "@/modules/fief-client/admin-api-types";
import { FiefOidcClient } from "@/modules/fief-client/oidc-client";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { MongoIdentityMapRepo } from "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo";
import { type ProviderConnection } from "@/modules/provider-connections/provider-connection";
import {
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "@/modules/provider-connections/provider-connection-repo";
import { MongodbProviderConnectionRepo } from "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo";
import { type FindConnectionById } from "@/modules/sync/fief-to-saleor/receiver";
import { createSaleorGraphQLCustomerClient } from "@/modules/sync/fief-to-saleor/saleor-graphql-client";
import { type SaleorCustomerClient } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";
import { MongodbWebhookLogRepo } from "@/modules/webhook-log/repositories/mongodb/mongodb-webhook-log-repo";
import { type WebhookLogRepo } from "@/modules/webhook-log/webhook-log-repo";

/*
 * T40 wire-up — central composition root.
 *
 * Wires the production object graph the auth-plane endpoints (T18-T22) need:
 *
 *   - Mongo client singleton (T3) — held inside the repo instances; this
 *     module never creates a second one.
 *   - Encryption (T4) — process-cached `RotatingFiefEncryptor` so every repo
 *     observes the same key-rotation state without re-reading env.
 *   - Storage repos:
 *       * `MongodbProviderConnectionRepo`     (T8)
 *       * `MongoChannelConfigurationRepo`     (T9)
 *       * `MongoIdentityMapRepo`              (T10)
 *       * `MongodbWebhookLogRepo`             (T11)
 *   - `ChannelResolver` (T12) factory — *per request* because T12 uses
 *     `createChannelResolverCache()` to memo-share repo round-trips within a
 *     single handler invocation. We expose a thunk so the route handler can
 *     get a freshly-cached resolver per call without sharing a stale cache.
 *   - Fief client factories:
 *       * `oidcClientFactory(connection)`  → cached by `connection.fief.baseUrl`
 *         (T6 instances are designed to live for the process lifetime; one per
 *         tenant base URL keeps discovery + JWKS hot for every connection
 *         without an unbounded leak).
 *       * `adminClientFactory(connection)` → cached by `connection.fief.baseUrl`
 *         (T5 stateless retry config; same caching policy).
 *   - `findConnectionById` cross-tenant lookup helper consumed by the T22
 *     receiver. Implemented here as the only place that knows it's safe to
 *     scan across `saleorApiUrl` (the Fief webhook URL only carries the
 *     connectionId, so the receiver can't be tenant-scoped at this seam).
 *   - `SaleorCustomerClient` placeholder — production wiring for T7's GraphQL
 *     mutations is intentionally out of scope for T40; the auth-plane integration
 *     suite stubs this client and the unit tests for T19 already cover its
 *     contract. The placeholder throws on call so an under-provisioned
 *     production environment fails loud rather than 500ing with `undefined.method`.
 *
 * The graph is **process-cached** inside `getProductionDeps()` — every call
 * returns the same wrapper object with the same repo instances, while
 * `channelResolver` is a thunk so each request gets a fresh per-request cache.
 *
 * Tests must NEVER call `getProductionDeps()` directly — they `vi.mock(...)`
 * the consuming `build-deps.ts` / `deps.ts` files so the route HTTP-translation
 * logic stays exercised without standing up Mongo.
 */

export interface ProductionDeps {
  /** Encryptor singleton — shared by every repo + ad-hoc decrypt sites. */
  encryptor: RotatingFiefEncryptor;
  /** Provider-connection repo (T8). Process-cached. */
  connectionRepo: ProviderConnectionRepo;
  /** Channel-configuration repo (T9). Process-cached. */
  channelConfigurationRepo: IChannelConfigurationRepo;
  /** Identity-map repo (T10). Process-cached. */
  identityMapRepo: IdentityMapRepo;
  /** Webhook-log repo (T11). Process-cached. */
  webhookLogRepo: WebhookLogRepo;
  /**
   * Channel resolver factory (T12). Returns a fresh resolver with a
   * per-request cache so repeated `resolve(...)` calls from inside a single
   * handler share repo round-trips while distinct requests don't share stale
   * config.
   */
  buildChannelResolver: () => ChannelResolver;
  /**
   * Fief OIDC client factory (T6). Cached by `connection.fief.baseUrl` so
   * discovery + JWKS stay hot across requests for the same tenant.
   */
  oidcClientFactory: (connection: ProviderConnection) => FiefOidcClient;
  /**
   * Fief admin API client factory (T5). Cached by `connection.fief.baseUrl`
   * (the admin client itself is stateless, but caching avoids re-allocating
   * the retry config on every request).
   */
  adminClientFactory: (connection: ProviderConnection) => FiefAdminApiClient;
  /**
   * Cross-tenant connection lookup. Consumed by the T22 Fief webhook
   * receiver — Fief's webhook URL only carries `connectionId`, so the
   * receiver can't be tenant-scoped at this seam. Walks every install's
   * docs (`saleorApiUrl` ignored) and returns the first match.
   */
  findConnectionById: FindConnectionById;
  /**
   * Saleor write surface (T19/T23). Intentionally a placeholder — production
   * wiring for T7's GraphQL mutations is a follow-up. Calling any method on
   * the placeholder throws so an under-provisioned environment fails loud.
   */
  saleorClient: SaleorCustomerClient;
}

// ---- Singleton wiring -------------------------------------------------------

let cachedDeps: ProductionDeps | undefined;
let cachedEncryptor: RotatingFiefEncryptor | undefined;
let cachedConnectionRepo: ProviderConnectionRepo | undefined;
let cachedChannelConfigurationRepo: IChannelConfigurationRepo | undefined;
let cachedIdentityMapRepo: IdentityMapRepo | undefined;
let cachedWebhookLogRepo: WebhookLogRepo | undefined;
const cachedOidcClients = new Map<string, FiefOidcClient>();
const cachedAdminClients = new Map<string, FiefAdminApiClient>();

const getEncryptor = (): RotatingFiefEncryptor => {
  if (cachedEncryptor === undefined) {
    cachedEncryptor = createFiefEncryptor();
  }

  return cachedEncryptor;
};

const getConnectionRepo = (): ProviderConnectionRepo => {
  if (cachedConnectionRepo === undefined) {
    cachedConnectionRepo = new MongodbProviderConnectionRepo(getEncryptor());
  }

  return cachedConnectionRepo;
};

const getChannelConfigurationRepo = (): IChannelConfigurationRepo => {
  if (cachedChannelConfigurationRepo === undefined) {
    cachedChannelConfigurationRepo = new MongoChannelConfigurationRepo();
  }

  return cachedChannelConfigurationRepo;
};

const getIdentityMapRepo = (): IdentityMapRepo => {
  if (cachedIdentityMapRepo === undefined) {
    cachedIdentityMapRepo = new MongoIdentityMapRepo();
  }

  return cachedIdentityMapRepo;
};

const getWebhookLogRepo = (): WebhookLogRepo => {
  if (cachedWebhookLogRepo === undefined) {
    cachedWebhookLogRepo = new MongodbWebhookLogRepo();
  }

  return cachedWebhookLogRepo;
};

const buildOidcClient = (connection: ProviderConnection): FiefOidcClient => {
  const key = connection.fief.baseUrl as unknown as string;
  const cached = cachedOidcClients.get(key);

  if (cached) {
    return cached;
  }

  const client = new FiefOidcClient({ baseUrl: key });

  cachedOidcClients.set(key, client);

  return client;
};

const buildAdminClient = (connection: ProviderConnection): FiefAdminApiClient => {
  const key = connection.fief.baseUrl as unknown as string;
  const cached = cachedAdminClients.get(key);

  if (cached) {
    return cached;
  }

  const client = FiefAdminApiClient.create({ baseUrl: connection.fief.baseUrl as FiefBaseUrl });

  cachedAdminClients.set(key, client);

  return client;
};

/**
 * Cross-tenant `connectionId` lookup. Walks every install's `provider_connections`
 * collection (filtered by `id` — we never reveal the saleorApiUrl boundary to
 * the caller) and returns the first matching connection.
 *
 * This sits in the composition root rather than on the repo interface (T8)
 * because tenant-scoped reads are the safe default and broadening the repo
 * interface would expose every consumer to cross-tenant foot-guns. The Fief
 * webhook receiver (T22) has a legitimate need for cross-tenant lookup
 * because Fief's webhook URL only carries `connectionId`.
 *
 * Soft-delete filter shape note (wire-up follow-up): T8's
 * `MongodbProviderConnectionRepo.create` persists `softDeletedAt: null` for
 * non-deleted rows (and `softDelete()` writes a `Date`). The original
 * `{ $exists: false }` predicate therefore never matched in production —
 * `null` IS present, just nullable. Match `softDeletedAt: null` directly:
 * Mongo BSON's nullable-equality semantics ALSO match documents where the
 * field is missing entirely, so legacy pre-T8 docs round-trip too.
 *
 * Exported so the wire-up follow-up's mongodb-memory-server tests can
 * exercise the actual filter shape end-to-end. Production callers go through
 * `getProductionDeps()` and never name the symbol.
 */
export const findConnectionById: FindConnectionById = async (connectionId) => {
  // Hit the underlying Mongo collection directly — bypasses tenant scoping.
  const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db(getMongoDatabaseName());
  const collection = db.collection<{ id: string; saleorApiUrl: string }>("provider_connections");

  try {
    /*
     * Mongo BSON treats `{ field: null }` as matching both explicit `null`
     * AND missing fields, so this single predicate covers both T8's modern
     * shape (`softDeletedAt: null`) and any pre-T8 legacy shape that omitted
     * the field entirely. A non-null `Date` (the soft-deleted state) does
     * NOT match — which is exactly the orphan-suppression the T22 receiver
     * needs.
     */
    const doc = await collection.findOne({
      id: connectionId as unknown as string,
      softDeletedAt: null,
    });

    if (!doc) {
      return err(new ProviderConnectionRepoError.NotFound(`connection ${connectionId} not found`));
    }

    // Defer to the tenant-scoped repo to materialize the branded entity (decrypt-aware schema parse).
    const { createSaleorApiUrl } = await import("@/modules/saleor/saleor-api-url");
    const saleorApiUrlResult = createSaleorApiUrl(doc.saleorApiUrl);

    if (saleorApiUrlResult.isErr()) {
      return err(
        new ProviderConnectionRepoError.FailureFetching(
          `connection ${connectionId} has invalid saleorApiUrl`,
          { cause: saleorApiUrlResult.error },
        ),
      );
    }

    return getConnectionRepo().get({
      saleorApiUrl: saleorApiUrlResult.value,
      id: connectionId,
    });
  } catch (cause) {
    return err(
      new ProviderConnectionRepoError.FailureFetching(
        `findConnectionById(${connectionId}) raised`,
        { cause },
      ),
    );
  }
};

/**
 * Production Saleor write surface (T7).
 *
 * Resolves the per-install app-token from the APL on every call so the client
 * tracks token rotations transparently. `customerCreate` does
 * find-or-create-by-email so an existing Saleor customer (with order history)
 * is bound to the new Fief identity instead of a duplicate getting minted —
 * the "user owns their historical orders" requirement.
 */
const buildSaleorCustomerClient = (): SaleorCustomerClient =>
  createSaleorGraphQLCustomerClient({
    tokenProvider: async (saleorApiUrl) => {
      const auth = await saleorApp.apl.get(saleorApiUrl);

      if (!auth) return undefined;

      return { saleorApiUrl: auth.saleorApiUrl, token: auth.token };
    },
  });

/**
 * Compose the production dependency graph. Process-cached: every call returns
 * the same wrapper object (and same repo instances). The `buildChannelResolver`
 * thunk is the only call-site-mutable hook — it returns a fresh resolver with
 * a fresh per-request cache so each handler invocation gets isolated memoization.
 *
 * Test seam: tests `vi.mock(...)` the consuming `build-deps.ts` / `deps.ts`
 * files; this function is never called from a test path.
 */
export const getProductionDeps = (): ProductionDeps => {
  if (cachedDeps !== undefined) {
    return cachedDeps;
  }

  // Touch the APL singleton so a missing config surfaces immediately.
  void saleorApp.apl;

  const encryptor = getEncryptor();
  const connectionRepo = getConnectionRepo();
  const channelConfigurationRepo = getChannelConfigurationRepo();
  const identityMapRepo = getIdentityMapRepo();
  const webhookLogRepo = getWebhookLogRepo();

  cachedDeps = {
    encryptor,
    connectionRepo,
    channelConfigurationRepo,
    identityMapRepo,
    webhookLogRepo,
    buildChannelResolver: () =>
      new ChannelResolver({
        channelConfigurationRepo,
        providerConnectionRepo: connectionRepo,
        cache: createChannelResolverCache(),
      }),
    oidcClientFactory: buildOidcClient,
    adminClientFactory: buildAdminClient,
    findConnectionById,
    saleorClient: buildSaleorCustomerClient(),
  };

  return cachedDeps;
};

/**
 * Test-only: clear the singleton so a test that replaces a Mongo URL
 * mid-suite gets a fresh graph against the new pool. Production code must
 * never call this.
 */
export const resetProductionDepsForTests = (): void => {
  cachedDeps = undefined;
  cachedEncryptor = undefined;
  cachedConnectionRepo = undefined;
  cachedChannelConfigurationRepo = undefined;
  cachedIdentityMapRepo = undefined;
  cachedWebhookLogRepo = undefined;
  cachedOidcClients.clear();
  cachedAdminClients.clear();
};
