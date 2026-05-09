import { getProductionDeps } from "@/lib/composition-root";
import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";

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
 * Both factories return process-cached singletons sourced from
 * `@/lib/composition-root` (T40). The Mongo connection is shared across
 * requests via the `getMongoClient()` singleton owned by T3.
 */

export const buildProviderConnectionRepo = (): ProviderConnectionRepo =>
  getProductionDeps().connectionRepo;

export const buildChannelConfigurationRepo = (): IChannelConfigurationRepo =>
  getProductionDeps().channelConfigurationRepo;
