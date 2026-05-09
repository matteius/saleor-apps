import * as crypto from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

/*
 * Stateless OIDC `state` token used by the Path A auth-plane.
 *
 * Why a custom state token
 * --------------------------------------------------------------------------
 * The Saleor `BasePlugin` HMAC client (T56) sends `external-obtain-access-tokens`
 * with body `{code, state}` only — no `redirectUri`. RFC 6749 §4.1.3 still
 * requires `redirect_uri` to match the value used in the original
 * `/authorize` call, so the Fief app has to recover it from somewhere.
 *
 * Carrying it inside the OIDC `state` keeps the round-trip stateless: the
 * Fief tenant preserves `state` verbatim (per OIDC spec) through the
 * authorize → user-login → callback → storefront → Saleor → Fief-app loop,
 * and we re-validate it on the way back. This avoids a Mongo round-trip
 * per login *and* removes the need for a per-storefront callback config.
 *
 * Wire format
 * --------------------------------------------------------------------------
 *   token = base64url(payload_json) + "." + lowercase_hex(sig)
 *
 *   payload_json = JSON.stringify({
 *     v: 1,                       // schema version
 *     n: <32 hex chars>,          // nonce, random
 *     r: <redirect uri>,          // string
 *     o: <origin>,                // string (URL.origin form)
 *     e: <unix seconds>,          // expiry
 *   })
 *
 *   sig = HMAC-SHA256(utf8(secret), utf8(base64url(payload_json)))
 *
 * Comparison via `crypto.timingSafeEqual` over decoded hex buffers. Secret
 * is interpreted as UTF-8 bytes (mirrors the rest of the auth-plane).
 *
 * Lifetime
 * --------------------------------------------------------------------------
 * 10 minutes. OIDC code exchange is expected within seconds; the user only
 * needs enough wall-clock time to complete the Fief login form. Reject
 * anything older to bound replay surface.
 */

// -- Errors -------------------------------------------------------------------

export const StateTokenError = BaseError.subclass("StateTokenError", {
  props: {
    _brand: "FiefApp.StateToken.Error" as const,
  },
});

export const MalformedStateError = StateTokenError.subclass("MalformedStateError", {
  props: {
    _brand: "FiefApp.StateToken.Error.Malformed" as const,
  },
});

export const BadSignatureStateError = StateTokenError.subclass("BadSignatureStateError", {
  props: {
    _brand: "FiefApp.StateToken.Error.BadSignature" as const,
  },
});

export const ExpiredStateError = StateTokenError.subclass("ExpiredStateError", {
  props: {
    _brand: "FiefApp.StateToken.Error.Expired" as const,
  },
});

export type StateTokenErrorInstance =
  | InstanceType<typeof MalformedStateError>
  | InstanceType<typeof BadSignatureStateError>
  | InstanceType<typeof ExpiredStateError>;

// -- Constants ----------------------------------------------------------------

export const STATE_TOKEN_LIFETIME_SECONDS = 600;

const STATE_VERSION = 1;

// -- Types --------------------------------------------------------------------

export interface MintInput {
  redirectUri: string;
  origin: string;
}

export interface VerifiedState {
  redirectUri: string;
  origin: string;
}

interface StatePayload {
  v: number;
  n: string;
  r: string;
  o: string;
  e: number;
}

// -- Helpers ------------------------------------------------------------------

const base64UrlEncode = (raw: string): string =>
  Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");

const base64UrlDecode = (raw: string): string => {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));

  return Buffer.from(padded + padding, "base64").toString("utf-8");
};

const computeSignature = (secret: string, payloadB64: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(payloadB64, "utf-8"))
    .digest("hex");

const isStatePayload = (value: unknown): value is StatePayload => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  return (
    typeof obj.v === "number" &&
    typeof obj.n === "string" &&
    typeof obj.r === "string" &&
    typeof obj.o === "string" &&
    typeof obj.e === "number"
  );
};

// -- API ----------------------------------------------------------------------

export const mintStateToken = (
  input: MintInput,
  secret: string,
  /* injectable for tests; defaults to current wall-clock */
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string => {
  const payload: StatePayload = {
    v: STATE_VERSION,
    n: crypto.randomBytes(16).toString("hex"),
    r: input.redirectUri,
    o: input.origin,
    e: nowSeconds + STATE_TOKEN_LIFETIME_SECONDS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = computeSignature(secret, payloadB64);

  return `${payloadB64}.${sig}`;
};

export const verifyStateToken = (
  token: string,
  secret: string,
  /* injectable for tests */
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Result<VerifiedState, StateTokenErrorInstance> => {
  const dot = token.lastIndexOf(".");

  if (dot <= 0 || dot === token.length - 1) {
    return err(new MalformedStateError("token missing payload/signature separator"));
  }
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  if (!/^[0-9a-f]+$/u.test(sig) || sig.length !== 64) {
    return err(new MalformedStateError("signature is not 64 lowercase hex chars"));
  }

  const expected = computeSignature(secret, payloadB64);
  let sigBuf: Buffer;
  let expectedBuf: Buffer;

  try {
    sigBuf = Buffer.from(sig, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    return err(new MalformedStateError("signature is not valid hex"));
  }
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return err(new BadSignatureStateError("HMAC signature mismatch"));
  }

  let raw: unknown;

  try {
    raw = JSON.parse(base64UrlDecode(payloadB64));
  } catch (cause) {
    return err(
      new MalformedStateError("payload is not valid JSON", {
        cause: cause as Error,
      }),
    );
  }
  if (!isStatePayload(raw)) {
    return err(new MalformedStateError("payload missing required fields"));
  }
  if (raw.v !== STATE_VERSION) {
    return err(new MalformedStateError(`unsupported state token version: ${String(raw.v)}`));
  }
  if (raw.e <= nowSeconds) {
    return err(new ExpiredStateError(`state token expired (e=${raw.e} now=${nowSeconds})`));
  }

  return ok({ redirectUri: raw.r, origin: raw.o });
};
