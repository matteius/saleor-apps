import { getProductionDeps } from "@/lib/composition-root";
import { type ChannelResolver } from "@/modules/channel-configuration/channel-resolver";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";

/*
 * T18 — production dependency factory.
 *
 * Lifts the route handler's IO surface behind a single boundary so the test
 * file (`route.test.ts`) can mock the wiring out without touching Mongo or
 * the encryptor.
 *
 * Production wiring lives in `@/lib/composition-root` (T40) — see
 * `getProductionDeps()`. The composition root is process-cached and the
 * channel-resolver factory returns a fresh per-request cache, so this
 * thunk is cheap on the hot path.
 */

export interface RouteDeps {
  channelResolver: ChannelResolver;
  connectionRepo: ProviderConnectionRepo;
}

export const buildDeps = (): RouteDeps => {
  const deps = getProductionDeps();

  return {
    channelResolver: deps.buildChannelResolver(),
    connectionRepo: deps.connectionRepo,
  };
};
