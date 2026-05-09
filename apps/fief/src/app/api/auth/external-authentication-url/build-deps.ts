import { type ChannelResolver } from "@/modules/channel-configuration/channel-resolver";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";

/*
 * T18 — production dependency factory.
 *
 * Lifts the route handler's IO surface behind a single boundary so the test
 * file (`route.test.ts`) can mock the wiring out without touching Mongo or
 * the encryptor. Production wiring lands when T34's central composition root
 * lands; for now this file deliberately throws on call so an
 * under-provisioned environment fails loud rather than silently 500ing
 * with `undefined.method` errors.
 */

export interface RouteDeps {
  channelResolver: ChannelResolver;
  connectionRepo: ProviderConnectionRepo;
}

export const buildDeps = (): RouteDeps => {
  throw new Error(
    "T18 buildDeps not wired in production yet — central composition root (T34 follow-up) must inject ChannelResolver + ProviderConnectionRepo here. Tests inject via vi.mock('./build-deps').",
  );
};
