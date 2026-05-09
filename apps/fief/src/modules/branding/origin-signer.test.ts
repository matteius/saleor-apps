import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BadSignatureError,
  BrandingOriginError,
  ExpiredError,
  MalformedError,
  OriginNotAllowedError,
  sign,
  verify,
} from "./origin-signer";

/*
 * Per-test signing key. Treated as a UTF-8 string by both the TS signer here
 * and the Python `BrandingOriginVerifier` in
 * `opensensor-fief/fief/services/branding/origin_verifier.py` (which calls
 * `self._signing_key.encode("utf-8")` when constructing the HMAC). Any random
 * UTF-8 string works as long as both sides receive the same bytes.
 */
const SIGNING_KEY = "test-branding-signing-key-0123456789abcdef0123456789abcdef";
const ORIGIN = "https://shop-a.example.com";
const ALLOWED = [ORIGIN];

describe("origin-signer / sign + verify (round-trip)", () => {
  it("verifies a freshly-signed token from the same key", () => {
    const token = sign(ORIGIN, SIGNING_KEY);

    const result = verify(token, SIGNING_KEY, ALLOWED);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ origin: ORIGIN });
  });

  it("supports an explicit nonce + expiry", () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const token = sign(ORIGIN, SIGNING_KEY, "deadbeefdeadbeef", expiry);

    expect(token.split(".").slice(-3, -2)[0]).toBe("deadbeefdeadbeef");
    expect(token.split(".").slice(-2, -1)[0]).toBe(String(expiry));

    const result = verify(token, SIGNING_KEY, ALLOWED);

    expect(result.isOk()).toBe(true);
  });

  it("preserves origins that contain dots in their host", () => {
    const dotty = "https://shop.brand.example.com";
    const token = sign(dotty, SIGNING_KEY);

    const result = verify(token, SIGNING_KEY, [dotty]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ origin: dotty });
  });
});

describe("origin-signer / verify rejects tampered or invalid tokens", () => {
  it("rejects tampered origin with BadSignature", () => {
    const token = sign(ORIGIN, SIGNING_KEY);
    // Use the same right-aware parse the verifier does — origins contain dots.
    const all = token.split(".");
    const sig = all[all.length - 1];
    const expiry = all[all.length - 2];
    const nonce = all[all.length - 3];
    const tampered = `https://evil.example.com.${nonce}.${expiry}.${sig}`;

    const result = verify(tampered, SIGNING_KEY, [ORIGIN, "https://evil.example.com"]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects tampered nonce with BadSignature", () => {
    const token = sign(ORIGIN, SIGNING_KEY);
    const parts = token.split(".");

    parts[parts.length - 3] = "ffffffffffffffff";
    const tampered = parts.join(".");

    const result = verify(tampered, SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects tampered expiry with BadSignature", () => {
    const token = sign(ORIGIN, SIGNING_KEY);
    const parts = token.split(".");

    parts[parts.length - 2] = String(Math.floor(Date.now() / 1000) + 9999);
    const tampered = parts.join(".");

    const result = verify(tampered, SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects an expired token with Expired", () => {
    const expired = Math.floor(Date.now() / 1000) - 10;
    const token = sign(ORIGIN, SIGNING_KEY, "cafebabecafebabe", expired);

    const result = verify(token, SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ExpiredError);
  });

  it("rejects a token whose origin is not in the allowlist with OriginNotAllowed", () => {
    const token = sign(ORIGIN, SIGNING_KEY);

    const result = verify(token, SIGNING_KEY, ["https://other.example.com"]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(OriginNotAllowedError);
  });

  it("rejects a token signed with a different key as BadSignature", () => {
    const token = sign(ORIGIN, SIGNING_KEY);

    const result = verify(token, "different-signing-key", ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });
});

describe("origin-signer / verify rejects malformed tokens", () => {
  it("rejects a 3-segment token with Malformed", () => {
    const result = verify("a.b.c", SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects an empty string with Malformed", () => {
    const result = verify("", SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects a token whose expiry is non-numeric with Malformed", () => {
    // origin contains dots, nonce, non-numeric expiry, signature
    const tok = `${ORIGIN}.deadbeefdeadbeef.notanumber.0000000000000000000000000000000000000000000000000000000000000000`;

    const result = verify(tok, SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects a token with empty origin/nonce/expiry/sig segment with Malformed", () => {
    const result = verify("..1700000000.aabb", SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("subclasses errors all extend BrandingOriginError", () => {
    expect(new BadSignatureError("x")).toBeInstanceOf(BrandingOriginError);
    expect(new ExpiredError("x")).toBeInstanceOf(BrandingOriginError);
    expect(new OriginNotAllowedError("x")).toBeInstanceOf(BrandingOriginError);
    expect(new MalformedError("x")).toBeInstanceOf(BrandingOriginError);
  });
});

describe("origin-signer / Fief verifier byte-compatibility lock", () => {
  /*
   * This test pins the exact wire format produced by `sign()` against a
   * hand-computed expected token, so any drift from the Python verifier's
   * algorithm in `opensensor-fief/fief/services/branding/origin_verifier.py`
   * fails loudly. The Python verifier:
   *
   *   message = f"{origin}.{nonce}.{expiry}".encode()
   *   sig     = hmac.new(key.encode("utf-8"), msg=message,
   *                      digestmod=hashlib.sha256).hexdigest()
   *
   * Reproduced here with Node's `crypto` so the test does not depend on the
   * implementation under test for the expected value.
   */
  it("sign() emits exactly origin.nonce.expiry.<hex hmac-sha256>", () => {
    const fixedNonce = "0123456789abcdef";
    const fixedExpiry = 1_700_000_000;
    const fixedOrigin = "https://shop-a.example.com";
    const fixedKey = "fixed-key-for-byte-lock";

    const token = sign(fixedOrigin, fixedKey, fixedNonce, fixedExpiry);

    const message = `${fixedOrigin}.${fixedNonce}.${fixedExpiry}`;
    const expectedSig = crypto
      .createHmac("sha256", Buffer.from(fixedKey, "utf-8"))
      .update(Buffer.from(message, "utf-8"))
      .digest("hex");
    const expectedToken = `${message}.${expectedSig}`;

    expect(token).toBe(expectedToken);
  });

  it("sign() default nonce is 16 lowercase hex chars from crypto.randomBytes", () => {
    const token = sign(ORIGIN, SIGNING_KEY);
    const parts = token.split(".");
    const nonce = parts[parts.length - 3];

    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sign() default expiry is wall-clock + 5 minutes (in seconds)", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = sign(ORIGIN, SIGNING_KEY);
    const after = Math.floor(Date.now() / 1000);

    const parts = token.split(".");
    const expiry = Number.parseInt(parts[parts.length - 2], 10);

    expect(expiry).toBeGreaterThanOrEqual(before + 5 * 60);
    expect(expiry).toBeLessThanOrEqual(after + 5 * 60);
  });
});

describe("origin-signer / verify time injection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats the boundary expiry == now as valid (>= now)", () => {
    vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const token = sign(ORIGIN, SIGNING_KEY, "boundarynonce123", nowSec);

    const result = verify(token, SIGNING_KEY, ALLOWED);

    expect(result.isOk()).toBe(true);
  });

  it("rejects when expiry is one second in the past", () => {
    vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
    const past = Math.floor(Date.now() / 1000) - 1;
    const token = sign(ORIGIN, SIGNING_KEY, "pastnonce0000000", past);

    const result = verify(token, SIGNING_KEY, ALLOWED);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ExpiredError);
  });
});
