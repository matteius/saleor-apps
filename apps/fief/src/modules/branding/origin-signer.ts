import * as crypto from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

/*
 * T15 — `branding_origin` signer + verifier (Saleor side).
 *
 * Wire format -- MUST match the Fief-side verifier exactly.
 * --------------------------------------------------------------------------
 * Token:    "{origin}.{nonce}.{expiry}.{sig}"
 * Message:  "{origin}.{nonce}.{expiry}"           (UTF-8 bytes)
 * Sig:      lowercase hex digest of HMAC-SHA256(signingKey_utf8, message)
 * Expiry:   base-10 unix-seconds integer; expiry >= now() to be valid.
 * Nonce:    16 lowercase hex chars by default (random 8 bytes).
 *
 * The reference verifier lives at
 * `fief/services/branding/origin_verifier.py` in the companion Fief repo,
 * and parses tokens by right-splitting on '.' (limit 3) so origins (which
 * always contain dots) are preserved intact. The signing key is consumed
 * by the verifier as a UTF-8 byte string -- we mirror that here by passing
 * the key through `Buffer.from(key, "utf-8")` into `createHmac`.
 *
 * Replay protection
 * --------------------------------------------------------------------------
 * Deliberately TRADED for short expiry (5 minutes). The Fief verifier also
 * caps the future-expiry window at 5 minutes, so a token's useful lifetime
 * is bounded on both sides without a shared replay cache. If we ever need
 * stricter guarantees (e.g. PCI-class), introduce a per-nonce TTL cache on
 * the Fief side and lock the nonce to a single use; the wire format does
 * not need to change for that upgrade.
 *
 * Allowlist enforcement
 * --------------------------------------------------------------------------
 * `verify` requires `allowedOrigins` to include the parsed origin even when
 * the HMAC validates. The HMAC alone tells us "this token was minted by a
 * holder of the signing key", not "the operator approved this origin". The
 * Fief side enforces its own allowlist (host-of-redirect-uri match) as a
 * second layer.
 */

// -- Errors -------------------------------------------------------------------

export const BrandingOriginError = BaseError.subclass("BrandingOriginError", {
  props: {
    _brand: "FiefApp.Branding.OriginError" as const,
  },
});

export const MalformedError = BrandingOriginError.subclass("MalformedError", {
  props: {
    _brand: "FiefApp.Branding.OriginError.Malformed" as const,
  },
});

export const OriginNotAllowedError = BrandingOriginError.subclass("OriginNotAllowedError", {
  props: {
    _brand: "FiefApp.Branding.OriginError.OriginNotAllowed" as const,
  },
});

export const ExpiredError = BrandingOriginError.subclass("ExpiredError", {
  props: {
    _brand: "FiefApp.Branding.OriginError.Expired" as const,
  },
});

export const BadSignatureError = BrandingOriginError.subclass("BadSignatureError", {
  props: {
    _brand: "FiefApp.Branding.OriginError.BadSignature" as const,
  },
});

// -- Constants ----------------------------------------------------------------

/**
 * Token lifetime in seconds. Hard-coded (not env-driven) so the value is
 * bit-for-bit identical to the Fief-side `TOKEN_MAX_AGE_SECONDS`. If this ever
 * needs to change, both sides must move together.
 */
const DEFAULT_EXPIRY_SECONDS = 5 * 60;

/** Default nonce length: 8 random bytes -> 16 lowercase hex chars. */
const DEFAULT_NONCE_BYTES = 8;

// -- Helpers ------------------------------------------------------------------

/**
 * HMAC-SHA256 lowercase-hex digest. Matches the Python verifier's
 * standard-library HMAC-SHA256 over `key.encode("utf-8")` + `message`,
 * returning the lowercase hex string of the resulting 32-byte digest.
 */
