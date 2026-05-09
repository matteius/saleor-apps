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
 * Production wiring lands when the central composition root (T34 follow-up)
 * stitches together the Mongo-backed repos + the GraphQL-backed
 * `SaleorCustomerClient`. For now this factory deliberately throws on call
 * so an under-provisioned environment fails loud rather than silently 500ing
 * with `undefined.method` errors.
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
  throw new Error(
    "T19 buildDeps not wired in production yet — central composition root (T34 follow-up) must inject ChannelResolver + ProviderConnectionRepo + IdentityMapRepo + SaleorCustomerClient here. Tests inject via vi.mock('./build-deps').",
  );
};
