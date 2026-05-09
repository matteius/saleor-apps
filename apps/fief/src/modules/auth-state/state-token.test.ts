import { describe, expect, it } from "vitest";

import {
  BadSignatureStateError,
  ExpiredStateError,
  MalformedStateError,
  mintStateToken,
  STATE_TOKEN_LIFETIME_SECONDS,
  verifyStateToken,
} from "./state-token";

const SECRET = "x".repeat(64);
const REDIRECT = "https://shop.example.com/api/auth/callback";
const ORIGIN = "https://shop.example.com";

describe("state-token", () => {
  it("round-trips redirectUri + origin", () => {
    const token = mintStateToken({ redirectUri: REDIRECT, origin: ORIGIN }, SECRET, 1_000);
    const verified = verifyStateToken(token, SECRET, 1_001);

    expect(verified.isOk()).toBe(true);
    expect(verified._unsafeUnwrap()).toStrictEqual({ redirectUri: REDIRECT, origin: ORIGIN });
  });

  it("rejects mismatched secret with BadSignatureStateError", () => {
    const token = mintStateToken({ redirectUri: REDIRECT, origin: ORIGIN }, SECRET, 1_000);
    const verified = verifyStateToken(token, SECRET.replace("x", "y"), 1_000);

    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureStateError);
  });

  it("rejects token after lifetime with ExpiredStateError", () => {
    const token = mintStateToken({ redirectUri: REDIRECT, origin: ORIGIN }, SECRET, 1_000);
    const verified = verifyStateToken(token, SECRET, 1_000 + STATE_TOKEN_LIFETIME_SECONDS + 1);

    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr()).toBeInstanceOf(ExpiredStateError);
  });

  it("rejects token without separator with MalformedStateError", () => {
    const verified = verifyStateToken("nodothere", SECRET);

    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr()).toBeInstanceOf(MalformedStateError);
  });

  it("rejects token whose payload bytes have been tampered", () => {
    const token = mintStateToken({ redirectUri: REDIRECT, origin: ORIGIN }, SECRET, 1_000);
    // Flip a byte in the payload — signature won't match.
    const tampered = `A${token.slice(1)}`;
    const verified = verifyStateToken(tampered, SECRET, 1_000);

    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr()).toBeInstanceOf(BadSignatureStateError);
  });

  it("two mints produce different nonces (so different tokens)", () => {
    const a = mintStateToken({ redirectUri: REDIRECT, origin: ORIGIN }, SECRET, 1_000);
    const b = mintStateToken({ redirectUri: REDIRECT, origin: ORIGIN }, SECRET, 1_000);

    expect(a).not.toBe(b);
  });
});
