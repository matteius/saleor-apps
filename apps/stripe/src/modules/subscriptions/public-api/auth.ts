/**
 * Two-layer auth for the public storefront-facing subscriptions API (T19a).
 *
 * The storefront cannot reach the internal tRPC router (gated by Saleor JWT
 * validated against Saleor JWKS) because it only has Fief-issued tokens. So
 * this module enforces an independent two-layer check before any route
 * handler under `src/app/api/public/subscriptions/*` runs:
 *
 *   Layer 1 — HMAC: header `X-Storefront-Auth: <hmac-sha256-hex>`. The HMAC
 *   is computed over `${path}\n${timestamp}\n${rawBody}` using
 *   `STOREFRONT_BRIDGE_SECRET` as the key. Header `X-Storefront-Timestamp`
 *   carries a UNIX timestamp (seconds) — we reject requests outside a 5-minute
 *   replay window to prevent capture-and-replay attacks. Comparison uses
 *   `crypto.timingSafeEqual` to avoid timing oracles.
 *
 *   Layer 2 — Fief JWT: header `Authorization: Bearer <jwt>`. Verified
 *   against `FIEF_JWKS_URL` via `jose.jwtVerify`. The `sub` claim is the Fief
 *   user ID; `email` is required for fan-out to Stripe Customer + Saleor User.
 *   Callers may optionally pass `expectedFiefUserId`/`expectedEmail` from the
 *   request body — if provided, we assert the JWT claims match. This catches
 *   "token of user A, body claims action for user B" cross-tenant abuse.
 *
 * Both layers must pass — failure at either returns a `Response` with the
 * appropriate status code that the route handler can return verbatim. On
 * success we return the verified claims so the route handler can use them
 * downstream.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const logger = createLogger("publicSubscriptionsAuth");

/**
 * Maximum age of an HMAC-signed request, in seconds. 5 minutes balances
 * legitimate clock skew between the storefront and the Stripe app deploy
 * against the window of opportunity for a replay attack on a sniffed request.
 */
export const HMAC_REPLAY_WINDOW_SECONDS = 5 * 60;

export const HEADER_HMAC = "x-storefront-auth";
export const HEADER_TIMESTAMP = "x-storefront-timestamp";
export const HEADER_AUTHORIZATION = "authorization";

export interface VerifiedFiefClaims {
  fiefUserId: string;
  email: string;
  raw: JWTPayload;
}

export interface AuthSuccess {
  ok: true;
  claims: VerifiedFiefClaims;
}

export interface AuthFailure {
  ok: false;
  response: Response;
}

export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthInput {
  request: Request;
  /** Raw body bytes — the same string that the route handler will JSON.parse. */
  rawBody: string;
  /** Path segment included in the HMAC payload (e.g. `/api/public/subscriptions/create`). */
  path: string;
  /** Optional expected `sub` claim — typically the body's `fiefUserId`. */
  expectedFiefUserId?: string;
  /** Optional expected `email` claim — typically the body's `email`. */
  expectedEmail?: string;
  /**
   * Optional injected JWKS factory for testing. Production callers omit
   * this so the helper builds one from `env.FIEF_JWKS_URL`.
   */
  jwksOverride?: ReturnType<typeof createRemoteJWKSet>;
  /** Optional clock override for testing the replay window. */
  nowSeconds?: () => number;
}

const unauthorized = (message: string): AuthFailure => ({
  ok: false,
  response: new Response(JSON.stringify({ error: "unauthorized", message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  }),
});

const serverConfigError = (message: string): AuthFailure => ({
  ok: false,
  response: new Response(JSON.stringify({ error: "server_misconfigured", message }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  }),
});

/**
 * HMAC payload = `${path}\n${timestamp}\n${rawBody}`.
 *
 * Including the path prevents an attacker from re-using a valid signature
 * from one route on another route. Including the timestamp prevents replay
 * even within a still-valid HMAC since we reject stale timestamps below.
 */
interface HmacPayload {
  path: string;
  timestamp: string;
  rawBody: string;
}

const computeHmac = (secret: string, payload: HmacPayload): string => {
  const message = `${payload.path}\n${payload.timestamp}\n${payload.rawBody}`;

  return createHmac("sha256", secret).update(message).digest("hex");
};

const safeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    /*
     * Length mismatch: fail fast but still in constant time relative to the
     * shorter input by comparing equal-length zeroed buffers.
     */
    const len = Math.max(a.length, b.length);

    timingSafeEqual(Buffer.alloc(len), Buffer.alloc(len));

    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
};

