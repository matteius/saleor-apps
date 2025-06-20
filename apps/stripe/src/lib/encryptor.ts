import crypto from "node:crypto";

import { env } from "./env";

// todo move to shared package
export class Encryptor {
  /**
   * 32 bytes key for AES-256-CBC
   */
  private key: Buffer;

  constructor(secret = env.SECRET_KEY) {
    // Ensure we have a 32-byte key for AES-256
    this.key = this.deriveKey(secret);
  }

  private deriveKey(secret: string): Buffer {
    // If the secret is already a 64-character hex string (32 bytes), use it directly
    if (secret.length === 64 && /^[0-9a-fA-F]+$/.test(secret)) {
      return Buffer.from(secret, "hex");
    }
    
    // Otherwise, derive a 32-byte key using SHA-256
    return crypto.createHash("sha256").update(secret).digest();
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(16); // 16 bytes IV for AES
    const cipher = crypto.createCipheriv("aes-256-cbc", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);

    return iv.toString("hex") + ":" + encrypted.toString("hex");
  }

  decrypt(text: string): string {
    const [ivHex, encryptedHex] = text.split(":");

    if (!ivHex || !encryptedHex) throw new Error("Invalid input");

    const iv = Buffer.from(ivHex, "hex");
    const encryptedData = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.key, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

    return decrypted.toString();
  }
}
