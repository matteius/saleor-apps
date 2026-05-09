import * as crypto from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import type { NonceStore } from "./nonce-store";

/*
 * T58 — apps/fief HMAC request verifier (Path A).
 *
 * Authentication boundary for the *auth-plane* endpoints (T18-T21) called by
 * the Saleor-side `BasePlugin` HMAC client (T56). Replaces T48's role for
 * those endpoints; T48 still gates async customer webhooks (T26-T29).
 *
 * Wire format -- MUST match the Saleor-side client byte-for-byte.
 * -----------------------------------------------------------------------------
 * Request headers (all values are ASCII; header *names* are case-insensitive
 * per RFC 7230, but the canonical form is what the client emits):
 *
 *   X-Fief-Plugin-Timestamp    Required. Unix seconds, base-10 integer.
 *   X-Fief-Plugin-Signature    Required. Lowercase hex of the HMAC.
 *   X-Fief-Plugin-Saleor-Url   Required. The Saleor instance URL the call is
 *                              about (carried back into the verified result
 *                              for logger/db scoping).
 *   X-Fief-Plugin-Channel      Optional. Saleor channel slug.
 *   X-Fief-Plugin-Connection   Optional. Provider-connection id (when the
 *                              Saleor side already knows it; new flows leave
 *                              this empty and the handler resolves it).
 *   X-Fief-Plugin-Nonce        Optional. Replay-guard token. When the caller
 *                              supplies a NonceStore in `opts`, the verifier
 *                              consumes the nonce atomically.
 *
 * Body hash:
 *   bodyHex = lowercase_hex( sha256( request_body_bytes ) )
 *
 *   - For requests without a body (GET, HEAD, no-body POST), the input to
 *     SHA-256 is the empty byte string and `bodyHex` is the well-known
 *     value
 *     `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
 *     Both sides MUST treat "no body" as "zero bytes" — *never* as the
 *     literal string "null", "{}", or omitted from the sign string.
 *
 * Sign string (UTF-8):
 *   `{METHOD}\n{PATHNAME}\n{TS}\n{BODY_HEX}`
 *
 *   - METHOD: uppercase HTTP verb (`req.method` is already uppercase under
 *     `fetch` semantics; we do not re-uppercase, the Python client MUST emit
 *     uppercase).
 *   - PATHNAME: `URL(req.url).pathname` -- *only* the path component. No
 *     query string, no fragment, no scheme/host. Trailing slash policy
 *     follows the URL bytes exactly: `/x/` and `/x` are different paths and
 *     the client MUST NOT normalize.
 *   - TS: the timestamp header value re-stringified via base-10 integer.
 *   - BODY_HEX: lowercase hex SHA-256 of the body bytes (above).
 *
 * HMAC:
 *   signature = lowercase_hex( hmac_sha256( utf8(secret), utf8(sign_string) ) )
 *
 *   - Secret is interpreted as a UTF-8 string and HMAC-key bytes are
 *     `secret.encode("utf-8")`. No base64/hex decoding step. Matches T15.
 *   - Comparison via `crypto.timingSafeEqual` over the decoded hex buffers.
 *
 * Skew window:
 *   `|now_seconds - ts| <= 300` (5 minutes, inclusive). Outside that window
 *   the request is rejected with `ExpiredError` regardless of HMAC validity.
 *   We check HMAC before skew so timing cannot leak whether a forged
 *   request's timestamp was past or future.
 *
 * Replay guard:
 *   Optional. When `opts.nonceStore` is set AND `X-Fief-Plugin-Nonce` is
 *   present, the verifier calls `nonceStore.claim(nonce)`. A `false` result
 *   yields `ReplayError`. v1 ships without a default adapter; the bound
 *   Mongo adapter lands as a follow-up (collection `plugin_auth_nonces`,
 *   TTL 5 min).
 */

// -- Errors -------------------------------------------------------------------

export const PluginAuthError = BaseError.subclass("PluginAuthError", {
  props: {
    _brand: "FiefApp.PluginAuth.Error" as const,
  },
});

