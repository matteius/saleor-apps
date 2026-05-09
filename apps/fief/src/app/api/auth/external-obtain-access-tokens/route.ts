// cspell:ignore upsert opensensor

import { compose } from "@saleor/apps-shared/compose";
import { err, ok, type Result } from "neverthrow";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { verifyStateToken } from "@/modules/auth-state/state-token";
import {
  type ChannelSlug,
  createChannelSlug,
  DISABLED_CHANNEL,
} from "@/modules/channel-configuration/channel-configuration";
import { projectClaimsToSaleorMetadata } from "@/modules/claims-mapping/projector";
import { FiefOidcClient } from "@/modules/fief-client/oidc-client";
import {
  createSyncSeq,
  type FiefUserId,
  FiefUserIdSchema,
  type SaleorUserId,
  type SyncSeq,
} from "@/modules/identity-map/identity-map";
import {
  BadSignatureError,
  ExpiredError,
  MalformedError,
  ReplayError,
  verifyPluginRequest,
} from "@/modules/plugin-auth/hmac-verifier";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type SaleorCustomerClient } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";
import { tagWrite } from "@/modules/sync/loop-guard";
import {
  type ShapedSaleorPluginClaims,
  shapeUserClaimsForSaleorPlugin,
} from "@/modules/token-signing/claims-shaper";

import { buildDeps, type RouteDeps } from "./build-deps";

/*
 * T19 — `POST /api/auth/external-obtain-access-tokens` (Path A).
 *
 * Saleor's `external_obtain_access_tokens(...)` plugin hook (T56/T57) calls
 * this endpoint when a storefront user completes the Fief authorization
 * round-trip. This is the canonical first-login path for Path A — the most
 * complex auth handler in the surface because it owns:
 *
 *   - Race-safe identity provisioning across two concurrent surfaces
 *     (T19 vs T19 two-device first-login, T19 vs T22→T23 webhook).
 *   - Loop-prevention: every Saleor write carries the origin marker
 *     "fief" (T13) so the inevitable Saleor-side echo is dropped.
 *   - Claims projection and shaping for Saleor's own JWT issuer (T2 spike
 *     locked in: apps/fief does NOT sign tokens; Saleor signs internally).
 *
 * Pipeline (latency budget: p95 < 600ms):
 *
 *   1. Verify HMAC via T58 (`verifyPluginRequest`). Bad HMAC → 401.
 *   2. Parse + validate body (Fief authorization `code`, `redirectUri`,
 *      `origin`, `brandingOrigin`). Bad body → 400.
 *   3. Resolve the connection via T12's `ChannelResolver`:
 *        - `null` → 404 (no connection bound to channel).
 *        - `"disabled"` → 403 (operator opted channel out of Fief auth).
 *   4. Decrypt per-connection secrets via T8.
 *   5. Verify the inbound `branding_origin` token (T15). Failure → 400 (the
 *      Saleor plugin handed us an origin we don't trust — client error).
 *   6. Exchange the Fief code (T6's `exchangeCode`) using the dual-secret
 *      rotation array. Upstream failure → 502.
 *   7. Extract user identity + claims from the token response (id_token if
 *      present + decoded `claims` per the Fief contract).
 *   8. Race-safe identity bind: T10 atomic upsert.
 *        - `wasInserted: true` → cold path: customerCreate (T7) + project
 *           claims (T14) + tag with origin marker (T13).
 *        - `wasInserted: false` → reuse bound `saleorUserId`; metadata
 *           refresh against the existing customer.
 *   9. Return shaped claims via T55 (`shapeUserClaimsForSaleorPlugin`).
 *
 * Idempotency: the same Fief authorization code, replayed, lands on the
 * existing identity_map row and produces an equivalent response. Saleor's
 * plugin retry semantics are absorbed safely.
 *
 * Path-coordination note (T57 wiring):
 * --------------------------------------
 * The plan locates the auth-plane endpoints under `/api/auth/...` and the
 * sibling T18/T20/T21 endpoints shipped at the same prefix. T56's Python
 * client must use `/api/auth/external-obtain-access-tokens` for HMAC
 * pathname agreement. Documented here so the next T57 author finds it.
 */

