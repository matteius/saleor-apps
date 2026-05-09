import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type ProviderConnection,
  type ProviderConnectionId,
} from "../provider-connections/provider-connection";
import {
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "../provider-connections/provider-connection-repo";
import { type ChannelSlug, DISABLED_CHANNEL, type DisabledChannel } from "./channel-configuration";
import {
  type ChannelConfigurationRepoErrorInstance,
  type IChannelConfigurationRepo,
} from "./channel-configuration-repo";

/*
 * T12 — Channel-scope resolver.
 *
 * Pure logic over the two repo interfaces (`IChannelConfigurationRepo` from T9,
 * `ProviderConnectionRepo` from T8). The resolver answers the question every
 * webhook handler (T18-T29) asks first:
 *
 *   "For this `(saleorApiUrl, channelSlug)`, which `ProviderConnection` (if
 *    any) should I use — or is this channel explicitly disabled?"
 *
 * Resolution algorithm (T9's documented contract):
 *
 *   1. `repo.get(saleorApiUrl)` returns `Ok(null)` ⇒ no config for this
 *      tenant ⇒ return `null`.
 *   2. Otherwise, look for an exact `channelSlug` match in `config.overrides`:
 *        - `override.connectionId === DISABLED_CHANNEL` ⇒ return `"disabled"`
 *          *without* loading any connection (the operator opted this channel
 *          out; we must not fall through to the default).
 *        - any other value ⇒ load that `ProviderConnection` via T8's repo
 *          and return it.
 *   3. No matching override ⇒ fall back to `defaultConnectionId`:
 *        - non-null ⇒ load via T8 and return.
 *        - null ⇒ return `null`.
 *
 * Memoization
 * -----------
 * Every webhook handler may call the resolver from several internal use cases
 * during a single request (e.g. the user-update sync path checks scope before
 * the loop-guard, then again before the claims projection). Without a cache
 * that's N MongoDB round-trips per handler. The cache is **per-request** so a
 * stale config from a previous webhook never shadows the current one — the
 * caller constructs a fresh cache via `createChannelResolverCache()` and
 * passes it into the resolver. The cache stores the in-flight `Promise` (not
 * the resolved value) so concurrent in-request callers also share a single
 * upstream call instead of stampeding the repos.
 *
 * We deliberately do NOT use `AsyncLocalStorage` here — the DI form keeps the
 * contract testable without setting up an async context, and downstream
 * consumers (T18-T29) all already follow the "build a request-scoped object,
 * pass it down" pattern.
 *
 * Constructor signature for downstream consumers (T18-T29):
 *
 *   new ChannelResolver({
 *     channelConfigurationRepo: IChannelConfigurationRepo,
 *     providerConnectionRepo:    ProviderConnectionRepo,
 *     cache:                     ChannelResolverCache, // createChannelResolverCache()
 *   })
 *
 *   resolver.resolve(saleorApiUrl, channelSlug)
 *     → Promise<Result<ProviderConnection | DisabledChannel | null, ChannelResolverError>>
 */

// -- Errors -------------------------------------------------------------------

export const ChannelResolverError = BaseError.subclass("ChannelResolverError", {
  props: {
    _brand: "FiefApp.ChannelResolverError" as const,
  },
});

export type ChannelResolverErrorInstance = InstanceType<typeof ChannelResolverError>;

// -- Resolution result type ---------------------------------------------------

/**
 * The resolved scope for a `(saleorApiUrl, channelSlug)` pair.
 *
 *   - `ProviderConnection` — sync this event through the named connection.
 *   - `"disabled"`         — the channel is explicitly opted out; the caller
 *                            should drop the event silently (no error log).
 *   - `null`               — no connection is configured for this channel;
 *                            the caller decides whether that's a no-op or a
 *                            warn-and-drop (Fief webhooks vs. Saleor webhooks
 *                            differ here — see T19/T22).
 */
export type ChannelResolution = ProviderConnection | DisabledChannel | null;

// -- Cache primitive ----------------------------------------------------------

/*
 * Per-request cache. Stores the in-flight `Promise<Result<...>>` (not the
 * resolved value) so that two concurrent callers within the same request
 * share a single upstream round-trip instead of issuing two.
 */
type CacheValue = Promise<Result<ChannelResolution, ChannelResolverErrorInstance>>;

export interface ChannelResolverCache {
  get(key: string): CacheValue | undefined;
  set(key: string, value: CacheValue): void;
}

/**
 * Construct a fresh cache scoped to a single request. Callers (HTTP route
 * wrappers, queue worker handlers) instantiate this once at the top of the
 * handler and pass the same instance to every `ChannelResolver` they build.
 */
export const createChannelResolverCache = (): ChannelResolverCache => {
  const map = new Map<string, CacheValue>();

  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
  };
};

