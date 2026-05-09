// cspell:ignore decryptor

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
import { FiefOidcClient } from "@/modules/fief-client/oidc-client";
import { verifyPluginRequest } from "@/modules/plugin-auth/hmac-verifier";
import {
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";

import { buildChannelConfigurationRepo, buildProviderConnectionRepo } from "./deps";

/*
 * T21 — `POST /api/auth/external-logout`
 *
 * Path A endpoint called by the Saleor `BasePlugin` HMAC client (T56/T57)
 * when Saleor's `externalLogout` mutation runs. **Best-effort revoke** —
 * the user is logging out of Saleor whether or not the Fief revocation
 * succeeds, so this endpoint always returns `{ ok: true }` (HTTP 200) on
 * any path that authenticated successfully.
 *
 * Path-coordination note (T57 wiring):
 * --------------------------------------
 * The plan locates the auth-plane endpoints under `/api/auth/...` and the
 * sibling T18 endpoint shipped at the same prefix. T56's Python client
 * currently has `PATH_LOGOUT = "/api/plugin/external-logout"` (locked by
 * a byte-lock fixture). When T57 lands, the `PATH_*` constants in
 * `saleor/plugins/fief/client.py` must be updated to `/api/auth/...` to
 * match this route — the HMAC sign string includes the URL pathname, so
 * any drift between the Python signer and the Node verifier here makes
 * every signed call fail closed. T18 already chose `/api/auth/...`; this
 * task follows that decision so the four auth-plane endpoints land under
 * a single coherent prefix.
 *
 * Failure modes that DO surface:
 *   - bad HMAC -> 401 (only place we leak failure info to the caller; the
 *     caller cannot recover without rotating the shared secret).
 *
 * Failure modes that are **swallowed** (logged + return 200):
 *   - channel-resolver errors -> we cannot find the connection, so we
 *     cannot revoke; logout still succeeds at the Saleor layer.
 *   - missing connection / disabled channel -> nothing to revoke against.
 *   - decryption errors -> ditto.
 *   - Fief revoke endpoint errors (Err result OR thrown) -> Fief 0.x does
 *     not advertise a `revocation_endpoint`; the OIDC client surfaces a
 *     typed `FiefOidcRevokeError` in that case and we just degrade.
 *
 * Performance budget (p95 < 200ms):
 *   - 1 Mongo read (channel-resolver) + 1 Mongo read (decrypted secrets) +
 *     1 outbound HTTP call to Fief.
 *   - When `refreshToken` is absent we skip the second Mongo read AND the
 *     Fief call entirely — the endpoint becomes a verify-and-ack.
 */

const logger = createLogger("api.auth.external-logout");

const requestBodySchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

/**
 * Always-200 best-effort logout response.
 *
 * Encoded as JSON so the Python client (T56) can parse via the same
 * `response.json()` path it uses for all other plugin endpoints.
 */
const okResponse = (): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const unauthorizedResponse = (reason: string): Response =>
  new Response(JSON.stringify({ error: "Unauthorized", reason }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

const handler = async (req: NextRequest): Promise<Response> => {
  /*
   * Read the body bytes once so we can pass them both to the HMAC verifier
   * (which expects an unread stream) and to our own JSON parse. We
   * re-construct a Request for the verifier from the same bytes — this is
   * required because `verifyPluginRequest` consumes `req.arrayBuffer()`.
   */
  let bodyBytes: Buffer;

  try {
    bodyBytes = Buffer.from(await req.arrayBuffer());
  } catch (cause) {
    logger.warn("Failed to read external-logout request body", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return unauthorizedResponse("body-unreadable");
  }

  /*
   * Snapshot the headers so the verifier sees the same Headers object even
   * though we rebuild the Request from the bytes.
   */
  const headers = new Headers();

  req.headers.forEach((value, key) => {
    headers.set(key, value);
  });

  const verifierRequest = new Request(req.url, {
    method: req.method,
    headers,
    body: bodyBytes,
  });

  const verified = await verifyPluginRequest(verifierRequest, env.FIEF_PLUGIN_HMAC_SECRET);

  if (verified.isErr()) {
    logger.warn("external-logout HMAC verification failed", {
      errorBrand: verified.error._brand,
      errorMessage: verified.error.message,
    });

    return unauthorizedResponse("hmac-invalid");
  }

  const { saleorApiUrl, channelSlug } = verified.value;

  /*
   * Parse the body. A malformed body is logged but does NOT fail the
   * request — best-effort logout. We just skip the revoke step.
   */
  let parsedBody: z.infer<typeof requestBodySchema> = {};

  if (bodyBytes.length > 0) {
    try {
      const json: unknown = JSON.parse(bodyBytes.toString("utf-8"));
      const parseResult = requestBodySchema.safeParse(json);

      if (parseResult.success) {
        parsedBody = parseResult.data;
      } else {
        logger.warn("external-logout body failed schema validation; logging out without revoke", {
          issueCount: parseResult.error.issues.length,
        });
      }
    } catch (cause) {
      logger.warn("external-logout body was not valid JSON; logging out without revoke", {
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const refreshToken = parsedBody.refreshToken;

  // Fast path: no refresh token to revoke -> done.
  if (refreshToken === undefined) {
    logger.info("external-logout: no refresh token supplied, returning ok", {
      saleorApiUrl,
      channelSlug,
    });

    return okResponse();
  }

  /*
   * Resolve the channel scope to find the connection. Channel header is
   * optional; when absent, we cannot scope the resolver call so we degrade
   * to "no connection" and skip the revoke.
   */
  if (channelSlug === undefined) {
    logger.info("external-logout: no channel slug; cannot resolve connection, skipping revoke", {
      saleorApiUrl,
    });

    return okResponse();
  }

  const connection = await safelyResolveConnection(saleorApiUrl, channelSlug);

  if (connection === null) {
    return okResponse();
  }

  /*
   * Decrypt the client secret pair — needed for `client_secret_post` on the
   * Fief revocation endpoint (RFC 7009 §2.1).
   */
  const decryptedSecrets = await safelyGetDecryptedSecrets(saleorApiUrl, connection.id);

  if (decryptedSecrets === null) {
    return okResponse();
  }

  const clientSecrets = [
    decryptedSecrets.clientSecret,
    decryptedSecrets.pendingClientSecret,
  ].filter((value): value is string => Boolean(value));

  await safelyRevoke({
    baseUrl: connection.fief.baseUrl,
    clientId: connection.fief.clientId,
    clientSecrets,
    refreshToken,
  });

  return okResponse();
};

/**
 * Run the channel resolver in best-effort mode: any error or "disabled" /
 * "no config" outcome returns `null` (caller skips revoke). Production
 * connection rows are returned as-is so the caller can read `id` + `fief`.
 */
const safelyResolveConnection = async (
  saleorApiUrl: string,
  channelSlug: string,
): Promise<ProviderConnection | null> => {
  try {
    const channelConfigurationRepo = buildChannelConfigurationRepo();
    const providerConnectionRepo = buildProviderConnectionRepo();
    const cache = createChannelResolverCache();

    const resolver = new ChannelResolver({
      channelConfigurationRepo,
      providerConnectionRepo,
      cache,
    });

    /*
     * Cast at the brand boundary. Both `SaleorApiUrl` and `ChannelSlug` are
     * thin Zod brands over strings; the values are sourced from headers
     * already validated by the HMAC verifier (the saleor URL header is
     * required and the channel slug header is a non-empty optional). We
     * deliberately do NOT re-parse here — failing schema validation on a
     * logout would surface as a 200-with-no-revoke anyway.
     */
    const result = await resolver.resolve(
      saleorApiUrl as ProviderConnection["saleorApiUrl"],
      channelSlug as ChannelSlug,
    );

    if (result.isErr()) {
      logger.warn("external-logout: channel-resolver returned Err; skipping revoke", {
        saleorApiUrl,
        channelSlug,
        errorMessage: result.error.message,
      });

      return null;
    }

    const resolution = result.value;

    if (resolution === null) {
      logger.info("external-logout: no connection configured for channel; skipping revoke", {
        saleorApiUrl,
        channelSlug,
      });

      return null;
    }

    if (resolution === DISABLED_CHANNEL) {
      logger.info("external-logout: channel is disabled; skipping revoke", {
        saleorApiUrl,
        channelSlug,
      });

      return null;
    }

    return resolution;
  } catch (cause) {
    logger.warn("external-logout: unexpected error resolving channel; skipping revoke", {
      saleorApiUrl,
      channelSlug,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return null;
  }
};

/**
 * Fetch decrypted client secrets in best-effort mode. Any error logs +
 * returns `null` so the caller skips the revoke and still returns 200.
 */
const safelyGetDecryptedSecrets = async (
  saleorApiUrl: string,
  connectionId: ProviderConnectionId,
): Promise<{ clientSecret: string; pendingClientSecret: string | null } | null> => {
  try {
    const repo = buildProviderConnectionRepo();
    const result = await repo.getDecryptedSecrets({
      saleorApiUrl: saleorApiUrl as ProviderConnection["saleorApiUrl"],
      id: connectionId,
    });

    if (result.isErr()) {
      logger.warn("external-logout: failed to decrypt connection secrets; skipping revoke", {
        saleorApiUrl,
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
    logger.warn(
      "external-logout: unexpected error decrypting connection secrets; skipping revoke",
      {
        saleorApiUrl,
        connectionId,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      },
    );

    return null;
  }
};

/**
 * Best-effort `revokeToken` call. Errors are logged at `warn` (not `error`)
 * because Fief 0.x not advertising a revocation endpoint is the *expected*
 * v1 state — a `FiefOidcRevokeError` from the discovery doc is operational
 * noise, not an alert-worthy event. Network-level failures are also logged
 * but never surfaced to the caller.
 */
const safelyRevoke = async (input: {
  baseUrl: string;
  clientId: string;
  clientSecrets: string[];
  refreshToken: string;
}): Promise<void> => {
  if (input.clientSecrets.length === 0) {
    logger.warn("external-logout: no decrypted client secrets available; skipping revoke");

    return;
  }

  try {
    const oidcClient = new FiefOidcClient({ baseUrl: input.baseUrl });

    const result = await oidcClient.revokeToken({
      token: input.refreshToken,
      tokenTypeHint: "refresh_token",
      clientId: input.clientId,
      clientSecrets: input.clientSecrets,
    });

    if (result.isErr()) {
      logger.warn("external-logout: Fief revoke returned Err; logout still succeeds", {
        errorBrand: (result.error as { _brand?: string })._brand,
        errorMessage: result.error.message,
      });
    }
  } catch (cause) {
    logger.warn("external-logout: Fief revoke threw; logout still succeeds", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
