import { compose } from "@saleor/apps-shared/compose";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { mintStateToken } from "@/modules/auth-state/state-token";
import { sign as signBrandingOrigin } from "@/modules/branding/origin-signer";
import {
  type ChannelSlug,
  createChannelSlug,
  DISABLED_CHANNEL,
} from "@/modules/channel-configuration/channel-configuration";
import { type ChannelResolver } from "@/modules/channel-configuration/channel-resolver";
import {
  BadSignatureError,
  ExpiredError,
  MalformedError,
  ReplayError,
  verifyPluginRequest,
} from "@/modules/plugin-auth/hmac-verifier";
import { type ProviderConnection } from "@/modules/provider-connections/provider-connection";
import { type ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { buildDeps } from "./build-deps";

/*
 * T18 — `POST /api/auth/external-authentication-url` (Path A).
 *
 * Saleor's `external_authentication_url(...)` plugin hook (T56/T57) calls
 * this endpoint to obtain the Fief OIDC `/authorize` URL the storefront
 * should redirect to. Wire format details — request shape, HMAC scheme,
 * authorize-URL params — are pinned by `route.test.ts` so contract drift
 * surfaces as a unit-test break.
 *
 * Pipeline (latency budget: p95 < 200ms):
 *
 *   1. Read body + verify HMAC via T58 (`verifyPluginRequest`) using the
 *      install-level shared secret (`FIEF_PLUGIN_HMAC_SECRET` from env).
 *      Per the Path A v1 design this secret is **install-level** rather
 *      than per-connection: at this point in the pipeline we have not yet
 *      resolved the connection (channel-scope resolution happens AFTER
 *      auth), so a per-connection secret would require resolving the
 *      connection BEFORE we know the request is trustworthy — which lets
 *      an unauthenticated caller probe the channel-scope resolver. The
 *      install-level secret keeps auth purely cryptographic.
 *
 *   2. Resolve the connection via T12's `ChannelResolver`:
 *        - `null` ⇒ 404 (no connection bound to channel).
 *        - `"disabled"` ⇒ 403 (operator opted channel out of Fief auth).
 *        - `ProviderConnection` ⇒ continue.
 *
 *   3. Decrypt the per-connection signing key via T8's `getDecryptedSecrets`.
 *
 *   4. Validate that the request `origin` is in the connection's
 *      `branding.allowedOrigins`. Origin-not-in-allowlist is a *client*
 *      error (the Saleor plugin handed us an origin we don't trust), so
 *      400 — distinct from 403 which we reserve for "operator opted this
 *      channel out".
 *
 *   5. Build the Fief authorize URL and return `{ authorizationUrl }`.
 *
 * IO budget: 1 Mongo read for channel-config + 1 Mongo read for connection
 * (both cached in T12's per-request cache) + 1 in-memory branding sign.
 * State token is a random 32-byte hex value; storefront round-trips it
 * back to T19's `external-obtain-access-tokens` for CSRF binding.
 */

const logger = createLogger("api.auth.external-authentication-url");

// -- Request schema -----------------------------------------------------------

/**
 * Request body shape. Matches Saleor `BasePlugin` client (T56)
 * `client.authentication_url(...)` flat send shape:
 *
 *   { redirectUri: <url>, saleorUserId?: <string> }
 *
 * `saleorApiUrl` and `channelSlug` are read from the HMAC-signed headers
 * (`X-Fief-Plugin-Saleor-Url` / `X-Fief-Plugin-Channel`) — same convention
 * as `external-refresh` and `external-logout`. Carrying them in the body
 * would be redundant and would diverge from the Python client.
 *
 * The storefront `origin` is derived from `redirectUri` (URL.origin) instead
 * of being a separate field — the Python client doesn't carry it, and the
 * authorize-URL branding overlay only needs a value the connection's
 * `branding.allowedOrigins` can be cross-checked against.
 *
 * The OIDC `state` token is *not* a body field: this route mints it (see
 * `mintStateToken`) so it can carry `redirectUri` + `origin` through the
 * Fief round-trip and have `external-obtain-access-tokens` recover them
 * without a Mongo session store.
 */
const requestBodySchema = z.object({
  redirectUri: z.string().url(),
  saleorUserId: z.string().min(1).optional(),
});

// -- HTTP responses -----------------------------------------------------------

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// -- Authorize-URL builder ----------------------------------------------------

interface BuildAuthorizeUrlInput {
  connection: ProviderConnection;
  redirectUri: string;
  origin: string;
  signingKey: string;
  state: string;
}

/**
 * Build the Fief OIDC `/authorize` URL with all required params + a signed
 * `branding_origin` produced by T15.
 *
 * `state` is the HMAC-signed token minted by `mintStateToken` — it carries
 * the `redirectUri` + `origin` so `external-obtain-access-tokens` can
 * recover them when the Saleor plugin (which only sends `{code, state}`)
 * forwards the callback. CSRF binding against the storefront's session
 * cookie lives on the storefront/Saleor side (Saleor's standard
 * `csrf_token` mechanism on the `external*` plugin methods).
 */
const buildAuthorizeUrl = (input: BuildAuthorizeUrlInput): string => {
  const url = new URL("/authorize", input.connection.fief.baseUrl);

  /*
   * The 5 OIDC params + `branding_origin` are appended in a deterministic
   * order so the resulting URL is stable across Node runs (helps integration
   * snapshot tests downstream; not strictly required for OIDC).
   */
  url.searchParams.set("client_id", input.connection.fief.clientId as unknown as string);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("branding_origin", signBrandingOrigin(input.origin, input.signingKey));

  return url.toString();
};

// -- Handler ------------------------------------------------------------------

const handler = async (req: NextRequest): Promise<Response> => {
  /*
   * The HMAC verifier consumes the body via `req.arrayBuffer()`. Clone first
   * so we can re-read JSON downstream — the cloned request is independent
   * and shares the underlying body stream until first read.
   */
  const reqForVerify = req.clone();
  const reqForBody = req.clone();

  const verifyResult = await verifyPluginRequest(reqForVerify, env.FIEF_PLUGIN_HMAC_SECRET);

  if (verifyResult.isErr()) {
    const error = verifyResult.error;

    /*
     * Bad signature / malformed headers / expired ts / replay all surface
     * as 401: from the caller's perspective the request was not
     * authenticated. We log the specific subclass so ops can distinguish.
     */
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

  const { redirectUri } = parsed.data;

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

  // -- Derive storefront origin from redirectUri ---------------------------

  let origin: string;

  try {
    origin = new URL(redirectUri).origin;
  } catch {
    return jsonResponse(400, { error: "Bad Request", message: "invalid redirectUri" });
  }

  // -- Resolve connection via channel-scope --------------------------------

  let deps: { channelResolver: ChannelResolver; connectionRepo: ProviderConnectionRepo };

  try {
    deps = buildDeps();
  } catch (depsError) {
    logger.error("buildDeps threw — production wiring missing", {
      errorMessage: depsError instanceof Error ? depsError.message : String(depsError),
    });

    return jsonResponse(503, { error: "Service Unavailable" });
  }

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

  // -- Validate origin against connection allowlist ------------------------

  const allowedOriginStrings = connection.branding.allowedOrigins.map(
    (o) => o as unknown as string,
  );

  if (!allowedOriginStrings.includes(origin)) {
    logger.warn("Derived storefront origin not in connection allowedOrigins", {
      origin,
    });

    return jsonResponse(400, {
      error: "Bad Request",
      reason: "origin-not-allowed",
      message: "redirectUri origin not in connection allowedOrigins",
    });
  }

  // -- Decrypt per-connection signing key ----------------------------------

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

  const signingKey = decryptedResult.value.branding.signingKey;

  // -- Build + return authorize URL ----------------------------------------

  const state = mintStateToken({ redirectUri, origin }, env.FIEF_PLUGIN_HMAC_SECRET);

  const authorizationUrl = buildAuthorizeUrl({
    connection,
    redirectUri,
    origin,
    signingKey,
    state,
  });

  return jsonResponse(200, { authorizationUrl });
};

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
