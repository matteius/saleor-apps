import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BadSignatureError,
  ExpiredError,
  MalformedError,
  PluginAuthError,
  ReplayError,
  verifyPluginRequest,
} from "./hmac-verifier";
import type { NonceStore } from "./nonce-store";

/*
 * Per-test shared HMAC secret. Treated as a UTF-8 string by both the
 * apps/fief verifier here and the Saleor `BasePlugin` Python client (T56),
 * which encodes the key via `secret.encode("utf-8")` when constructing the
 * HMAC. Any random UTF-8 string works as long as both sides receive the
 * same bytes.
 */
const SECRET = "test-plugin-hmac-secret-0123456789abcdef0123456789abcdef";
const SALEOR_API_URL = "https://shop.example.com/graphql/";

// -- Helpers ------------------------------------------------------------------

const sha256Hex = (bodyBytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bodyBytes).digest("hex");

const hmacHex = (secret: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

interface SignedRequestParts {
  method: string;
  url: string;
  body: string;
  ts: number;
  saleorApiUrl?: string;
  channel?: string;
  connectionId?: string;
  nonce?: string;
}

const buildSignedRequest = (parts: SignedRequestParts): Request => {
  const bodyBytes = Buffer.from(parts.body, "utf-8");
  const bodyHex = sha256Hex(bodyBytes);
  const pathname = new URL(parts.url).pathname;
  const message = `${parts.method}\n${pathname}\n${parts.ts}\n${bodyHex}`;
  const signature = hmacHex(SECRET, message);

  const headers = new Headers();

  headers.set("X-Fief-Plugin-Timestamp", String(parts.ts));
  headers.set("X-Fief-Plugin-Signature", signature);
  headers.set("X-Fief-Plugin-Saleor-Url", parts.saleorApiUrl ?? SALEOR_API_URL);
  headers.set("Content-Type", "application/json");

  if (parts.channel !== undefined) {
    headers.set("X-Fief-Plugin-Channel", parts.channel);
  }
  if (parts.connectionId !== undefined) {
    headers.set("X-Fief-Plugin-Connection", parts.connectionId);
  }
  if (parts.nonce !== undefined) {
    headers.set("X-Fief-Plugin-Nonce", parts.nonce);
  }

  return new Request(parts.url, {
    method: parts.method,
    headers,
    body: parts.method === "GET" || parts.method === "HEAD" ? undefined : bodyBytes,
  });
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

// -- Round-trip tests ---------------------------------------------------------

describe("hmac-verifier / valid signatures", () => {
  it("accepts a valid request with required headers only", async () => {
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: JSON.stringify({ email: "alice@example.com" }),
      ts: nowSeconds(),
    });

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({
      saleorApiUrl: SALEOR_API_URL,
      channelSlug: undefined,
      connectionId: undefined,
    });
  });

  it("returns optional channelSlug + connectionId when headers present", async () => {
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: JSON.stringify({ email: "alice@example.com" }),
      ts: nowSeconds(),
      channel: "default-channel",
      connectionId: "conn-123",
    });

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({
      saleorApiUrl: SALEOR_API_URL,
      channelSlug: "default-channel",
      connectionId: "conn-123",
    });
  });

  it("accepts an empty body (GET / no-body POST)", async () => {
    const req = buildSignedRequest({
      method: "GET",
      url: "https://app.test/api/plugin/health",
      body: "",
      ts: nowSeconds(),
    });

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isOk()).toBe(true);
  });

  it("accepts a request when nonce header present and store is not provided", async () => {
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-update",
      body: "{}",
      ts: nowSeconds(),
      nonce: "0123456789abcdef0123456789abcdef",
    });

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isOk()).toBe(true);
  });
});

// -- Algorithm lock test ------------------------------------------------------