export const MalformedError = PluginAuthError.subclass("MalformedError", {
  props: {
    _brand: "FiefApp.PluginAuth.Error.Malformed" as const,
  },
});

export const BadSignatureError = PluginAuthError.subclass("BadSignatureError", {
  props: {
    _brand: "FiefApp.PluginAuth.Error.BadSignature" as const,
  },
});

export const ExpiredError = PluginAuthError.subclass("ExpiredError", {
  props: {
    _brand: "FiefApp.PluginAuth.Error.Expired" as const,
  },
});

export const ReplayError = PluginAuthError.subclass("ReplayError", {
  props: {
    _brand: "FiefApp.PluginAuth.Error.Replay" as const,
  },
});

// -- Constants ----------------------------------------------------------------

/**
 * Maximum permissible difference between the request timestamp and the
 * verifier's wall-clock, in seconds. Hard-coded (not env-driven) so this
 * value is bit-for-bit identical to the Saleor-side `TIMESTAMP_SKEW_SECONDS`.
 */
const TIMESTAMP_SKEW_SECONDS = 300;

const HEADER_TS = "X-Fief-Plugin-Timestamp";
const HEADER_SIG = "X-Fief-Plugin-Signature";
const HEADER_SALEOR_URL = "X-Fief-Plugin-Saleor-Url";
const HEADER_CHANNEL = "X-Fief-Plugin-Channel";
const HEADER_CONNECTION = "X-Fief-Plugin-Connection";
const HEADER_NONCE = "X-Fief-Plugin-Nonce";

// -- Types --------------------------------------------------------------------

export interface VerifyPluginRequestOptions {
  /**
   * Optional replay-guard. When supplied AND the request carries a nonce
   * header, `claim(nonce)` is invoked and a `false` result fails the
   * verification with `ReplayError`. Without a store, nonce headers are
   * accepted but not consumed (caller's choice).
   */
  nonceStore?: NonceStore;
  /**
   * Optional clock injection for tests. Returns wall-clock seconds.
   * Defaults to `Math.floor(Date.now() / 1000)`. Tests using `vi.useFakeTimers`
   * do not need to set this; it exists for unit isolation in skew-edge tests.
   */
  nowSeconds?: () => number;
}

export interface VerifiedPluginRequest {
  saleorApiUrl: string;
  channelSlug?: string;
  connectionId?: string;
}

// -- Helpers ------------------------------------------------------------------

/**
 * Lowercase hex SHA-256 of a byte buffer. The Saleor-side Python client
 * computes the equivalent via stdlib SHA-256 over the body bytes,
 * lowercase-hex digested.
 */
const sha256Hex = (bodyBytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bodyBytes).digest("hex");

/**
 * Lowercase hex HMAC-SHA256 over `(utf8(secret), utf8(message))`.
 * The Saleor-side Python client constructs the equivalent via stdlib
 * HMAC-SHA256 with the secret encoded as UTF-8 and lowercase-hex output.
 */
const hmacHex = (secret: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

/**
 * Constant-time hex-string compare via `crypto.timingSafeEqual`. Returns
 * `false` when the buffers are different lengths (timingSafeEqual would
 * throw otherwise) -- which is what we want for a malformed-length input.
 */
const constantTimeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  /*
   * `Buffer.from(s, "hex")` silently drops non-hex chars and returns a
   * shorter buffer; if that happens, `timingSafeEqual` throws on length
   * mismatch and we treat that as not-equal.
   */
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");

    if (ab.length !== bb.length) {
      return false;
    }

    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
};

/**
 * `Number.parseInt` but rejects floats, leading whitespace, signs, scientific
 * notation, etc. The signer always emits a base-10 unsigned integer; anything
 * else is a malformed header.
 */
const parseUnsignedInt = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) ? value : null;
};

// -- Public API ---------------------------------------------------------------