// -- Resolver -----------------------------------------------------------------

export interface ChannelResolverDeps {
  channelConfigurationRepo: IChannelConfigurationRepo;
  providerConnectionRepo: ProviderConnectionRepo;
  cache: ChannelResolverCache;
}

export class ChannelResolver {
  private readonly channelConfigurationRepo: IChannelConfigurationRepo;
  private readonly providerConnectionRepo: ProviderConnectionRepo;
  private readonly cache: ChannelResolverCache;

  constructor(deps: ChannelResolverDeps) {
    this.channelConfigurationRepo = deps.channelConfigurationRepo;
    this.providerConnectionRepo = deps.providerConnectionRepo;
    this.cache = deps.cache;
  }

  /**
   * Resolve the scope for `(saleorApiUrl, channelSlug)`. Memoized via the
   * injected cache: the second call within the same request returns the same
   * `Promise` (and therefore the same result) without touching either repo.
   */
  resolve(
    saleorApiUrl: SaleorApiUrl,
    channelSlug: ChannelSlug,
  ): Promise<Result<ChannelResolution, ChannelResolverErrorInstance>> {
    const key = this.cacheKey(saleorApiUrl, channelSlug);
    const cached = this.cache.get(key);

    if (cached) {
      return cached;
    }

    const inflight = this.computeResolution(saleorApiUrl, channelSlug);

    this.cache.set(key, inflight);

    return inflight;
  }

  // -- internals --------------------------------------------------------------

  private cacheKey(saleorApiUrl: SaleorApiUrl, channelSlug: ChannelSlug): string {
    /*
     * Using a `\x00` separator keeps the key collision-free for any legal
     * input (Saleor api-urls and channel slugs cannot contain a NUL byte).
     */
    return `${saleorApiUrl}\x00${channelSlug}`;
  }

  private async computeResolution(
    saleorApiUrl: SaleorApiUrl,
    channelSlug: ChannelSlug,
  ): Promise<Result<ChannelResolution, ChannelResolverErrorInstance>> {
    const configResult = await this.channelConfigurationRepo.get(saleorApiUrl);

    if (configResult.isErr()) {
      return err(this.wrapConfigError(configResult.error, saleorApiUrl, channelSlug));
    }

    const config = configResult.value;

    if (!config) {
      return ok(null);
    }

    const matchingOverride = config.overrides.find(
      (override) => override.channelSlug === channelSlug,
    );

    if (matchingOverride) {
      if (matchingOverride.connectionId === DISABLED_CHANNEL) {
        return ok(DISABLED_CHANNEL);
      }

      return this.loadConnection(saleorApiUrl, matchingOverride.connectionId);
    }

    if (config.defaultConnectionId === null) {
      return ok(null);
    }

    return this.loadConnection(saleorApiUrl, config.defaultConnectionId);
  }

  private async loadConnection(
    saleorApiUrl: SaleorApiUrl,
    /*
     * `connectionId` is T9's `ConnectionId` brand at the type level, but at
     * runtime it's the same UUID string the T8 repo uses. Cast at the brand
     * boundary — the value has already been schema-validated upstream and
     * UUID-shape-validated by T8's `providerConnectionIdSchema` when the
     * connection was originally created.
     */
    connectionId: string,
  ): Promise<Result<ChannelResolution, ChannelResolverErrorInstance>> {
    const result = await this.providerConnectionRepo.get({
      saleorApiUrl,
      id: connectionId as ProviderConnectionId,
    });

    if (result.isErr()) {
      const cause = result.error;

      if (cause instanceof ProviderConnectionRepoError.NotFound) {
        return err(
          new ChannelResolverError(
            `Channel-configuration references a connection that does not exist (saleorApiUrl=${saleorApiUrl}, connectionId=${connectionId}). The override or default likely outlived its target.`,
            { cause },
          ),
        );
      }

      return err(
        new ChannelResolverError(
          `Failed to load connection referenced by channel-configuration (saleorApiUrl=${saleorApiUrl}, connectionId=${connectionId})`,
          { cause },
        ),
      );
    }

    return ok(result.value);
  }

  private wrapConfigError(
    cause: ChannelConfigurationRepoErrorInstance,
    saleorApiUrl: SaleorApiUrl,
    channelSlug: ChannelSlug,
  ): ChannelResolverErrorInstance {
    return new ChannelResolverError(
      `Failed to load channel configuration (saleorApiUrl=${saleorApiUrl}, channelSlug=${channelSlug})`,
      { cause },
    );
  }
}
