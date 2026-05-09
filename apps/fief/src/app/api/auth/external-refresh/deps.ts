import { type Result } from "neverthrow";

import { getProductionDeps } from "@/lib/composition-root";
import { saleorApp } from "@/lib/saleor-app";
import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import { type SaleorUserId } from "@/modules/identity-map/identity-map";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import {
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";

/*
 * T20 — composition seam for the `external-refresh` route.
 *
 * Why this exists
 * ---------------
 * The route handler needs the production Mongo-backed repos plus the SaleorApp
 * APL (for fetching the per-instance app token used to talk to the Saleor
 * GraphQL API when refreshing customer metadata). Tests `vi.mock(...)` this
 * module so the route's HTTP-translation logic is exercised end-to-end without
 * standing up Mongo or a Saleor instance.
 *
 * Production wiring lives in `@/lib/composition-root` (T40) — every factory
 * here is a thin thunk over `getProductionDeps()`. The Mongo connection is
 * shared across requests via the `getMongoClient()` singleton owned by T3.
 */

/** Build (or return cached) provider-connection repo. */
export const buildProviderConnectionRepo = (): ProviderConnectionRepo =>
  getProductionDeps().connectionRepo;

/** Build (or return cached) channel-configuration repo. */
export const buildChannelConfigurationRepo = (): IChannelConfigurationRepo =>
  getProductionDeps().channelConfigurationRepo;

/** Build (or return cached) identity-map repo. */
export const buildIdentityMapRepo = (): IdentityMapRepo => getProductionDeps().identityMapRepo;

/**
 * Return the SaleorApp APL singleton — used to look up the per-instance app
 * token required for the Saleor metadata-refresh GraphQL calls.
 */
export const getSaleorAppAPL = () => saleorApp.apl;

/*
 * ---------------------------------------------------------------------------
 * SaleorMetadataClient — composition seam for the GraphQL + claims work.
 * ---------------------------------------------------------------------------
 *
 * The route handler does not talk to Saleor or the JWKS directly; it goes
 * through this port. Production wiring will (a) construct an urql client via
 * `@saleor/apps-shared/create-graphql-client` using the APL-resolved app
 * token, (b) issue `FiefUser` / `FiefUpdateMetadata` / `FiefUpdatePrivateMetadata`
 * operations, and (c) verify the Fief `id_token` via T6's `FiefOidcClient`
 * to extract claims.
 *
 * For v1, the production builder throws on call so an under-provisioned
 * environment fails loud; tests `vi.mock(...)` this module to inject a fake.
 * The full production wiring lands as a follow-up patch for T7's GraphQL surface.
 */

export interface SaleorCustomerSnapshot {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  isActive: boolean;
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

export interface FiefRefreshTokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

export interface WriteSaleorMetadataInput {
  saleorUserId: SaleorUserId;
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

export interface SaleorMetadataClient {
  extractClaims(
    tokenResponse: FiefRefreshTokenResponse,
  ): Promise<Result<Record<string, unknown>, Error>>;

  fetchSaleorUser(saleorUserId: SaleorUserId): Promise<Result<SaleorCustomerSnapshot, Error>>;

  writeSaleorMetadata(input: WriteSaleorMetadataInput): Promise<Result<void, Error>>;
}

export interface BuildSaleorMetadataClientArgs {
  saleorApiUrl: string;
  connection: ProviderConnection;
}

export const buildSaleorMetadataClient = (
  _args: BuildSaleorMetadataClientArgs,
): SaleorMetadataClient => {
  throw new Error(
    "T20 buildSaleorMetadataClient not wired in production yet — T7 GraphQL surface must inject SaleorMetadataClient here. Tests inject via vi.mock('./deps').",
  );
};

export type { ProviderConnectionId };