const verifyHmacLayer = (input: AuthInput): AuthFailure | null => {
  if (!env.STOREFRONT_BRIDGE_SECRET) {
    logger.warn("Public subscriptions API hit but STOREFRONT_BRIDGE_SECRET is not set");

    return serverConfigError("STOREFRONT_BRIDGE_SECRET not configured");
  }

  const hmacHeader = input.request.headers.get(HEADER_HMAC);
  const timestampHeader = input.request.headers.get(HEADER_TIMESTAMP);

  if (!hmacHeader || !timestampHeader) {
    return unauthorized(`Missing required header(s): ${HEADER_HMAC}, ${HEADER_TIMESTAMP}`);
  }

  const timestamp = Number(timestampHeader);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return unauthorized(`Header ${HEADER_TIMESTAMP} must be a positive UNIX timestamp`);
  }

  const now = input.nowSeconds ? input.nowSeconds() : Math.floor(Date.now() / 1000);
  const ageSeconds = Math.abs(now - timestamp);

  if (ageSeconds > HMAC_REPLAY_WINDOW_SECONDS) {
    logger.info("Rejecting public API request with stale timestamp", {
      ageSeconds,
      windowSeconds: HMAC_REPLAY_WINDOW_SECONDS,
    });

    return unauthorized(
      `Timestamp outside ${HMAC_REPLAY_WINDOW_SECONDS}-second replay window (age=${ageSeconds}s)`,
    );
  }

  const expected = computeHmac(env.STOREFRONT_BRIDGE_SECRET, {
    path: input.path,
    timestamp: timestampHeader,
    rawBody: input.rawBody,
  });

  if (!safeEqualHex(expected, hmacHeader)) {
    logger.info("Rejecting public API request with HMAC mismatch", { path: input.path });

    return unauthorized("HMAC signature mismatch");
  }

  return null;
};

const verifyFiefLayer = async (input: AuthInput): Promise<AuthFailure | VerifiedFiefClaims> => {
  const authHeader = input.request.headers.get(HEADER_AUTHORIZATION);

  if (!authHeader) {
    return unauthorized(`Missing ${HEADER_AUTHORIZATION} header`);
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader);

  if (!match) {
    return unauthorized(`${HEADER_AUTHORIZATION} header must be a Bearer token`);
  }

  const token = match[1];

  let jwks = input.jwksOverride;

  if (!jwks) {
    if (!env.FIEF_JWKS_URL) {
      logger.warn("Public subscriptions API hit but FIEF_JWKS_URL is not set");

      return serverConfigError("FIEF_JWKS_URL not configured");
    }

    jwks = createRemoteJWKSet(new URL(env.FIEF_JWKS_URL));
  }

  let payload: JWTPayload;

  try {
    const result = await jwtVerify(token, jwks);

    payload = result.payload;
  } catch (e) {
    logger.info("Fief JWT verification failed", { error: e });

    return unauthorized("Fief JWT verification failed");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : null;

  if (!sub) {
    return unauthorized("Fief JWT missing required `sub` claim");
  }

  if (!email) {
    return unauthorized("Fief JWT missing required `email` claim");
  }

  if (input.expectedFiefUserId !== undefined && input.expectedFiefUserId !== sub) {
    logger.info("Rejecting public API request — body fiefUserId vs JWT sub mismatch", {
      bodyFiefUserId: input.expectedFiefUserId,
      jwtSub: sub,
    });

    return unauthorized("Body `fiefUserId` does not match JWT `sub` claim");
  }

  if (
    input.expectedEmail !== undefined &&
    input.expectedEmail.toLowerCase() !== email.toLowerCase()
  ) {
    logger.info("Rejecting public API request — body email vs JWT email mismatch");

    return unauthorized("Body `email` does not match JWT `email` claim");
  }

  return { fiefUserId: sub, email, raw: payload };
};

/**
 * Run both auth layers in order (HMAC first — cheaper to fail) and return
 * either a `Response` (401/500) for the route handler to return as-is, or
 * the parsed Fief claims for downstream use.
 */
export const verifyPublicApiRequest = async (input: AuthInput): Promise<AuthResult> => {
  const hmacFailure = verifyHmacLayer(input);

  if (hmacFailure) {
    return hmacFailure;
  }

  const fiefResult = await verifyFiefLayer(input);

  if ("ok" in fiefResult) {
    return fiefResult;
  }

  return { ok: true, claims: fiefResult };
};