/**
 * Verify a request signed by the Saleor-side `BasePlugin` HMAC client.
 *
 * Returns `Result.ok({ saleorApiUrl, channelSlug?, connectionId? })` on
 * success; otherwise a typed `PluginAuthError` subclass identifying the
 * specific failure (suitable for ops logs and the auth-plane endpoint's
 * 401/403 mapping).
 *
 * The body is read once via `req.arrayBuffer()`; callers MUST NOT have
 * consumed it earlier in the pipeline. Re-read the verified body via the
 * usual `req.clone().json()` (see T18-T21 handlers).
 */
export const verifyPluginRequest = async (
  req: Request,
  secret: string,
  opts: VerifyPluginRequestOptions = {},
): Promise<Result<VerifiedPluginRequest, InstanceType<typeof PluginAuthError>>> => {
  const tsRaw = req.headers.get(HEADER_TS);
  const sigRaw = req.headers.get(HEADER_SIG);
  const saleorUrlRaw = req.headers.get(HEADER_SALEOR_URL);

  if (!tsRaw) {
    return err(new MalformedError(`missing ${HEADER_TS} header`));
  }
  if (!sigRaw) {
    return err(new MalformedError(`missing ${HEADER_SIG} header`));
  }
  if (!saleorUrlRaw) {
    return err(new MalformedError(`missing ${HEADER_SALEOR_URL} header`));
  }

  const ts = parseUnsignedInt(tsRaw);

  if (ts === null) {
    return err(new MalformedError(`${HEADER_TS} must be a base-10 unsigned integer`));
  }

  /*
   * Hex-validate the signature shape early. SHA-256 = 32 bytes = 64 hex
   * chars (lowercase). Anything else is structurally wrong; we surface as
   * Malformed for ops readability.
   */
  if (!/^[0-9a-f]{64}$/.test(sigRaw)) {
    return err(new MalformedError(`${HEADER_SIG} must be 64 lowercase hex chars (SHA-256 length)`));
  }

  // -- Reconstruct the sign string -------------------------------------------

  /*
   * `req.arrayBuffer()` consumes the body stream. The Request object passed
   * here is intended to be exclusively read by this verifier; downstream
   * handlers receive the body via the `bodyBytes` returned to the caller,
   * or by re-reading from a cloned upstream request before this call.
   */
  const bodyArrayBuffer = await req.arrayBuffer();
  const bodyBytes = new Uint8Array(bodyArrayBuffer);
  const bodyHex = sha256Hex(bodyBytes);

  let pathname: string;

  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return err(new MalformedError("request URL is unparseable"));
  }

  const message = `${req.method}\n${pathname}\n${ts}\n${bodyHex}`;
  const expectedSig = hmacHex(secret, message);

  /*
   * HMAC verification first (before skew check) so timing does not leak
   * whether a forged request's timestamp was past or future.
   */
  if (!constantTimeEqualHex(expectedSig, sigRaw)) {
    return err(new BadSignatureError("HMAC mismatch"));
  }

  // -- Skew check ------------------------------------------------------------

  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();

  if (Math.abs(now - ts) > TIMESTAMP_SKEW_SECONDS) {
    return err(
      new ExpiredError(
        `timestamp out of skew window (${TIMESTAMP_SKEW_SECONDS}s); now=${now}, ts=${ts}`,
      ),
    );
  }

  // -- Replay guard ----------------------------------------------------------

  const nonce = req.headers.get(HEADER_NONCE);

  if (opts.nonceStore && nonce) {
    const claim = await opts.nonceStore.claim(nonce);

    if (!claim.ok) {
      return err(new ReplayError("nonce already seen"));
    }
  }

  // -- Success ---------------------------------------------------------------

  const channelSlug = req.headers.get(HEADER_CHANNEL);
  const connectionId = req.headers.get(HEADER_CONNECTION);

  return ok({
    saleorApiUrl: saleorUrlRaw,
    channelSlug: channelSlug ?? undefined,
    connectionId: connectionId ?? undefined,
  });
};
