import { Encryptor } from "@saleor/apps-shared/encryptor";
import { resolveDecryptFallbacks } from "@saleor/apps-shared/secret-key-resolution";
import { err, ok, type Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";

/*
 * AES-256-CBC encryptor for the Fief app.
 *
 * Wraps `@saleor/apps-shared/encryptor` (the canonical Saleor-apps AES-256-CBC
 * primitive) and adds:
 *
 *   - Key-rotation: when `NEW_SECRET_KEY` is set, new writes use it; reads try
 *     `NEW_SECRET_KEY` first then fall back to `SECRET_KEY`. This matches the
 *     `secret-key-resolution` policy used by `apps/stripe`.
 *
 *   - Key-version reporting: every encrypt/decrypt returns a wrapper carrying
 *     `keyVersion` so callers (T8 storage layer, T17 rotation use-case) can
 *     audit which slot was used and decide whether to re-encrypt.
 *
 *   - `Result`-returning `decrypt(...)` for the common path, plus a
 *     `decryptOrThrow(...)` ergonomic helper for tests / call sites that have
 *     already pre-validated input.
 *
 * The shared `RotatingEncryptor` from `@saleor/apps-shared/key-rotation/...`
 * is intentionally NOT used here — it pulls a hard dependency on
 * `@saleor/apps-logger`, which the Fief app deliberately omits per T47's
 * slim-observability decision.
 */

/**
 * Identifies which env-var slot produced a ciphertext.
 *
 *   - `"current"` — the canonical `SECRET_KEY` slot. Used for new writes when
 *     `NEW_SECRET_KEY` is unset; used for fallback decrypts when both keys are
 *     set (i.e. legacy rows written before rotation began).
 *   - `"new"` — the rotation-target `NEW_SECRET_KEY` slot. Used for new writes
 *     while rotation is in progress, and for decrypts of rows written during
 *     rotation.
 */
export type EncryptKeyVersion = "current" | "new";

/** Wrapper around an encrypt result — records which key the ciphertext was sealed with. */
export interface EncryptResult {
  ciphertext: string;
  keyVersion: EncryptKeyVersion;
}

/** Wrapper around a decrypt result — records which key successfully unsealed the ciphertext. */
export interface DecryptResult {
  plaintext: string;
  keyVersion: EncryptKeyVersion;
}

/**
 * All encryption / decryption failures surface as this typed error so call
 * sites can `match` on it without leaking provider-specific shapes.
 *
 * The original `cause` is preserved (modern-errors), but message text is kept
 * generic to avoid leaking ciphertext details into logs.
 */
export const EncryptionError = BaseError.subclass("EncryptionError", {
  props: {
    _brand: "FiefApp.EncryptionError" as const,
  },
});

interface RotatingFiefEncryptorInput {
  /** The canonical `SECRET_KEY`. Required. Hex-encoded AES key (32 bytes / 64 hex chars for AES-256). */
  secretKey: string;
  /** The optional `NEW_SECRET_KEY` rotation target. When set, new writes use it; reads try it first then fall back to `secretKey`. */
  newSecretKey?: string;
}

/**
 * Pure (env-agnostic) encryptor. Constructor takes keys directly so it is
 * trivial to test with arbitrary key material; for the env-driven instance use
 * `createFiefEncryptor()` below.
 */
export class RotatingFiefEncryptor {
  private readonly currentKey: string;
  private readonly newKey: string | undefined;

  /*
   * Cached primitives so repeated encrypt/decrypt calls don't reallocate
   * `Encryptor` instances per call. `Encryptor` itself stores only the secret
   * string; the actual `crypto.createCipheriv` instance is per-call.
   *
   * Lazy: built on first encrypt/decrypt rather than in the constructor, so
   * `next build`'s page-data collection can construct this without
   * SECRET_KEY set in the build environment. Runtime first-use still throws
   * loudly if secretKey is missing — same error, just deferred to the first
   * actual cipher call.
   */
  private currentEncryptorInstance: Encryptor | undefined;
  private newEncryptorInstance: Encryptor | undefined;

  constructor(input: RotatingFiefEncryptorInput) {
    if (input.newSecretKey !== undefined && input.newSecretKey.length === 0) {
      throw new EncryptionError(
        "RotatingFiefEncryptor: newSecretKey must be either omitted or a non-empty string",
        { props: { _brand: "FiefApp.EncryptionError" as const } },
      );
    }

    this.currentKey = input.secretKey;
    this.newKey = input.newSecretKey;
  }

  private get currentEncryptor(): Encryptor {
    if (!this.currentKey) {
      throw new EncryptionError("RotatingFiefEncryptor requires a non-empty secretKey", {
        props: { _brand: "FiefApp.EncryptionError" as const },
      });
    }

    if (this.currentEncryptorInstance === undefined) {
      this.currentEncryptorInstance = new Encryptor(this.currentKey);
    }

    return this.currentEncryptorInstance;
  }

  private get newEncryptor(): Encryptor | undefined {
    if (!this.newKey) {
      return undefined;
    }

    if (this.newEncryptorInstance === undefined) {
      this.newEncryptorInstance = new Encryptor(this.newKey);
    }

    return this.newEncryptorInstance;
  }

  /**
   * Encrypt `plaintext`. Always uses the rotation target if set, otherwise the
   * current key. Returns the ciphertext plus the key version that produced it.
   *
   * Cipher format matches `@saleor/apps-shared/encryptor`: `${ivHex}:${ciphertextHex}`.
   */
  encrypt(plaintext: string): EncryptResult {
    if (this.newEncryptor) {
      return {
        ciphertext: this.newEncryptor.encrypt(plaintext),
        keyVersion: "new",
      };
    }

    return {
      ciphertext: this.currentEncryptor.encrypt(plaintext),
      keyVersion: "current",
    };
  }

  /**
   * Decrypt `ciphertext`, returning a `Result` so call sites don't need
   * try/catch. The wrapped `keyVersion` records which slot succeeded so the
   * caller can flag rows that should be re-encrypted under the new key.
   *
   * Order: when both keys are present, the new key is tried first (most rows
   * post-rotation should be readable that way); on failure the current key is
   * tried. AES-CBC has no built-in MAC so we validate the result with
   * `isPrintableText` (UTF-8 sanity, same heuristic the shared package uses)
   * before accepting it.
   */
  decrypt(ciphertext: string): Result<DecryptResult, InstanceType<typeof EncryptionError>> {
    // Quick structural sanity check — `${ivHex}:${cipherHex}`.
    if (!ciphertext.includes(":")) {
      return err(new EncryptionError("Ciphertext is malformed: missing IV/payload separator"));
    }

    const tryKey = (encryptor: Encryptor): string | null => {
      try {
        const plaintext = encryptor.decrypt(ciphertext);

        /*
         * Same UTF-8 sanity check used by `tryDecryptWithFallback` in
         * `@saleor/apps-shared/key-rotation` — guards against the ~0.4 %
         * PKCS7-luck false positive when AES-CBC is decrypted with the wrong
         * key.
         */
        return plaintext.includes("�") ? null : plaintext;
      } catch {
        return null;
      }
    };

    if (this.newEncryptor) {
      const viaNew = tryKey(this.newEncryptor);

      if (viaNew !== null) {
        return ok({ plaintext: viaNew, keyVersion: "new" });
      }
    }

    const viaCurrent = tryKey(this.currentEncryptor);

    if (viaCurrent !== null) {
      return ok({ plaintext: viaCurrent, keyVersion: "current" });
    }

    return err(
      new EncryptionError(
        this.newEncryptor
          ? "Decryption failed against both NEW_SECRET_KEY and SECRET_KEY"
          : "Decryption failed against SECRET_KEY",
      ),
    );
  }

  /**
   * Convenience wrapper for call sites that have already validated input
   * shape and want to bubble failures as exceptions (e.g. tests, repository
   * read paths that wrap their own try/catch).
   */
  decryptOrThrow(ciphertext: string): DecryptResult {
    const result = this.decrypt(ciphertext);

    if (result.isErr()) {
      throw result.error;
    }

    return result.value;
  }
}

/**
 * Build the env-driven singleton encryptor. Reads `SECRET_KEY` and
 * `NEW_SECRET_KEY` exclusively via `src/lib/env.ts` (per `n/no-process-env`).
 *
 * Callers should invoke this from a place that survives the cold-start path
 * (e.g. lazily inside the connection repo's constructor) so a missing env
 * still surfaces as a typed error rather than crashing module load.
 */
export function createFiefEncryptor(): RotatingFiefEncryptor {
  /*
   * Map env → wrapper slots:
   *   - `secretKey` slot is always `env.SECRET_KEY` — the canonical "current"
   *     key. New writes will land here when rotation is *not* in progress;
   *     legacy reads always fall back to it during rotation.
   *   - `newSecretKey` slot is populated only while rotation is in flight,
   *     i.e. exactly when `NEW_SECRET_KEY` is set. We use
   *     `resolveDecryptFallbacks(env).length > 0` as the rotation flag so
   *     this module agrees with `@saleor/apps-shared/secret-key-resolution`
   *     on the meaning of "rotating" without re-reading process env.
   */
  return new RotatingFiefEncryptor({
    secretKey: env.SECRET_KEY,
    newSecretKey: resolveDecryptFallbacks(env).length > 0 ? env.NEW_SECRET_KEY : undefined,
  });
}
