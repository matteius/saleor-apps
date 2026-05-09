import { compose } from "@saleor/apps-shared/compose";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import {
  type ChannelSlug,
  DISABLED_CHANNEL,
} from "@/modules/channel-configuration/channel-configuration";
import {
  ChannelResolver,
  createChannelResolverCache,
} from "@/modules/channel-configuration/channel-resolver";
import { projectClaimsToSaleorMetadata } from "@/modules/claims-mapping/projector";
import { FiefOidcClient } from "@/modules/fief-client/oidc-client";
import {
  type FiefUserId,
  FiefUserIdSchema,
  type SaleorApiUrl,
} from "@/modules/identity-map/identity-map";
import { verifyPluginRequest } from "@/modules/plugin-auth/hmac-verifier";
import {
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { FIEF_SYNC_ORIGIN_KEY, FIEF_SYNC_SEQ_KEY } from "@/modules/sync/loop-guard";
import { shapeUserClaimsForSaleorPlugin } from "@/modules/token-signing/claims-shaper";

import {
  buildChannelConfigurationRepo,
  buildIdentityMapRepo,
  buildProviderConnectionRepo,
  buildSaleorMetadataClient,
} from "./deps";

/*
 * T20 — `POST /api/auth/external-refresh` (Path A).
 *
 * Path-A endpoint called by the Saleor `BasePlugin` HMAC client (T56/T57)
 * when Saleor's `externalRefresh` mutation runs. Refreshes the Fief tokens,
 * reconciles updated claims with the cached Saleor metadata, and returns
 * the shaped claims payload the plugin will hand to Saleor's own JWT issuer.
 *
 * Wire format (locked across T20 / T57):
 *   Request body: `{ "refreshToken": "<fief-refresh-token>" }`
 *   Success response (HTTP 200):
 *     {
 *       claims:            T55-shaped Saleor user claims,
 *       fiefAccessToken:   string,
 *       fiefRefreshToken:  string | null,
 *       logoutRequired:    false
 *     }
 *   Fief-refresh-failure response (HTTP 401):
 *     {
 *       error:           "logout_required",
 *       logoutRequired:  true
 *     }
 *   Bad-HMAC response (HTTP 401):
 *     {
 *       error: "Unauthorized"
 *     }
 *   No connection / disabled channel (HTTP 404):
 *     {
 *       error: "Not Found"
 *     }
 *
 * Failure-contract distinction
 * ----------------------------
 * The two 401 shapes are intentionally different:
 *
 *   - Bad HMAC means the caller (the Saleor plugin) is mis-configured /
 *     the shared secret rotated; the storefront cannot recover by clearing
 *     the user session. The plugin should surface a generic auth failure.
 *
 *   - `logout_required` means the Fief refresh token is no longer valid
 *     (revoked, expired, user disabled, etc.). The storefront MUST clear
 *     the local session and force a re-login — that is the recovery path.
 *
 * Performance budget: p95 < 300 ms.
 *
 *   - 1 Mongo channel-resolver read (cached per request) +
 *   - 1 Mongo decrypt-secrets read +
 *   - 1 Fief refresh round-trip +
 *   - 1 APL `get(saleorApiUrl)` +
 *   - 1 Mongo identity-map read +
 *   - 1 Saleor `FiefUser` query +
 *   - 0-2 Saleor metadata mutations (skipped if claims unchanged).
 *
 * The metadata mutations are conditional on a content-diff — when the cached
 * Saleor metadata already matches the projection of the freshly-refreshed
 * Fief claims, we skip the writes entirely. This is the dominant hot path
 * (most refresh calls happen mid-session and claims rarely change), so
 * keeping the no-write fast-path under 200 ms is critical.
 */

const logger = createLogger("api.auth.external-refresh");

// -- Request schema -----------------------------------------------------------

const requestBodySchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

// -- HTTP responses -----------------------------------------------------------

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const unauthorizedResponse = (): Response => jsonResponse(401, { error: "Unauthorized" });

const logoutRequiredResponse = (): Response =>
  jsonResponse(401, { error: "logout_required", logoutRequired: true });

const notFoundResponse = (): Response => jsonResponse(404, { error: "Not Found" });

// -- Handler ------------------------------------------------------------------

const handler = async (req: NextRequest): Promise<Response> => {
  /*
   * -- Read body bytes once so we can pass them both to the HMAC verifier
   *    and to our own JSON parse downstream.
   */
  let bodyBytes: Buffer;

  try {
    bodyBytes = Buffer.from(await req.arrayBuffer());
  } catch (cause) {
    logger.warn("Failed to read external-refresh request body", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return unauthorizedResponse();
  }

  const headers = new Headers();

  req.headers.forEach((value, key) => {
    headers.set(key, value);
  });

  const verifierRequest = new Request(req.url, {
    method: req.method,
    headers,
    body: bodyBytes,
  });

  // -- 1. HMAC verify -------------------------------------------------------
  const verified = await verifyPluginRequest(verifierRequest, env.FIEF_PLUGIN_HMAC_SECRET);

  if (verified.isErr()) {
    logger.warn("external-refresh HMAC verification failed", {
      errorBrand: (verified.error as { _brand?: string })._brand,
      errorMessage: verified.error.message,
    });

    return unauthorizedResponse();
  }

  const { saleorApiUrl, channelSlug } = verified.value;

  // -- 2. Parse + validate body --------------------------------------------
  if (bodyBytes.length === 0) {
    return jsonResponse(400, { error: "Bad Request", message: "missing body" });
  }

  let parsedBody: z.infer<typeof requestBodySchema>;

  try {
    const json: unknown = JSON.parse(bodyBytes.toString("utf-8"));
    const result = requestBodySchema.safeParse(json);

    if (!result.success) {
      logger.warn("external-refresh body failed schema validation", {
        issueCount: result.error.issues.length,
      });

      return jsonResponse(400, {
        error: "Bad Request",
        message: "body did not match expected schema",
      });
    }

    parsedBody = result.data;
  } catch (cause) {
    logger.warn("external-refresh body was not valid JSON", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return jsonResponse(400, { error: "Bad Request", message: "body is not valid JSON" });
  }

  const { refreshToken } = parsedBody;

  // -- 3. Resolve connection via channel-scope ------------------------------
  if (channelSlug === undefined) {
    logger.info("external-refresh: missing channel header; cannot resolve connection", {
      saleorApiUrl,
    });

    return notFoundResponse();
  }

  const connection = await resolveConnection(saleorApiUrl, channelSlug);

  if (connection === null || connection === DISABLED_CHANNEL) {
    return notFoundResponse();
  }

  if (connection === "resolver-error") {
    return jsonResponse(500, { error: "Internal Server Error" });
  }

  // -- 4. Decrypt client secrets -------------------------------------------
  const decryptedSecrets = await getDecryptedSecrets(saleorApiUrl, connection.id);

  if (decryptedSecrets === null) {
    /*
     * Decryption failure is operationally an internal error (key rotation
     * mid-flight, ciphertext corruption, etc.). We surface it as 500 so
     * the operator sees the alert; we do NOT instruct the storefront to
     * log the user out — the user session is fine, our server is not.
     */
    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const clientSecrets = [
    decryptedSecrets.clientSecret,
    decryptedSecrets.pendingClientSecret,
  ].filter((value): value is string => Boolean(value));

  // -- 5. Refresh against Fief ---------------------------------------------
  const fiefResult = await safelyRefreshFief({
    baseUrl: connection.fief.baseUrl,
    clientId: connection.fief.clientId,
    clientSecrets,
    refreshToken,
  });

  if (fiefResult === null) {
    /*
     * Fief rejected the refresh (invalid_grant, network error, etc.). We
     * cannot recover server-side — the user must log out and back in.
     * Return the explicit `logout_required` contract so the Saleor plugin
     * can surface the right action to the storefront.
     */
    logger.info("external-refresh: Fief refresh failed, instructing logout", {
      saleorApiUrl,
      channelSlug,
      connectionId: connection.id,
    });

    return logoutRequiredResponse();
  }

  // -- 6. Extract fresh claims from the token response ---------------------
  const metadataClient = buildSaleorMetadataClient({
    saleorApiUrl,
    connection,
  });

  const claimsResult = await metadataClient.extractClaims(fiefResult.tokenResponse);

  if (claimsResult.isErr()) {
    logger.warn("external-refresh: failed to extract claims from Fief id_token", {
      errorMessage: claimsResult.error.message,
    });

    /*
     * Claims extraction failure is a client-token issue (malformed id_token
     * or missing/expired JWKS key). Treat as logout_required so the
     * storefront re-establishes the session.
     */
    return logoutRequiredResponse();
  }

  const freshClaims = claimsResult.value;

  // -- 7. Look up the Saleor user via identity-map -------------------------
  const fiefSubRaw = freshClaims["sub"];

  if (typeof fiefSubRaw !== "string" || fiefSubRaw.length === 0) {
    logger.warn("external-refresh: fresh claims missing `sub`; cannot bind to Saleor user");

    return logoutRequiredResponse();
  }

  const fiefUserIdParse = FiefUserIdSchema.safeParse(fiefSubRaw);

  if (!fiefUserIdParse.success) {
    logger.warn("external-refresh: `sub` claim failed FiefUserId brand validation", {
      errorMessage: fiefUserIdParse.error.message,
    });

    return logoutRequiredResponse();
  }

  const fiefUserId: FiefUserId = fiefUserIdParse.data;

  const identityRepo = buildIdentityMapRepo();
  const identityResult = await identityRepo.getByFiefUser({
    saleorApiUrl: saleorApiUrl as unknown as SaleorApiUrl,
    fiefUserId,
  });

  if (identityResult.isErr()) {
    logger.error("external-refresh: identity-map lookup failed", {
      errorMessage: identityResult.error.message,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const identityRow = identityResult.value;

  if (identityRow === null) {
    /*
     * The user authenticated against Fief but we have no Saleor binding.
     * That means T19's first-login provisioning never completed (or the
     * binding was deleted). Forcing a logout sends the user back through
     * `external_obtain_access_tokens` which will create the binding.
     */
    logger.warn("external-refresh: no identity-map row; forcing logout to re-provision", {
      fiefUserId,
    });

    return logoutRequiredResponse();
  }

  // -- 8. Fetch the live Saleor user ---------------------------------------
  const saleorUserResult = await metadataClient.fetchSaleorUser(identityRow.saleorUserId);

  if (saleorUserResult.isErr()) {
    logger.error("external-refresh: failed to fetch Saleor user", {
      errorMessage: saleorUserResult.error.message,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const saleorCustomer = saleorUserResult.value;

  // -- 9. Project claims + diff against cached metadata --------------------
  const projection = projectClaimsToSaleorMetadata(connection.claimMapping, freshClaims);

  const claimsDiverged =
    !shallowEqualMaps(
      projection.metadata,
      pickKeys(saleorCustomer.metadata, projection.metadata),
    ) ||
    !shallowEqualMaps(
      projection.privateMetadata,
      pickKeys(saleorCustomer.privateMetadata, projection.privateMetadata),
    );

  // -- 10. Conditionally write Saleor metadata -----------------------------
  let mergedSaleorCustomer = saleorCustomer;

  if (claimsDiverged) {
    /*
     * Bump the sync seq monotonically. The Saleor side's
     * `lastSyncSeq` lives in private metadata under FIEF_SYNC_SEQ_KEY; on
     * any divergent refresh we must publish a strictly higher seq so the
     * loop-guard module (T13) drops the resulting CUSTOMER_UPDATED echo.
     */
    const previousSeq =
      parseSeqFromMetadata(saleorCustomer.privateMetadata) ?? identityRow.lastSyncSeq;
    const nextSeq = previousSeq + 1;

    const writeMetadata: Record<string, string> = {
      ...projection.metadata,
      [FIEF_SYNC_ORIGIN_KEY]: "fief",
    };
    const writePrivateMetadata: Record<string, string> = {
      ...projection.privateMetadata,
      [FIEF_SYNC_SEQ_KEY]: String(nextSeq),
    };

    const writeResult = await metadataClient.writeSaleorMetadata({
      saleorUserId: identityRow.saleorUserId,
      metadata: writeMetadata,
      privateMetadata: writePrivateMetadata,
    });

    if (writeResult.isErr()) {
      logger.error("external-refresh: failed to write Saleor metadata", {
        errorMessage: writeResult.error.message,
      });

      return jsonResponse(500, { error: "Internal Server Error" });
    }

    /*
     * Reflect the freshly-written values onto the customer object we feed
     * the claims-shaper. The shaper will spread-merge the projection on
     * top, but origin/seq markers are NOT in the projection so we splice
     * them in here for the response payload to mirror the persisted state.
     */
    mergedSaleorCustomer = {
      ...saleorCustomer,
      metadata: { ...saleorCustomer.metadata, ...writeMetadata },
      privateMetadata: { ...saleorCustomer.privateMetadata, ...writePrivateMetadata },
    };
  }

  // -- 11. Build T55-shaped claims payload ---------------------------------
  const shaped = shapeUserClaimsForSaleorPlugin({
    saleorCustomer: {
      id: mergedSaleorCustomer.id,
      email: mergedSaleorCustomer.email,
      firstName: mergedSaleorCustomer.firstName,
      lastName: mergedSaleorCustomer.lastName,
      isActive: mergedSaleorCustomer.isActive,
      metadata: mergedSaleorCustomer.metadata,
      privateMetadata: mergedSaleorCustomer.privateMetadata,
    },
    fiefClaims: freshClaims,
    claimMapping: connection.claimMapping,
  });

  // -- 12. Return success --------------------------------------------------
  return jsonResponse(200, {
    claims: shaped,
    fiefAccessToken: fiefResult.tokenResponse.accessToken,
    fiefRefreshToken: fiefResult.tokenResponse.refreshToken ?? null,
    logoutRequired: false,
  });
};

// -- Helper: channel resolution (lift Err / null / disabled into return) -----

const resolveConnection = async (
  saleorApiUrl: string,
  channelSlug: string,
): Promise<ProviderConnection | null | typeof DISABLED_CHANNEL | "resolver-error"> => {
  try {
    const channelConfigurationRepo = buildChannelConfigurationRepo();
    const providerConnectionRepo = buildProviderConnectionRepo();
    const cache = createChannelResolverCache();

    const resolver = new ChannelResolver({
      channelConfigurationRepo,
      providerConnectionRepo,
      cache,
    });

    const result = await resolver.resolve(
      saleorApiUrl as unknown as SaleorApiUrl,
      channelSlug as ChannelSlug,
    );

    if (result.isErr()) {
      logger.error("external-refresh: channel-resolver returned Err", {
        saleorApiUrl,
        channelSlug,
        errorMessage: result.error.message,
      });

      return "resolver-error";
    }

    return result.value;
  } catch (cause) {
    logger.error("external-refresh: unexpected error resolving channel", {
      saleorApiUrl,
      channelSlug,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return "resolver-error";
  }
};

// -- Helper: decrypt connection client secrets -------------------------------

const getDecryptedSecrets = async (
  saleorApiUrl: string,
  connectionId: ProviderConnectionId,
): Promise<{ clientSecret: string; pendingClientSecret: string | null } | null> => {
  try {
    const repo = buildProviderConnectionRepo();
    const result = await repo.getDecryptedSecrets({
      saleorApiUrl: saleorApiUrl as unknown as SaleorApiUrl,
      id: connectionId,
    });

    if (result.isErr()) {
      logger.error("external-refresh: failed to decrypt connection secrets", {
        connectionId,
        errorMessage: result.error.message,
      });

      return null;
    }

    return {
      clientSecret: result.value.fief.clientSecret,
      pendingClientSecret: result.value.fief.pendingClientSecret,
    };
  } catch (cause) {
    logger.error("external-refresh: unexpected error decrypting secrets", {
      connectionId,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return null;
  }
};

// -- Helper: call Fief refreshToken (Err and throw both -> null) -------------

interface FiefRefreshSuccess {
  tokenResponse: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresIn?: number;
    tokenType?: string;
    scope?: string;
  };
}

const safelyRefreshFief = async (input: {
  baseUrl: string;
  clientId: string;
  clientSecrets: string[];
  refreshToken: string;
}): Promise<FiefRefreshSuccess | null> => {
  if (input.clientSecrets.length === 0) {
    logger.warn("external-refresh: no decrypted client secrets; cannot refresh");

    return null;
  }

  try {
    const oidcClient = new FiefOidcClient({ baseUrl: input.baseUrl });
    const result = await oidcClient.refreshToken({
      refreshToken: input.refreshToken,
      clientId: input.clientId,
      clientSecrets: input.clientSecrets,
    });

    if (result.isErr()) {
      logger.warn("external-refresh: Fief refreshToken returned Err", {
        errorBrand: (result.error as { _brand?: string })._brand,
        errorMessage: result.error.message,
      });

      return null;
    }

    return { tokenResponse: result.value };
  } catch (cause) {
    logger.warn("external-refresh: Fief refreshToken threw", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return null;
  }
};

// -- Helper: shallow map equality + key-restricted view ----------------------

/**
 * Return the subset of `source` whose keys are present in `keysFrom`. Used to
 * compare a fresh projection against only the cached cells the projection
 * would touch — unmapped Saleor metadata keys must not influence the
 * "diverged?" decision.
 */
const pickKeys = (
  source: Record<string, string>,
  keysFrom: Record<string, string>,
): Record<string, string> => {
  const out: Record<string, string> = {};

  for (const key of Object.keys(keysFrom)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key]!;
    }
  }

  return out;
};

const shallowEqualMaps = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }

  return true;
};

const parseSeqFromMetadata = (privateMetadata: Record<string, string>): number | null => {
  const raw = privateMetadata[FIEF_SYNC_SEQ_KEY];

  if (raw === undefined) {
    return null;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
};

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