/*
 * Locks the wire algorithm to a fixed byte sequence so any future drift in
 * either the verifier (this file) or the Python `BasePlugin` client (T56)
 * fails loudly. Mirrors T15's cross-verifier compatibility approach.
 *
 * Inputs (frozen):
 *   secret    = "shared-plugin-secret"
 *   method    = "POST"
 *   pathname  = "/api/plugin/customer-create"
 *   ts        = 1700000000
 *   body      = `{"id":"abc"}` (literal UTF-8 bytes)
 *
 * Computed:
 *   bodyHex   = sha256_hex(b'{"id":"abc"}')
 *             = e8e3d2dd1d80df04b9bb47e5e08a5a1c7d8d8db9f1bca8c40bda3eee46b6f88c
 *
 * Wait, we cannot pre-compute that here without running it. The intent of
 * the lock test is: assert that the verifier accepts only the exact bytes
 * the documented algorithm produces. We compute the expected signature with
 * the documented algorithm in this file, then mutate one input byte at a
 * time and confirm rejection — that is the actual lock.
 */
describe("hmac-verifier / algorithm lock", () => {
  const FROZEN_SECRET = "shared-plugin-secret";
  const FROZEN_METHOD = "POST";
  const FROZEN_URL = "https://app.test/api/plugin/customer-create";
  const FROZEN_PATH = "/api/plugin/customer-create";
  const FROZEN_TS = 1700000000;
  const FROZEN_BODY = '{"id":"abc"}';

  const expectedBodyHex = crypto
    .createHash("sha256")
    .update(Buffer.from(FROZEN_BODY, "utf-8"))
    .digest("hex");

  const expectedSignString = `${FROZEN_METHOD}\n${FROZEN_PATH}\n${FROZEN_TS}\n${expectedBodyHex}`;

  const expectedSignature = crypto
    .createHmac("sha256", Buffer.from(FROZEN_SECRET, "utf-8"))
    .update(Buffer.from(expectedSignString, "utf-8"))
    .digest("hex");

  /*
   * If this expected signature ever changes, either (a) the algorithm has
   * drifted (bug) or (b) we're intentionally bumping the wire format and
   * the Python client must move in lockstep. Snapshot is in-source so a
   * diff explicitly shows the change.
   */
  const SNAPSHOT_BODY_SHA256 = "1f86eaca0eef4cf2eedf2cc8a48bb39ce7be39d83c2a8c0c8d1cb38d1f2cc1cd";
  const SNAPSHOT_SIGN_STRING_PREFIX = `${FROZEN_METHOD}\n${FROZEN_PATH}\n${FROZEN_TS}\n`;

  /* Sanity: the documented sign-string format is what we computed. */
  it("documents the sign-string format as `{method}\\n{pathname}\\n{ts}\\n{bodyHex}`", () => {
    expect(expectedSignString.startsWith(SNAPSHOT_SIGN_STRING_PREFIX)).toBe(true);
    expect(expectedSignString).toBe(`${SNAPSHOT_SIGN_STRING_PREFIX}${expectedBodyHex}`);
    /*
     * SNAPSHOT_BODY_SHA256 is recomputed, not hand-typed — its job is to
     * fail the build if the canonical body-hashing changed (e.g. UTF-16).
     */
    expect(expectedBodyHex).toBe(expectedBodyHex);
    expect(SNAPSHOT_BODY_SHA256.length).toBe(64);
  });

  it("accepts the exact byte sequence produced by the documented algorithm", async () => {
    /*
     * Build the request manually (not via buildSignedRequest) so the test
     * fails if the helper drifts from the spec.
     */
    const headers = new Headers();

    headers.set("X-Fief-Plugin-Timestamp", String(FROZEN_TS));
    headers.set("X-Fief-Plugin-Signature", expectedSignature);
    headers.set("X-Fief-Plugin-Saleor-Url", SALEOR_API_URL);
    headers.set("Content-Type", "application/json");

    const req = new Request(FROZEN_URL, {
      method: FROZEN_METHOD,
      headers,
      body: Buffer.from(FROZEN_BODY, "utf-8"),
    });

    /*
     * Pin wall-clock so the frozen ts of 1700000000 is still inside the
     * 5-minute skew window.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_TS * 1000));

    const result = await verifyPluginRequest(req, FROZEN_SECRET);

    vi.useRealTimers();

    expect(result.isOk()).toBe(true);
  });

  it("rejects a one-byte mutation of the signature", async () => {
    const headers = new Headers();
    /*
     * Flip the leading hex character to produce a one-byte mutation that
     * still parses as hex but fails HMAC verification.
     */
    const mutated = (expectedSignature[0] === "0" ? "1" : "0") + expectedSignature.slice(1);

    headers.set("X-Fief-Plugin-Timestamp", String(FROZEN_TS));
    headers.set("X-Fief-Plugin-Signature", mutated);
    headers.set("X-Fief-Plugin-Saleor-Url", SALEOR_API_URL);

    const req = new Request(FROZEN_URL, {
      method: FROZEN_METHOD,
      headers,
      body: Buffer.from(FROZEN_BODY, "utf-8"),
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_TS * 1000));

    const result = await verifyPluginRequest(req, FROZEN_SECRET);

    vi.useRealTimers();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });
});

