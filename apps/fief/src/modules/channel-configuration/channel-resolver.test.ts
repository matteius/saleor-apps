import { err, ok, type Result } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  createProviderConnectionId,
  type DecryptedProviderConnectionSecrets,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderConnectionUpdateInput,
} from "../provider-connections/provider-connection";
import {
  type GetProviderConnectionAccess,
  type ListProviderConnectionsAccess,
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "../provider-connections/provider-connection-repo";
import {
  type ChannelConfiguration,
  createChannelSlug,
  createConnectionId,
  DISABLED_CHANNEL,
} from "./channel-configuration";
import {
  ChannelConfigurationRepoError,
  type ChannelConfigurationRepoErrorInstance,
  type IChannelConfigurationRepo,
} from "./channel-configuration-repo";
import { ChannelResolver, createChannelResolverCache } from "./channel-resolver";

/*
 * T12 — Channel-scope resolver tests.
 *
 * The resolver is the contract every webhook handler (T18-T29) reaches for to
 * pick the right `ProviderConnection` for an inbound `(saleorApiUrl, channelSlug)`
 * pair. The semantics are documented on T9's `channel-configuration.ts` (override
 * wins over default; `"disabled"` override opts a single channel out; null when
 * neither applies). Memoization is REQUIRED for handler-lifetime correctness so
 * a single webhook that touches the resolver from multiple use cases doesn't
 * fan out N round-trips for the same key.
 */

const saleorApiUrl: SaleorApiUrl = createSaleorApiUrl(
  "https://shop-1.saleor.cloud/graphql/",
)._unsafeUnwrap();

const defaultConnectionId = createProviderConnectionId("11111111-1111-4111-8111-111111111111");
const overrideConnectionId = createProviderConnectionId("22222222-2222-4222-8222-222222222222");

/*
 * Build a `ProviderConnection` shell. Most fields are placeholders — the
 * resolver only reads `id` / `saleorApiUrl` from the entity (it returns the
 * whole record opaquely to its caller) so the rest exists only to satisfy
 * the schema/type.
 */
const buildConnection = (id: ProviderConnectionId): ProviderConnection =>
  ({
    id,
    saleorApiUrl,
    name: "test-conn" as ProviderConnection["name"],
    fief: {
      baseUrl: "https://example.fief.dev/" as ProviderConnection["fief"]["baseUrl"],
      tenantId: "tenant" as ProviderConnection["fief"]["tenantId"],
      clientId: "client" as ProviderConnection["fief"]["clientId"],
      encryptedClientSecret: "enc" as ProviderConnection["fief"]["encryptedClientSecret"],
      encryptedPendingClientSecret: null,
      encryptedAdminToken: "enc" as ProviderConnection["fief"]["encryptedAdminToken"],
      encryptedWebhookSecret: "enc" as ProviderConnection["fief"]["encryptedWebhookSecret"],
      encryptedPendingWebhookSecret: null,
    },
    branding: {
      encryptedSigningKey: "enc" as ProviderConnection["branding"]["encryptedSigningKey"],
      allowedOrigins: [],
    },
    claimMapping: [],
    softDeletedAt: null,
  }) as ProviderConnection;

/*
 * In-memory fakes. Trivial enough to keep inline; mirrors the avatax pattern
 * of "construct the smallest object that satisfies the interface contract".
 */

class FakeChannelConfigurationRepo implements IChannelConfigurationRepo {
  public configsByUrl = new Map<string, ChannelConfiguration | null>();
  public errorOnGet: ChannelConfigurationRepoErrorInstance | null = null;
  public getCallCount = 0;

  async get(
    url: SaleorApiUrl,
  ): Promise<Result<ChannelConfiguration | null, ChannelConfigurationRepoErrorInstance>> {
    this.getCallCount += 1;

    if (this.errorOnGet) {
      return err(this.errorOnGet);
    }

    const config = this.configsByUrl.get(url) ?? null;

    return ok(config);
  }

  async upsert(): Promise<Result<void, ChannelConfigurationRepoErrorInstance>> {
    throw new Error("upsert is not used by the resolver under test");
  }
}

class FakeProviderConnectionRepo implements ProviderConnectionRepo {
  public connectionsById = new Map<string, ProviderConnection>();
  public getCallCount = 0;
  public missingId: ProviderConnectionId | null = null;
  public failingId: ProviderConnectionId | null = null;

  async create(): Promise<
    Result<ProviderConnection, InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>>
  > {
    throw new Error("create is not used by the resolver under test");
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
    this.getCallCount += 1;

    if (this.failingId === access.id) {
      return err(new ProviderConnectionRepoError.FailureFetching("simulated fetch failure"));
    }

    if (this.missingId === access.id) {
      return err(new ProviderConnectionRepoError.NotFound("not found"));
    }

    const conn = this.connectionsById.get(access.id);

    if (!conn) {
      return err(new ProviderConnectionRepoError.NotFound("not found"));
    }

    return ok(conn);
  }

  async list(
    _access: ListProviderConnectionsAccess,
  ): Promise<
    Result<
      ProviderConnection[],
      InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    throw new Error("list is not used by the resolver under test");
  }

  async update(
    _access: { saleorApiUrl: SaleorApiUrl; id: ProviderConnectionId },
    _patch: ProviderConnectionUpdateInput,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  > {
    throw new Error("update is not used by the resolver under test");
  }

  async softDelete(): Promise<
    Result<
      void,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDeleting"]>
    >
  > {
    throw new Error("softDelete is not used by the resolver under test");
  }

  async restore(): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  > {
    throw new Error("restore is not used by the resolver under test");
  }

  async getDecryptedSecrets(): Promise<
    Result<
      DecryptedProviderConnectionSecrets,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>
    >
  > {
    throw new Error("getDecryptedSecrets is not used by the resolver under test");
  }

  // Helpers for tests.
  add(conn: ProviderConnection) {
    this.connectionsById.set(conn.id, conn);
  }

  reset() {
    this.connectionsById.clear();
    this.getCallCount = 0;
    this.missingId = null;
    this.failingId = null;
  }
}

const ukChannel = createChannelSlug("uk");
const usChannel = createChannelSlug("us");

describe("ChannelResolver", () => {
  let configRepo: FakeChannelConfigurationRepo;
  let connectionRepo: FakeProviderConnectionRepo;

  beforeEach(() => {
    configRepo = new FakeChannelConfigurationRepo();
    connectionRepo = new FakeProviderConnectionRepo();
  });

  it("returns the default connection when no override matches", async () => {
    const defaultConn = buildConnection(defaultConnectionId);

    connectionRepo.add(defaultConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(defaultConn);
  });

  it("returns the override-bound connection when an override matches the channel slug", async () => {
    const defaultConn = buildConnection(defaultConnectionId);
    const overrideConn = buildConnection(overrideConnectionId);

    connectionRepo.add(defaultConn);
    connectionRepo.add(overrideConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [
        {
          channelSlug: ukChannel,
          connectionId: createConnectionId(overrideConnectionId),
        },
      ],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(overrideConn);
  });

  it("returns 'disabled' when the override marks the channel as disabled (even if a default exists)", async () => {
    const defaultConn = buildConnection(defaultConnectionId);

    connectionRepo.add(defaultConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [
        {
          channelSlug: ukChannel,
          connectionId: DISABLED_CHANNEL,
        },
      ],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("disabled");
    // Default must NOT be loaded when the override explicitly opts out.
    expect(connectionRepo.getCallCount).toBe(0);
  });

  it("returns null when no config row exists for the tenant", async () => {
    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("returns null when config exists with no default and no matching override", async () => {
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: null,
      overrides: [
        {
          channelSlug: usChannel,
          connectionId: createConnectionId(overrideConnectionId),
        },
      ],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("memoizes resolution within a single cache scope (same key resolved twice hits the cache)", async () => {
    const defaultConn = buildConnection(defaultConnectionId);

    connectionRepo.add(defaultConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [],
    });

    const cache = createChannelResolverCache();

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache,
    });

    const first = await resolver.resolve(saleorApiUrl, ukChannel);
    const second = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(first._unsafeUnwrap()).toBe(defaultConn);
    expect(second._unsafeUnwrap()).toBe(defaultConn);

    // Both repos must have been touched only once across the two calls.
    expect(configRepo.getCallCount).toBe(1);
    expect(connectionRepo.getCallCount).toBe(1);
  });

  it("does not collide cache entries across different channel slugs for the same saleorApiUrl", async () => {
    const defaultConn = buildConnection(defaultConnectionId);
    const overrideConn = buildConnection(overrideConnectionId);

    connectionRepo.add(defaultConn);
    connectionRepo.add(overrideConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [
        {
          channelSlug: ukChannel,
          connectionId: createConnectionId(overrideConnectionId),
        },
      ],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const ukResult = await resolver.resolve(saleorApiUrl, ukChannel);
    const usResult = await resolver.resolve(saleorApiUrl, usChannel);

    expect(ukResult._unsafeUnwrap()).toBe(overrideConn);
    expect(usResult._unsafeUnwrap()).toBe(defaultConn);
  });

  it("propagates a config-repo error as an Err", async () => {
    configRepo.errorOnGet = new ChannelConfigurationRepoError("boom");

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isErr()).toBe(true);
  });

  it("propagates a connection-repo error when loading an override target", async () => {
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: null,
      overrides: [
        {
          channelSlug: ukChannel,
          connectionId: createConnectionId(overrideConnectionId),
        },
      ],
    });
    connectionRepo.failingId = overrideConnectionId;

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isErr()).toBe(true);
  });

  it("treats an override pointing at a missing connection as Err (not silently null)", async () => {
    /*
     * Operator deleted the connection but forgot to clean the override row.
     * Returning `null` would silently swallow the misconfiguration; better
     * to surface as Err so the webhook handler can log + DLQ.
     */
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: null,
      overrides: [
        {
          channelSlug: ukChannel,
          connectionId: createConnectionId(overrideConnectionId),
        },
      ],
    });
    connectionRepo.missingId = overrideConnectionId;

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isErr()).toBe(true);
  });

  it("caches errors so repeated calls within a request do not re-hit the failing repo", async () => {
    /*
     * Defensive: handlers that call the resolver in a loop must not amplify a
     * single transient failure into N retries against the same broken state.
     */
    configRepo.errorOnGet = new ChannelConfigurationRepoError("boom");

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const first = await resolver.resolve(saleorApiUrl, ukChannel);
    const second = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(first.isErr()).toBe(true);
    expect(second.isErr()).toBe(true);
    expect(configRepo.getCallCount).toBe(1);
  });

  it("dedupes concurrent in-flight resolutions (no thundering herd against the repo)", async () => {
    /*
     * Two calls fired before the first resolves should share the same Promise
     * — otherwise N concurrent webhook reads of the same key amplify into N
     * upstream calls.
     */
    const defaultConn = buildConnection(defaultConnectionId);

    connectionRepo.add(defaultConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const [a, b] = await Promise.all([
      resolver.resolve(saleorApiUrl, ukChannel),
      resolver.resolve(saleorApiUrl, ukChannel),
    ]);

    expect(a._unsafeUnwrap()).toBe(defaultConn);
    expect(b._unsafeUnwrap()).toBe(defaultConn);
    expect(configRepo.getCallCount).toBe(1);
    expect(connectionRepo.getCallCount).toBe(1);
  });

  it("a fresh cache instance does not share entries with the prior cache (per-request isolation)", async () => {
    const defaultConn = buildConnection(defaultConnectionId);

    connectionRepo.add(defaultConn);
    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [],
    });

    const resolver1 = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    await resolver1.resolve(saleorApiUrl, ukChannel);

    const resolver2 = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    await resolver2.resolve(saleorApiUrl, ukChannel);

    expect(configRepo.getCallCount).toBe(2);
  });

  it("is safe to call when configRepo.get returns Ok(null) and there are no overrides", async () => {
    /*
     * Pure smoke for the most common cold-start path — install just happened,
     * operator hasn't pinned a default yet.
     */
    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
    // Connection repo must not be touched if there's no config at all.
    expect(connectionRepo.getCallCount).toBe(0);
  });

  it("does not call connectionRepo when the disabled override short-circuits", async () => {
    /*
     * Lightly redundant with the disabled-override test above but explicit
     * about the call-count contract that downstream consumers (T18-T29) rely
     * on for budgeting per-webhook MongoDB roundtrips.
     */
    const spy = vi.spyOn(connectionRepo, "get");

    configRepo.configsByUrl.set(saleorApiUrl, {
      saleorApiUrl,
      defaultConnectionId: createConnectionId(defaultConnectionId),
      overrides: [
        {
          channelSlug: ukChannel,
          connectionId: DISABLED_CHANNEL,
        },
      ],
    });

    const resolver = new ChannelResolver({
      channelConfigurationRepo: configRepo,
      providerConnectionRepo: connectionRepo,
      cache: createChannelResolverCache(),
    });

    const result = await resolver.resolve(saleorApiUrl, ukChannel);

    expect(result._unsafeUnwrap()).toBe("disabled");
    expect(spy).not.toHaveBeenCalled();
  });
});
