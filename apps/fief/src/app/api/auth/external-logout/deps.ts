import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import { MongoChannelConfigurationRepo } from "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { MongodbProviderConnectionRepo } from "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo";

/*
 * T21 — composition seam.
 *
 * Why this exists
 * ---------------
 * The route handler needs the production Mongo-backed channel configuration
 * and provider-connection repos. Tests mock the *factory* (this module)
 * rather than the route module itself so the route's HTTP-translation logic
 * stays exercised end-to-end without standing up Mongo.
 *
 * Per-request construction
 * ------------------------
 * Both factories return a process-cached singleton — the repo objects are
 * cheap to instantiate (they hold a reference to the shared Mongo client +
 * the env-driven encryptor); the heavyweight Mongo connection is shared
 * across requests via the `getMongoClient()` singleton.
 */

let cachedConnectionRepo: ProviderConnectionRepo | undefined;
let cachedConfigRepo: IChannelConfigurationRepo | undefined;

/**
 * Build (or return the cached) provider-connection repo. Cached for process
 * lifetime — both the Mongo client and the env-driven encryptor are
 * intentionally process-singletons.
 *
 * Exported as a thunk (rather than a top-level constant) so test files can
 * `vi.mock(...)` this module without triggering Mongo client construction at
 * import time.
 */
export const buildProviderConnectionRepo = (): ProviderConnectionRepo => {
  if (cachedConnectionRepo === undefined) {
    cachedConnectionRepo = new MongodbProviderConnectionRepo();
  }

  return cachedConnectionRepo;
};

/**
 * Build (or return the cached) channel-configuration repo. Same singleton
 * caching strategy as `buildProviderConnectionRepo`.
 */
export const buildChannelConfigurationRepo = (): IChannelConfigurationRepo => {
  if (cachedConfigRepo === undefined) {
    cachedConfigRepo = new MongoChannelConfigurationRepo();
  }

  return cachedConfigRepo;
};