const logger = createLogger("api.auth.external-obtain-access-tokens");

// -- Request schema -----------------------------------------------------------

/**
 * Request body shape. Matches the Saleor `BasePlugin` client (T56)
 * `client.obtain_access_tokens(...)` flat send shape:
 *
 *   { code: <auth code>, state: <state token> }
 *
 * `saleorApiUrl` and `channelSlug` come from the verified HMAC headers.
 * `redirectUri` and `origin` are recovered by verifying `state` (minted by
 * T18, signed with `FIEF_PLUGIN_HMAC_SECRET`) — the Python client cannot
 * carry them through Saleor's `external_obtain_access_tokens` hook because
 * the hook only forwards `{code, state}`.
 */
const requestBodySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

// -- HTTP responses -----------------------------------------------------------

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// -- Token exchange types -----------------------------------------------------

/*
 * The Fief token-exchange response, as returned by T6's `exchangeCode`. We
 * augment with a `claims` bag because the route consumes id_token claims
 * (decoded) regardless of where the token client surfaces them. The wiring
 * decodes the id_token via T6's `verifyIdToken` and attaches the payload.
 *
 * Defensive shape: every field optional so a permissive Fief response (or
 * a future Fief schema addition) doesn't trip the route handler at runtime.
 */
const exchangeResponseSchema = z
  .object({
    accessToken: z.string().optional(),
    idToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresIn: z.number().optional(),
    tokenType: z.string().optional(),
    scope: z.string().optional(),
    claims: z.record(z.unknown()).optional(),
  })
  .passthrough();

/*
 * The user-claims subset we consume out of the Fief token-exchange's
 * `claims` bag. `sub` carries the Fief user UUID (canonical OIDC claim);
 * email / first_name / last_name are sourced from Fief's `userinfo`-style
 * fields. Everything else is opaque and forwarded to T14's projector.
 */
const fiefClaimsSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().email(),
    email_verified: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    is_active: z.boolean().optional(),
  })
  .passthrough();

type FiefClaims = z.infer<typeof fiefClaimsSchema>;

// -- Handler ------------------------------------------------------------------

