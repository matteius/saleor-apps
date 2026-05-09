import { type Result } from "neverthrow";

import { saleorApp } from "@/lib/saleor-app";
import { type IChannelConfigurationRepo } from "@/modules/channel-configuration/channel-configuration-repo";
import { MongoChannelConfigurationRepo } from "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo";
import { type SaleorUserId } from "@/modules/identity-map/identity-map";
import { type IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import { MongoIdentityMapRepo } from "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo";
import {
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { MongodbProviderConnectionRepo } from "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo";

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
 * Each factory is a thunk (rather than a top-level constant) so test files
 * can mock without triggering Mongo client construction at import time.
 *
 * Per-process caching
 * -------------------
 * Repo objects are cheap to instantiate (they hold a reference to the shared
 * Mongo client + the env-driven encryptor); the heavyweight Mongo connection
 * is shared across requests via the `getMongoClient()` singleton. We cache
 * the repo instances per-process to avoid re-allocating the cheap wrappers
 * on every request.
 */

let cachedConnectionRepo: ProviderConnectionRepo | undefined;
let cachedConfigRepo: IChannelConfigurationRepo | undefined;
let cachedIdentityRepo: IdentityMapRepo | undefined;

/** Build (or return cached) provider-connection repo. */
export const buildProviderConnectionRepo = (): ProviderConnectionRepo => {
  if (cachedConnectionRepo === undefined) {
    cachedConnectionRepo = new MongodbProviderConnectionRepo();
  }

  return cachedConnectionRepo;
};

/** Build (or return cached) channel-configuration repo. */
export const buildChannelConfigurationRepo = (): IChannelConfigurationRepo => {
  if (cachedConfigRepo === undefined) {
    cachedConfigRepo = new MongoChannelConfigurationRepo();
  }

  return cachedConfigRepo;
};

/** Build (or return cached) identity-map repo. */
export const buildIdentityMapRepo = (): IdentityMapRepo => {
  if (cachedIdentityRepo === undefined) {
    cachedIdentityRepo = new MongoIdentityMapRepo();
  }

  return cachedIdentityRepo;
};

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
 * The full production wiring lands as a single follow-up patch in the central
 * composition root (T34) — same pattern as T18's `build-deps.ts`.
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
  /**
   * Verify the Fief id_token from the refresh response and return its
   * claims. Production: T6's `FiefOidcClient.verifyIdToken(idToken, {
   * audience: connection.fief.clientId, issuer: connection.fief.baseUrl })`.
   * Returns `Err` if the id_token is missing/malformed/expired/un-verifiable.
   */
  extractClaims(
    tokenResponse: FiefRefreshTokenResponse,
  ): Promise<Result<Record<string, unknown>, Error>>;

  /**
   * Fetch the current Saleor customer (id + email + names + metadata
   * buckets). Production: `client.query(FiefUserDocument, { id }).toPromise()`.
   */
  fetchSaleorUser(saleorUserId: SaleorUserId): Promise<Result<SaleorCustomerSnapshot, Error>>;

  /**
   * Write the merged metadata + privateMetadata buckets via Saleor's
   * `updateMetadata` and `updatePrivateMetadata` mutations. Both mutations
   * MUST be issued (or skipped per-bucket if the input bucket is empty)
   * within the same logical "refresh" so the loop-guard markers and the
   * projected claim values land atomically from the storefront's POV.
   */
  writeSaleorMetadata(input: WriteSaleorMetadataInput): Promise<Result<void, Error>>;
}

export interface BuildSaleorMetadataClientArgs {
  saleorApiUrl: string;
  connection: ProviderConnection;
}

/**
 * Production builder. Currently throws — see module docstring. Tests mock
 * this module so the route's HTTP-translation logic stays exercised end-to-
 * end without a real GraphQL client.
 */
export const buildSaleorMetadataClient = (
  _args: BuildSaleorMetadataClientArgs,
): SaleorMetadataClient => {
  throw new Error(
    "T20 buildSaleorMetadataClient not wired in production yet — central composition root must inject SaleorMetadataClient here. Tests inject via vi.mock('./deps').",
  );
};

/*
 * Re-export type-only re-exports the route uses without breaking the
 * vi.mock surface (mocks replace the whole module, so the route reads the
 * mocked symbols at call time, not at import time).
 */
export type { ProviderConnectionId };
