import { exportJWK, FlattenedSign, generateKeyPair, type JWK, type KeyLike } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyWebhookSignature } from "./verify-signature";

/**
 * Saleor signs webhook payloads using a detached JWS. The header carries
 * `kid` referencing a key inside the app's JWKS. The wire form delivered as
 * the `Saleor-Signature` header is `<protectedHeader>..<signature>` (the
 * payload segment is empty because verification is performed against the
 * raw HTTP body).
 *
 * These fixtures generate a deterministic key pair per test, build a valid
 * detached JWS, then mutate it to drive each negative case.
 */

const ALG = "RS256";
const KID = "test-kid";
const RAW_BODY = JSON.stringify({ webhook: "saleor", event: "CUSTOMER_CREATED" });

let privateKey: KeyLike;
let publicJwk: JWK;
let jwks: string;
let validSignature: string;

const encode = (input: string): Uint8Array => Uint8Array.from(Buffer.from(input, "utf8"));

const buildSignature = async (params: { body: string; key: KeyLike; kid: string }) => {
  /*
   * Saleor signs with `b64: false` + `crit: ["b64"]` so the protected
   * header is base64url and the payload travels as the raw HTTP body
   * (the JWS `payload` segment is empty over the wire). `flattenedVerify`
   * then validates the signature against `protected || "." || rawBody`.
   */
  const jws = await new FlattenedSign(encode(params.body))
    .setProtectedHeader({ alg: ALG, kid: params.kid, b64: false, crit: ["b64"] })
    .sign(params.key);

  // Saleor delivers the JWS in compact-ish detached form: header..signature
  return `${jws.protected}..${jws.signature}`;
};

beforeAll(async () => {
  const pair = await generateKeyPair(ALG);

  privateKey = pair.privateKey;

  const exportedPublic = await exportJWK(pair.publicKey);

  exportedPublic.kid = KID;
  exportedPublic.alg = ALG;
  exportedPublic.use = "sig";

  publicJwk = exportedPublic;
  jwks = JSON.stringify({ keys: [publicJwk] });

  validSignature = await buildSignature({ body: RAW_BODY, key: privateKey, kid: KID });
});

describe("verifyWebhookSignature", () => {
  it("resolves for a valid signature over the supplied raw body", async () => {
    await expect(verifyWebhookSignature(jwks, validSignature, RAW_BODY)).resolves.toBeUndefined();
  });

  it("rejects when the body has been tampered with", async () => {
    const tampered = `${RAW_BODY}!`;

    await expect(verifyWebhookSignature(jwks, validSignature, tampered)).rejects.toThrow(
      /JWKS verification failed/,
    );
  });

  it("rejects when the signature header references a `kid` not in the JWKS", async () => {
    const otherPair = await generateKeyPair(ALG);
    const foreignSignature = await buildSignature({
      body: RAW_BODY,
      key: otherPair.privateKey,
      kid: "unknown-kid",
    });

    await expect(verifyWebhookSignature(jwks, foreignSignature, RAW_BODY)).rejects.toThrow(
      /JWKS verification failed/,
    );
  });

  it("surfaces a meaningful error when the JWKS payload is missing/unparseable", async () => {
    await expect(verifyWebhookSignature("not-json", validSignature, RAW_BODY)).rejects.toThrow(
      /JWKS verification failed - could not parse given JWKS/,
    );
  });
});