const hmacHex = (signingKey: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(signingKey, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

/**
 * Constant-time hex-string compare via `crypto.timingSafeEqual`. Returns
 * `false` when the buffers are different lengths (timingSafeEqual would
 * throw otherwise), which is what we want for malformed signatures.
 */
const constantTimeEqualHex = (a: string, b: string): boolean => {
  /*
   * Both inputs are caller-supplied hex strings; if they aren't the same
   * length, no further comparison is meaningful and `timingSafeEqual` would
   * throw on mismatched buffer lengths.
   */
  if (a.length !== b.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    /*
     * Non-hex characters slip through `Buffer.from(..., "hex")` as truncated
     * bytes; if the resulting buffer lengths still mismatch we reject.
     */
    return false;
  }
};

// -- Public API ---------------------------------------------------------------

/**
 * Sign a branding-origin token.
 *
 * The 4-arity signature is locked by the T15 plan + the Fief-side verifier
 * contract: tests and integration callers pin nonce/expiry via positional
 * arguments to assert byte-level wire compatibility, so an options bag would
 * obscure the relationship to the verifier's `(origin, key, nonce, expiry)`
 * tuple. The `max-params` rule is suppressed here for that reason only.
 *
 * @param origin           Storefront origin URL (e.g. `https://shop-a.example.com`).
 * @param signingKey       Per-connection branding signing key (UTF-8 string).
 * @param nonce            Optional nonce; defaults to 16 lowercase hex chars
 *                         from `crypto.randomBytes(8)`.
 * @param expirySeconds    Optional unix-seconds absolute expiry; defaults to
 *                         `floor(Date.now() / 1000) + 5*60`.
 * @returns `"{origin}.{nonce}.{expiry}.{sig}"`.
 */
/* eslint-disable @typescript-eslint/max-params -- positional arity locked by T15 spec */
export const sign = (
  origin: string,
  signingKey: string,
  nonce?: string,
  expirySeconds?: number,
): string => {
  const resolvedNonce = nonce ?? crypto.randomBytes(DEFAULT_NONCE_BYTES).toString("hex");
  const resolvedExpiry = expirySeconds ?? Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS;

  const message = `${origin}.${resolvedNonce}.${resolvedExpiry}`;
  const sig = hmacHex(signingKey, message);

  return `${message}.${sig}`;
};
/* eslint-enable @typescript-eslint/max-params */

/**
 * Verify a branding-origin token. Returns `Result.ok({ origin })` only when
 * every check passes; otherwise returns a typed `BrandingOriginError`
 * subclass identifying the specific failure mode (suitable for ops logs).
 *
 * Mandatory checks (in order):
 *   1. Token splits into exactly 4 non-empty segments via right-split on '.'
 *      (limit 3). Same as the Fief verifier — origins contain dots, so a
 *      right-aware split is required to keep them intact.
 *   2. Expiry is a base-10 integer.
 *   3. HMAC matches (constant-time compare via `crypto.timingSafeEqual`).
 *   4. Expiry >= wall-clock now (in unix seconds).
 *   5. Parsed origin is present in `allowedOrigins`.
 *
 * Order matters: the HMAC check runs before the expiry check so timing
 * cannot leak whether a forged token's expiry was past or future.
 */
export const verify = (
  token: string,
  signingKey: string,
  allowedOrigins: string[],
): Result<{ origin: string }, InstanceType<typeof BrandingOriginError>> => {
  if (!token) {
    return err(new MalformedError("token is empty"));
  }

  /*
   * Right-split so an origin containing '.' (every URL does) survives intact.
   * String.prototype.split has no native right-split-with-limit;
   * `splitFromRight` below walks `lastIndexOf` `n` times to reproduce it.
   */
  const parts = splitFromRight(token, ".", 3);

  if (parts.length !== 4) {
    return err(new MalformedError("token must have 4 dot-separated segments"));
  }

  const [origin, nonce, expiryStr, signature] = parts;

  if (!origin || !nonce || !expiryStr || !signature) {
    return err(new MalformedError("token segments must be non-empty"));
  }

  // Expiry must be a base-10 integer; the signer always emits one.
  if (!/^\d+$/.test(expiryStr)) {
    return err(new MalformedError("expiry segment must be a base-10 integer"));
  }

  const expiry = Number.parseInt(expiryStr, 10);

  if (!Number.isFinite(expiry)) {
    return err(new MalformedError("expiry segment must be a finite integer"));
  }

  /*
   * HMAC verification first (before expiry) so timing does not leak whether
   * a forged token's expiry was in the past or future.
   */
  const message = `${origin}.${nonce}.${expiry}`;
  const expectedSig = hmacHex(signingKey, message);

  if (!constantTimeEqualHex(expectedSig, signature)) {
    return err(new BadSignatureError("HMAC mismatch"));
  }

  // Expiry check second.
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (expiry < nowSeconds) {
    return err(new ExpiredError("token expired"));
  }

  /*
   * Allowlist enforcement last. Whitespace-sensitive exact-match against the
   * operator-supplied origin list (BrandingConfig.allowedOrigins on T8).
   */
  if (!allowedOrigins.includes(origin)) {
    return err(new OriginNotAllowedError("origin not in allowlist"));
  }

  return ok({ origin });
};

/**
 * Right-split equivalent to Python's `str` right-split helper. Returns
 * `[head, ...lastN]` where `lastN` has at most `limit` items and `head`
 * is whatever remains on the left (joined with `sep`).
 *
 * Inlined here to avoid a util-module dependency for a one-off concern.
 */
const splitFromRight = (input: string, sep: string, limit: number): string[] => {
  const tail: string[] = [];
  let remaining = input;

  for (let i = 0; i < limit; i += 1) {
    const idx = remaining.lastIndexOf(sep);

    if (idx === -1) {
      break;
    }
    tail.unshift(remaining.slice(idx + sep.length));
    remaining = remaining.slice(0, idx);
  }

  return [remaining, ...tail];
};
