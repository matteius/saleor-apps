import { getProductionDeps } from "@/lib/composition-root";
import { type ChannelResolver } from "@/modules/channel-configuration/channel-resolver";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { type SaleorCustomerClient } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";

/*
 * T19 — production dependency factory.
 *
 * Lifts the route handler's IO surface behind a single boundary so the test
 * file (`route.test.ts`) can mock the wiring out without standing up Mongo,
 * the encryptor, an urql client, or anything else heavyweight.
 *
 * Production wiring lives in `@/lib/composition-root` (T40) — see
 * `getProductionDeps()`. The Saleor write surface is currently a placeholder
 * that throws (T7 GraphQL wiring is a follow-up); the auth-plane integration
 * tests stub this slot to assert the end-to-end pipeline.
 */

export interface RouteDeps {
  channelResolver: ChannelResolver;
  connectionRepo: ProviderConnectionRepo;
  identityMapRepo: IdentityMapRepo;
  /**
   * Reuses the narrow 3-method client surface introduced by T23. Production
   * wiring binds each method to a urql client + the matching generated
   * document (`FiefCustomerCreateDocument`, `FiefUpdateMetadataDocument`,
   * `FiefUpdatePrivateMetadataDocument`).
   */
  saleorClient: SaleorCustomerClient;
}

export const buildDeps = (): RouteDeps => {
  const deps = getProductionDeps();

  return {
    channelResolver: deps.buildChannelResolver(),
    connectionRepo: deps.connectionRepo,
    identityMapRepo: deps.identityMapRepo,
    saleorClient: deps.saleorClient,
  };
};