const handler = async (req: NextRequest): Promise<Response> => {
  /*
   * T58's verifier consumes the body via `req.arrayBuffer()`. Clone first
   * so we can re-read JSON downstream — the cloned request is independent
   * and shares the underlying body stream until first read.
   */
  const reqForVerify = req.clone();
  const reqForBody = req.clone();

  const verifyResult = await verifyPluginRequest(reqForVerify, env.FIEF_PLUGIN_HMAC_SECRET);

  if (verifyResult.isErr()) {
    const error = verifyResult.error;

    logger.warn("HMAC verification failed", {
      errorBrand:
        error instanceof BadSignatureError
          ? "BadSignature"
          : error instanceof ExpiredError
          ? "Expired"
          : error instanceof ReplayError
          ? "Replay"
          : error instanceof MalformedError
          ? "Malformed"
          : "Unknown",
      errorMessage: error.message,
    });

    return jsonResponse(401, { error: "Unauthorized" });
  }

  // -- Parse + validate body -----------------------------------------------

  let bodyJson: unknown;

  try {
    bodyJson = await reqForBody.json();
  } catch (parseError) {
    logger.warn("Failed to parse request body as JSON", {
      errorMessage: parseError instanceof Error ? parseError.message : String(parseError),
    });

    return jsonResponse(400, { error: "Bad Request", message: "body is not valid JSON" });
  }

  const parsed = requestBodySchema.safeParse(bodyJson);

  if (!parsed.success) {
    logger.warn("Request body failed schema validation", {
      issues: parsed.error.issues,
    });

    return jsonResponse(400, {
      error: "Bad Request",
      message: "body did not match expected schema",
    });
  }

  const { code, state } = parsed.data;

  // -- Saleor identity from verified HMAC headers --------------------------

  const saleorApiUrlResult = createSaleorApiUrl(verifyResult.value.saleorApiUrl);

  if (saleorApiUrlResult.isErr()) {
    logger.warn("saleorApiUrl header failed brand validation", {
      saleorApiUrl: verifyResult.value.saleorApiUrl,
    });

    return jsonResponse(400, { error: "Bad Request", message: "invalid saleorApiUrl" });
  }

  const saleorApiUrl = saleorApiUrlResult.value;

  if (!verifyResult.value.channelSlug) {
    return jsonResponse(400, { error: "Bad Request", message: "missing channelSlug header" });
  }

  let channelSlug: ChannelSlug;

  try {
    channelSlug = createChannelSlug(verifyResult.value.channelSlug);
  } catch {
    return jsonResponse(400, { error: "Bad Request", message: "invalid channelSlug" });
  }

  // -- Recover redirectUri + origin from state token -----------------------

  const stateVerify = verifyStateToken(state, env.FIEF_PLUGIN_HMAC_SECRET);

  if (stateVerify.isErr()) {
    logger.warn("state token verification failed", {
      errorBrand: (stateVerify.error as { _brand?: string })._brand,
      errorMessage: stateVerify.error.message,
    });

    return jsonResponse(400, {
      error: "Bad Request",
      reason: "state-invalid",
      message: "OIDC state token failed verification",
    });
  }

  const { redirectUri, origin } = stateVerify.value;

  // -- Resolve dependencies ------------------------------------------------

  let deps: RouteDeps;

  try {
    deps = buildDeps();
  } catch (depsError) {
    logger.error("buildDeps threw — production wiring missing", {
      errorMessage: depsError instanceof Error ? depsError.message : String(depsError),
    });

    return jsonResponse(503, { error: "Service Unavailable" });
  }

  // -- Channel-scope resolution -------------------------------------------

  const resolution = await deps.channelResolver.resolve(saleorApiUrl, channelSlug);

  if (resolution.isErr()) {
    logger.error("ChannelResolver.resolve returned err", {
      errorMessage: resolution.error.message,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const resolved = resolution.value;

  if (resolved === null) {
    return jsonResponse(404, {
      error: "Not Found",
      message: "no connection bound to channel",
    });
  }

  if (resolved === DISABLED_CHANNEL) {
    return jsonResponse(403, {
      error: "Forbidden",
      reason: "channel-disabled",
      message: "channel opted out of Fief auth",
    });
  }

  const connection = resolved;

  // -- Decrypt per-connection secrets --------------------------------------

  const decryptedResult = await deps.connectionRepo.getDecryptedSecrets({
    saleorApiUrl,
    id: connection.id,
  });

  if (decryptedResult.isErr()) {
    logger.error("Failed to decrypt connection secrets", {
      errorMessage: decryptedResult.error.message,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const { fief: fiefSecrets } = decryptedResult.value;

  // -- Re-validate origin against connection allowlist ---------------------
  /*
   * The state-token already proves origin came from the same operator-trusted
   * mint at T18. Re-checking against `branding.allowedOrigins` catches the
   * case where the connection's allowlist was tightened *between* mint and
   * exchange — without a Mongo state store, this is the only way to drop a
   * still-valid (within 10-minute window) state token whose origin is no
   * longer permitted.
   */
  const allowedOriginStrings = connection.branding.allowedOrigins.map(
    (o) => o as unknown as string,
  );

  if (!allowedOriginStrings.includes(origin)) {
    logger.warn("State token origin no longer in connection allowedOrigins", {
      origin,
    });

    return jsonResponse(400, {
      error: "Bad Request",
      reason: "origin-not-allowed",
      message: "state token origin not in connection allowedOrigins",
    });
  }

  // -- Exchange code with Fief --------------------------------------------

  const oidcClient = new FiefOidcClient({ baseUrl: connection.fief.baseUrl });

  const clientSecrets = [fiefSecrets.clientSecret, fiefSecrets.pendingClientSecret].filter(
    (value): value is string => Boolean(value),
  );

  const exchangeResult = await oidcClient.exchangeCode({
    code,
    redirectUri,
    clientId: connection.fief.clientId as unknown as string,
    clientSecrets,
  });

  if (exchangeResult.isErr()) {
    const cause = (exchangeResult.error as { cause?: unknown }).cause;

    logger.error("Fief code exchange failed", {
      errorBrand: (exchangeResult.error as { _brand?: string })._brand,
      errorMessage: exchangeResult.error.message,
      upstream: cause,
    });

    /*
     * Surface the upstream Fief error in the response body. The endpoint is
     * HMAC-protected and only Saleor reaches it, so leaking the exact OIDC
     * error code (e.g. `invalid_grant`, `invalid_client`) is fine — and it's
     * the only signal an operator running `kubectl logs` can act on, since
     * the tslog instance is configured with `type: "hidden"`.
     */
    return jsonResponse(502, {
      error: "Bad Gateway",
      reason: "fief-exchange-failed",
      message: "upstream Fief code exchange failed",
      upstream: cause ?? exchangeResult.error.message,
    });
  }

  const exchangeParsed = exchangeResponseSchema.safeParse(exchangeResult.value);

  if (!exchangeParsed.success) {
    logger.error("Fief exchange response failed schema validation", {
      issues: exchangeParsed.error.issues,
    });

    return jsonResponse(502, {
      error: "Bad Gateway",
      reason: "fief-response-invalid",
      message: "Fief response did not match expected schema",
    });
  }

  // -- Extract Fief claims -------------------------------------------------

  const claimsResult = extractFiefClaims(exchangeParsed.data);

  if (claimsResult.isErr()) {
    logger.error("Failed to extract Fief user claims", {
      reason: claimsResult.error,
    });

    return jsonResponse(502, {
      error: "Bad Gateway",
      reason: "fief-claims-missing",
      message: "Fief response missing required user claims",
    });
  }

  const fiefClaims = claimsResult.value;

  // -- Race-safe identity bind --------------------------------------------

  const fiefUserIdParse = FiefUserIdSchema.safeParse(fiefClaims.sub);

  if (!fiefUserIdParse.success) {
    logger.error("Fief sub claim is not a valid Fief user UUID", {
      sub: fiefClaims.sub,
    });

    return jsonResponse(502, {
      error: "Bad Gateway",
      reason: "fief-sub-invalid",
      message: "Fief response sub is not a valid user uuid",
    });
  }

  const fiefUserId = fiefUserIdParse.data as unknown as FiefUserId;

  /*
   * Step A: lookup-or-provision. We want the existing `saleorUserId` if the
   * row already exists, otherwise we own the customerCreate.
   */
  const existingRowResult = await deps.identityMapRepo.getByFiefUser({
    saleorApiUrl,
    fiefUserId,
  });

  if (existingRowResult.isErr()) {
    logger.error("identity_map getByFiefUser failed", {
      errorMessage: existingRowResult.error.message,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const existingRow = existingRowResult.value;
  const lastSeenSeq = existingRow ? existingRow.lastSyncSeq : 0;

  let saleorUserId: SaleorUserId;
  let wasInserted = false;
  let isCustomerCreatedHere = false;

  if (existingRow) {
    saleorUserId = existingRow.saleorUserId;
  } else {
    /*
     * Cold path: create the Saleor customer THEN bind the identity_map.
     * The two-device race is resolved by T10's atomic upsert: if a
     * concurrent caller wins, our `wasInserted` comes back false and we
     * leak this customerCreate (next request observes the row + skips).
     * The leaked customer is acceptable — duplicate-email constraints on
     * the Saleor side prevent two customers landing for the same email,
     * so the second create either errors out (handled below) or succeeds
     * and the orphan row is reconciled by T30.
     *
     * NOTE: an alternative ordering — upsert first, customerCreate after
     * — would require a placeholder saleorUserId, which `IdentityMapRow`
     * doesn't support (the schema requires a non-empty branded id). The
     * "create-then-bind" order is the documented T19 contract.
     */
    const createResult = await deps.saleorClient.customerCreate({
      saleorApiUrl,
      email: fiefClaims.email,
      firstName: fiefClaims.first_name,
      lastName: fiefClaims.last_name,
      isActive: fiefClaims.is_active ?? true,
    });

    if (createResult.isErr()) {
      logger.error("Saleor customerCreate failed", {
        errorMessage: createResult.error.message,
      });

      return jsonResponse(500, {
        error: "Internal Server Error",
        reason: "saleor-customer-create-failed",
      });
    }

    saleorUserId = createResult.value.saleorUserId;
    isCustomerCreatedHere = true;
  }

  // -- Atomic upsert (race synchronization point) -------------------------

  const newSeqResult = createSyncSeq(lastSeenSeq + 1);

  if (newSeqResult.isErr()) {
    logger.error("Failed to construct bumped SyncSeq", {
      lastSeenSeq,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const candidateSeq = newSeqResult.value;

  const upsertResult = await deps.identityMapRepo.upsert({
    saleorApiUrl,
    saleorUserId,
    fiefUserId,
    syncSeq: candidateSeq,
  });

  if (upsertResult.isErr()) {
    logger.error("identity_map upsert failed", {
      errorMessage: upsertResult.error.message,
    });

    return jsonResponse(500, { error: "Internal Server Error" });
  }

  const { row: boundRow, wasInserted: rowWasInserted } = upsertResult.value;

  wasInserted = rowWasInserted;

  /*
   * If we created a customer above but lost the bind race, the canonical
   * `saleorUserId` is the one bound by the race winner (NOT the customer
   * we just created). Use the bound id for downstream writes so subsequent
   * requests converge on a single Saleor identity.
   */
  if (isCustomerCreatedHere && !wasInserted) {
    logger.warn("Lost identity_map bind race after customerCreate; using bound saleorUserId", {
      createdId: saleorUserId,
      boundId: boundRow.saleorUserId,
    });
  }

  saleorUserId = boundRow.saleorUserId;

  /*
   * Use the canonical row's seq (T10's storage-layer monotonic guard may
   * have left a higher value in place if a concurrent writer raced past).
   * Falls back to our candidate seq if the brand re-validation somehow
   * fails — the brand schema accepts any non-negative integer so this is
   * defensive only.
   */
  const writtenSeq: SyncSeq = createSyncSeq(boundRow.lastSyncSeq).unwrapOr(candidateSeq);

  // -- Write tagged metadata ----------------------------------------------

  const projection = projectClaimsToSaleorMetadata(connection.claimMapping, fiefClaims);
  /*
   * `tagWrite("fief", ...)` — the marker says "this write originated from
   * (and was processed on the FIEF side)". When the inevitable Saleor->Fief
   * mirror echo (CUSTOMER_UPDATED -> T26) sees this on the public bucket,
   * T13's `shouldSkip` drops the event because origin === processingSide.
   *
   * NOTE: T19 writes INTO Saleor but the marker side is "fief" (the side
   * that ORIGINATED the change — the Fief login flow). This is the
   * canonical pattern: target-the-marker-at-the-side-that-must-skip.
   */
  const tag = tagWrite("fief", writtenSeq);

  const finalMetadata = { ...projection.metadata, ...tag.metadata };
  const finalPrivateMetadata = { ...projection.privateMetadata, ...tag.privateMetadata };

  const metadataItems = toMetadataItems(finalMetadata);
  const privateMetadataItems = toMetadataItems(finalPrivateMetadata);

  const metadataResult = await deps.saleorClient.updateMetadata({
    saleorApiUrl,
    saleorUserId,
    items: metadataItems,
  });

  if (metadataResult.isErr()) {
    logger.error("Saleor updateMetadata failed", {
      errorMessage: metadataResult.error.message,
    });

    return jsonResponse(500, {
      error: "Internal Server Error",
      reason: "saleor-metadata-write-failed",
    });
  }

  const privateMetadataResult = await deps.saleorClient.updatePrivateMetadata({
    saleorApiUrl,
    saleorUserId,
    items: privateMetadataItems,
  });

  if (privateMetadataResult.isErr()) {
    logger.error("Saleor updatePrivateMetadata failed", {
      errorMessage: privateMetadataResult.error.message,
    });

    return jsonResponse(500, {
      error: "Internal Server Error",
      reason: "saleor-private-metadata-write-failed",
    });
  }

  // -- Shape claims for the Saleor plugin (T55) ---------------------------

  const shaped: ShapedSaleorPluginClaims = shapeUserClaimsForSaleorPlugin({
    saleorCustomer: {
      id: saleorUserId as unknown as string,
      email: fiefClaims.email,
      firstName: fiefClaims.first_name,
      lastName: fiefClaims.last_name,
      isActive: fiefClaims.is_active ?? true,
      /*
       * The route does NOT round-trip the existing Saleor customer
       * metadata (would require an extra GraphQL read on the hot path).
       * T55's merge layers Fief's projection on top of whatever we pass
       * in here; for v1 we pass our just-computed values directly so
       * the response reflects what we just wrote. The merge is still
       * correct because Fief projection wins on collision.
       */
      metadata: finalMetadata,
      privateMetadata: finalPrivateMetadata,
    },
    fiefClaims,
    claimMapping: connection.claimMapping,
  });

  logger.info("external-obtain-access-tokens completed", {
    saleorApiUrl,
    fiefUserId,
    saleorUserId,
    wasInserted,
    writtenSeq,
  });

  return jsonResponse(200, shaped as unknown as Record<string, unknown>);
};

// -- Helpers ------------------------------------------------------------------

/*
 * Extract the user-claims subset from the Fief exchange response. T6's
 * `exchangeCode` returns the raw token-endpoint shape (access_token, etc.);
 * the production wiring decodes the id_token via T6's `verifyIdToken` and
 * attaches the payload as `claims`. The route accepts either:
 *
 *   - A populated `claims` bag (production path, post-decode).
 *   - A token response with no claims attached (we treat this as a Fief
 *     misconfiguration and surface 502 — the Saleor plugin needs a sub
 *     to mint a session).
 */
const extractFiefClaims = (
  exchange: z.infer<typeof exchangeResponseSchema>,
): Result<FiefClaims, string> => {
  if (!exchange.claims) {
    return err("no claims attached");
  }

  const parsed = fiefClaimsSchema.safeParse(exchange.claims);

  if (!parsed.success) {
    return err(`claims failed validation: ${parsed.error.message}`);
  }

  return ok(parsed.data);
};

const toMetadataItems = (bag: Record<string, string>): Array<{ key: string; value: string }> =>
  Object.entries(bag).map(([key, value]) => ({ key, value }));

// -- Re-exports (for type consumers) ------------------------------------------
export type { ShapedSaleorPluginClaims };

/*
 * SaleorUserId is referenced by tests via the use-case import path, but it's
 * declared here too so the route's internal binding stays self-documenting.
 */
export type { SaleorUserId };

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);

/*
 * `SaleorCustomerClient` re-export keeps the dep graph centered on the
 * route's build-deps consumer; tests import the type directly from the
 * use-case module, but production wiring passes the same shape via
 * build-deps. Re-export here is informational only.
 */
export type { SaleorCustomerClient };