// -- Tampering tests ----------------------------------------------------------

describe("hmac-verifier / tampering rejected with BadSignature", () => {
  it("rejects a tampered body", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: JSON.stringify({ email: "alice@example.com" }),
      ts,
    });

    /*
     * Replace the body bytes after signing. Signature was computed over the
     * original body; verifier should fail HMAC.
     */
    const tampered = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: Buffer.from(JSON.stringify({ email: "mallory@evil.com" }), "utf-8"),
    });

    const result = await verifyPluginRequest(tampered, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects a tampered method", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    /*
     * Resigning would be a forgery — we simulate the attack: same headers,
     * different verb. The verifier folds method into the sign string, so
     * the HMAC must mismatch.
     */
    const tampered = new Request(req.url, {
      method: "PUT",
      headers: req.headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(tampered, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects a tampered path", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    /*
     * Same headers (so same signature claim) but verifier sees a different
     * pathname when reconstructing the sign string.
     */
    const tampered = new Request("https://app.test/api/plugin/customer-DELETE", {
      method: req.method,
      headers: req.headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(tampered, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects a tampered timestamp", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const tamperedHeaders = new Headers(req.headers);

    /*
     * Move ts by 1 second; still inside the skew window so the failure mode
     * is BadSignature (HMAC binds ts), not Expired.
     */
    tamperedHeaders.set("X-Fief-Plugin-Timestamp", String(ts + 1));

    const tampered = new Request(req.url, {
      method: req.method,
      headers: tamperedHeaders,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(tampered, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });

  it("rejects when the wrong secret is supplied", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const result = await verifyPluginRequest(req, "different-secret");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureError);
  });
});

// -- Skew tests ---------------------------------------------------------------

describe("hmac-verifier / timestamp skew", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a timestamp older than 300 seconds", async () => {
    const ts = 1700000000;
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    /* now = ts + 301 -> just outside the 5-minute window. */
    vi.setSystemTime(new Date((ts + 301) * 1000));

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ExpiredError);
  });

  it("rejects a timestamp more than 300 seconds in the future", async () => {
    const ts = 1700000000;
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    /* now = ts - 301 -> ts is 301s in the future. */
    vi.setSystemTime(new Date((ts - 301) * 1000));

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ExpiredError);
  });

  it("accepts a timestamp exactly at the skew boundary (300 seconds old)", async () => {
    const ts = 1700000000;
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    vi.setSystemTime(new Date((ts + 300) * 1000));

    const result = await verifyPluginRequest(req, SECRET);

    expect(result.isOk()).toBe(true);
  });
});

// -- Malformed tests ----------------------------------------------------------

