import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type ChannelConfiguration } from "./channel-configuration";

/*
 * T9 — Channel-configuration repo interface.
 *
 * The contract the channel-scope resolver (T12) consumes. Defined as an
 * interface (not a class) so the in-memory test double for resolver tests
 * stays trivial. Mongo impl lives in `repositories/mongodb/`.
 *
 * Result-typed (`neverthrow`) per the rest of the Fief app — never throws
 * across module boundaries; transport errors land in `Err(...)` so handler
 * code can `match()` or `andThen()` cleanly without try/catch.
 */

export const ChannelConfigurationRepoError = BaseError.subclass("ChannelConfigurationRepoError", {
  props: {
    _brand: "FiefApp.ChannelConfigurationRepoError" as const,
  },
});

export type ChannelConfigurationRepoErrorInstance = InstanceType<
  typeof ChannelConfigurationRepoError
>;

export interface IChannelConfigurationRepo {
  /**
   * Fetch the configuration for a Saleor tenant. Returns `null` (inside Ok)
   * when no config has been written yet — the resolver treats that as
   * "no connections configured".
   */
  get(
    saleorApiUrl: SaleorApiUrl,
  ): Promise<Result<ChannelConfiguration | null, ChannelConfigurationRepoErrorInstance>>;

  /**
   * Insert or replace the entire configuration row for a tenant. The repo
   * stores one document per `saleorApiUrl` (uniqueness enforced by index
   * registered in `migrations.ts`); a re-upsert overwrites the prior row
   * including the entire `overrides` list. Callers wanting to mutate a
   * single override must read-then-write.
   *
   * Single-shot replace was chosen deliberately for v1: T36's settings UI
   * always renders the full list, so partial-update semantics would just
   * add a sharp edge ("forgot to include override X, now it's gone"). T12
   * (resolver) only reads.
   */
  upsert(
    config: ChannelConfiguration,
  ): Promise<Result<void, ChannelConfigurationRepoErrorInstance>>;
}
