import { err, ok, type Result } from "neverthrow";

import {
  type DecryptResult,
  EncryptionError,
  type EncryptResult,
  type RotatingFiefEncryptor,
} from "@/modules/crypto/encryptor";

/*
 * No-op (base64) MockEncryptor for unit tests.
 *
 * - Implements the same surface as `RotatingFiefEncryptor` so storage/repo
 *   tests can swap it in without changing call sites.
 * - Skips the real AES-256-CBC primitive so tests don't need a 32-byte hex
 *   `SECRET_KEY` and never accidentally exercise crypto on the hot test path.
 * - Tags ciphertext with a `mock:` prefix so it's instantly recognisable in
 *   serialized fixtures / golden snapshots — and so an accidental call to
 *   the real encryptor (which uses `${ivHex}:${cipherHex}` format with no
 *   prefix) fails loudly.
 *
 * `keyVersion` is hard-wired to `"current"` because rotation flow is the real
 * encryptor's job; mock-based tests should not need to assert on it.
 */
export class MockEncryptor
  implements Pick<RotatingFiefEncryptor, "encrypt" | "decrypt" | "decryptOrThrow">
{
  private static readonly PREFIX = "mock:";

  encrypt(plaintext: string): EncryptResult {
    const ciphertext = MockEncryptor.PREFIX + Buffer.from(plaintext, "utf8").toString("base64");

    return { ciphertext, keyVersion: "current" };
  }

  decrypt(ciphertext: string): Result<DecryptResult, InstanceType<typeof EncryptionError>> {
    if (!ciphertext.startsWith(MockEncryptor.PREFIX)) {
      return err(new EncryptionError("MockEncryptor: ciphertext is not in mock format"));
    }

    const plaintext = Buffer.from(ciphertext.slice(MockEncryptor.PREFIX.length), "base64").toString(
      "utf8",
    );

    return ok({ plaintext, keyVersion: "current" });
  }

  decryptOrThrow(ciphertext: string): DecryptResult {
    const result = this.decrypt(ciphertext);

    if (result.isErr()) {
      throw result.error;
    }

    return result.value;
  }
}

/** Singleton convenience instance — most tests just want one. */
export const mockEncryptor = new MockEncryptor();
