import { vi } from "vitest";

/*
 * T40 — integration suite shared setup.
 *
 * Stubs the minimum env required by `src/lib/env.ts` (mirrors
 * `src/__tests__/setup.units.ts`). Each integration test file overrides
 * `MONGODB_URL` against its own `mongodb-memory-server` instance in
 * `beforeAll`, so this setup file only seeds the static schema-required vars.
 *
 * `SECRET_KEY` is a 32-byte hex string (AES-256-CBC key) so the encryptor
 * (T4) wraps cleanly; tests don't read the resulting ciphertext.
 */

vi.stubEnv("SECRET_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("FIEF_PLUGIN_HMAC_SECRET", "test_plugin_hmac_secret_integration");
vi.stubEnv("MONGODB_DATABASE", "fief_app_integration_test");
vi.stubEnv("TZ", "UTC");

export {};
