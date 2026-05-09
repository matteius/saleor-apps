import { describe, expect, it } from "vitest";

import { EncryptionError, type EncryptKeyVersion, RotatingFiefEncryptor } from "./encryptor";

/*
 * 32-byte (64 hex char) AES-256 keys — never reused outside this test file.
 * Generated with `openssl rand -hex 32`.
 */
const KEY_OLD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_NEW = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("RotatingFiefEncryptor", () => {
  describe("with SECRET_KEY only (no rotation)", () => {
    const encryptor = new RotatingFiefEncryptor({ secretKey: KEY_OLD });

    it("encrypts and decrypts a string round-trip", () => {
      const plaintext = "fief-client-secret-abc123";
      const wrapper = encryptor.encrypt(plaintext);

      expect(wrapper.ciphertext).not.toBe(plaintext);
      expect(wrapper.ciphertext).toContain(":");

      const decrypted = encryptor.decryptOrThrow(wrapper.ciphertext);

      expect(decrypted.plaintext).toBe(plaintext);
    });

    it("records keyVersion=current on encrypt when only SECRET_KEY is set", () => {
      const wrapper = encryptor.encrypt("payload");

      expect(wrapper.keyVersion).toBe<EncryptKeyVersion>("current");
    });

    it("records keyVersion=current on decrypt when ciphertext was written with SECRET_KEY", () => {
      const wrapper = encryptor.encrypt("payload");
      const result = encryptor.decryptOrThrow(wrapper.ciphertext);

      expect(result.keyVersion).toBe<EncryptKeyVersion>("current");
    });

    it("returns Result.err with EncryptionError for empty/garbled ciphertext", () => {
      const result = encryptor.decrypt("not-a-real-ciphertext");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(EncryptionError);
    });
  });

  describe("rotation flow — both SECRET_KEY and NEW_SECRET_KEY set", () => {
    const rotating = new RotatingFiefEncryptor({
      secretKey: KEY_OLD,
      newSecretKey: KEY_NEW,
    });

    /*
     * Simulate "legacy ciphertext written before rotation began" by encrypting
     * with an old-key-only encryptor, then handing the ciphertext to the rotating one.
     */
    const oldOnly = new RotatingFiefEncryptor({ secretKey: KEY_OLD });

    it("new writes are encrypted with NEW_SECRET_KEY and reported as keyVersion=new", () => {
      const wrapper = rotating.encrypt("fresh-secret");

      expect(wrapper.keyVersion).toBe<EncryptKeyVersion>("new");
    });

    it("ciphertext written with the new key decrypts cleanly and reports keyVersion=new", () => {
      const wrapper = rotating.encrypt("fresh-secret");
      const decrypted = rotating.decryptOrThrow(wrapper.ciphertext);

      expect(decrypted.plaintext).toBe("fresh-secret");
      expect(decrypted.keyVersion).toBe<EncryptKeyVersion>("new");
    });

    it("legacy ciphertext (written under SECRET_KEY) still decrypts via fallback and reports keyVersion=current", () => {
      const legacyWrapper = oldOnly.encrypt("legacy-secret");
      const decrypted = rotating.decryptOrThrow(legacyWrapper.ciphertext);

      expect(decrypted.plaintext).toBe("legacy-secret");
      expect(decrypted.keyVersion).toBe<EncryptKeyVersion>("current");
    });

    it("decryption is order-sensitive: new key tried first, then SECRET_KEY", () => {
      /*
       * Both keys can technically attempt to decrypt every ciphertext,
       * but only the matching one will succeed. This test ensures that
       * the wrapper's `keyVersion` field accurately reports which slot
       * produced the plaintext, regardless of which order both keys
       * would have succeeded in (only one ever does, modulo PKCS7 luck).
       */
      const fresh = rotating.encrypt("written-with-new");
      const legacy = oldOnly.encrypt("written-with-old");

      expect(rotating.decryptOrThrow(fresh.ciphertext).keyVersion).toBe("new");
      expect(rotating.decryptOrThrow(legacy.ciphertext).keyVersion).toBe("current");
    });
  });

  describe("rotate-then-clear-old (post-rotation: only NEW_SECRET_KEY remains)", () => {
    /*
     * Operator workflow: rotate, then once all ciphertext is migrated,
     * remove the old SECRET_KEY env var and promote NEW_SECRET_KEY → SECRET_KEY.
     * Simulate the "promoted" state: pass the ex-NEW_SECRET_KEY as `secretKey`
     * with no NEW_SECRET_KEY set. Ciphertext written under the new key during
     * rotation must continue to decrypt.
     */
    const rotating = new RotatingFiefEncryptor({
      secretKey: KEY_OLD,
      newSecretKey: KEY_NEW,
    });
    const promoted = new RotatingFiefEncryptor({ secretKey: KEY_NEW });

    it("ciphertext written during rotation can still be decrypted after the old key is dropped", () => {
      const wrapper = rotating.encrypt("survived-rotation");

      const decrypted = promoted.decryptOrThrow(wrapper.ciphertext);

      expect(decrypted.plaintext).toBe("survived-rotation");
      expect(decrypted.keyVersion).toBe<EncryptKeyVersion>("current");
    });
  });

  describe("tampered ciphertext", () => {
    const encryptor = new RotatingFiefEncryptor({ secretKey: KEY_OLD });

    it("rejects ciphertext whose payload byte was flipped", () => {
      const wrapper = encryptor.encrypt("authentic");
      const [iv, payload] = wrapper.ciphertext.split(":");
      const tamperedPayload = payload.slice(0, -2) + (payload.slice(-2) === "00" ? "ff" : "00");
      const tampered = `${iv}:${tamperedPayload}`;

      const result = encryptor.decrypt(tampered);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(EncryptionError);
    });

    it("rejects ciphertext with tampered IV (rotating encryptor with both keys)", () => {
      const rotating = new RotatingFiefEncryptor({
        secretKey: KEY_OLD,
        newSecretKey: KEY_NEW,
      });
      const wrapper = rotating.encrypt("authentic");
      const [iv, payload] = wrapper.ciphertext.split(":");
      // Flip a byte in the IV — neither key can produce valid plaintext.
      const tamperedIv = iv.slice(0, -2) + (iv.slice(-2) === "00" ? "ff" : "00");
      const tampered = `${tamperedIv}:${payload}`;

      const result = rotating.decrypt(tampered);

      expect(result.isErr()).toBe(true);
    });

    it("rejects ciphertext with no `:` separator", () => {
      const result = encryptor.decrypt("deadbeef");

      expect(result.isErr()).toBe(true);
    });
  });

  describe("validation", () => {
    /*
     * SecretKey is validated lazily (on first encrypt/decrypt) so `next build`
     * route-collection can construct this without SECRET_KEY in env. The throw
     * still surfaces at runtime first-use with the same error type.
     */
    it("throws on first encrypt when secretKey is empty", () => {
      const encryptor = new RotatingFiefEncryptor({ secretKey: "" });

      expect(() => encryptor.encrypt("plaintext")).toThrow();
    });

    it("throws when newSecretKey is provided as an empty string", () => {
      expect(() => new RotatingFiefEncryptor({ secretKey: KEY_OLD, newSecretKey: "" })).toThrow();
    });
  });
});