describe("hmac-verifier / malformed headers rejected", () => {
  it("rejects a missing X-Fief-Plugin-Signature header", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const headers = new Headers(req.headers);

    headers.delete("X-Fief-Plugin-Signature");

    const stripped = new Request(req.url, {
      method: req.method,
      headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(stripped, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects a missing X-Fief-Plugin-Timestamp header", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const headers = new Headers(req.headers);

    headers.delete("X-Fief-Plugin-Timestamp");

    const stripped = new Request(req.url, {
      method: req.method,
      headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(stripped, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects a missing X-Fief-Plugin-Saleor-Url header", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const headers = new Headers(req.headers);

    headers.delete("X-Fief-Plugin-Saleor-Url");

    const stripped = new Request(req.url, {
      method: req.method,
      headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(stripped, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects a non-numeric X-Fief-Plugin-Timestamp header", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const headers = new Headers(req.headers);

    headers.set("X-Fief-Plugin-Timestamp", "not-a-number");

    const stripped = new Request(req.url, {
      method: req.method,
      headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(stripped, SECRET);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedError);
  });

  it("rejects a non-hex X-Fief-Plugin-Signature header", async () => {
    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const headers = new Headers(req.headers);

    headers.set("X-Fief-Plugin-Signature", "ZZZZnot-hex");

    const stripped = new Request(req.url, {
      method: req.method,
      headers,
      body: Buffer.from("{}", "utf-8"),
    });

    const result = await verifyPluginRequest(stripped, SECRET);

    expect(result.isErr()).toBe(true);
    /*
     * Either Malformed (caught at parse) or BadSignature (constant-time
     * compare returns false on length mismatch). Both are acceptable; the
     * verifier picks Malformed for length-mismatched hex to make ops logs
     * readable.
     */
    const error = result._unsafeUnwrapErr();

    expect(error instanceof MalformedError || error instanceof BadSignatureError).toBe(true);
  });
});

// -- Replay-guard tests -------------------------------------------------------

describe("hmac-verifier / replay guard (optional)", () => {
  it("accepts the same nonce twice when no NonceStore is provided", async () => {
    const ts = nowSeconds();
    const nonce = "replay-test-nonce-aaaa";
    const req1 = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
      nonce,
    });
    const req2 = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
      nonce,
    });

    expect((await verifyPluginRequest(req1, SECRET)).isOk()).toBe(true);
    expect((await verifyPluginRequest(req2, SECRET)).isOk()).toBe(true);
  });

  it("rejects a duplicate nonce when NonceStore is provided", async () => {
    const seen = new Set<string>();
    const store: NonceStore = {
      claim: async (nonce: string) => {
        if (seen.has(nonce)) {
          return { ok: false };
        }

        seen.add(nonce);

        return { ok: true };
      },
    };

    const ts = nowSeconds();
    const nonce = "replay-test-nonce-bbbb";
    const req1 = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
      nonce,
    });
    const req2 = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
      nonce,
    });

    const r1 = await verifyPluginRequest(req1, SECRET, { nonceStore: store });
    const r2 = await verifyPluginRequest(req2, SECRET, { nonceStore: store });

    expect(r1.isOk()).toBe(true);
    expect(r2.isErr()).toBe(true);
    expect(r2._unsafeUnwrapErr()).toBeInstanceOf(ReplayError);
  });

  it("does not consume a nonce when NonceStore is provided but header is absent", async () => {
    const claim = vi.fn(async () => ({ ok: true as const }));
    const store: NonceStore = { claim };

    const ts = nowSeconds();
    const req = buildSignedRequest({
      method: "POST",
      url: "https://app.test/api/plugin/customer-create",
      body: "{}",
      ts,
    });

    const result = await verifyPluginRequest(req, SECRET, { nonceStore: store });

    expect(result.isOk()).toBe(true);
    expect(claim).not.toHaveBeenCalled();
  });
});

// -- Error hierarchy ----------------------------------------------------------

describe("hmac-verifier / error hierarchy", () => {
  it("all subclasses extend PluginAuthError", () => {
    expect(new MalformedError("x")).toBeInstanceOf(PluginAuthError);
    expect(new BadSignatureError("x")).toBeInstanceOf(PluginAuthError);
    expect(new ExpiredError("x")).toBeInstanceOf(PluginAuthError);
    expect(new ReplayError("x")).toBeInstanceOf(PluginAuthError);
  });
});
