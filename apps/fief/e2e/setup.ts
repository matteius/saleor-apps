// cspell:ignore opensensor
/**
 * @vitest-environment node
 *
 * T42 — E2E suite shared setup.
 *
 * The automated E2E run is **mocked-mode**: msw intercepts the Fief OIDC +
 * admin endpoints, the Saleor GraphQL surface is replaced with an in-memory
 * fake, and `mongodb-memory-server` backs the storage layer. The "live"
 * variant (against a staging Saleor + opensensor-fief deployment) is a
 * documented manual-run target — see `apps/fief/e2e/README.md`.
 *
 * Env stubbing matches `src/__tests__/integration/setup.ts`:
 *   - `SECRET_KEY` is a 32-byte hex AES-256-CBC key so the encryptor (T4)
 *     wraps cleanly. Test code never reads the resulting ciphertext.
 *   - `FIEF_PLUGIN_HMAC_SECRET` matches the harness PLUGIN_SECRET so signed
 *     auth-plane requests verify.
 *   - `MONGODB_DATABASE` isolates the e2e collections from the unit /
 *     integration suites.
 *   - The harness overrides `MONGODB_URL` against its own
 *     `mongodb-memory-server` instance in `beforeAll`.
 */

import { vi } from "vitest";

vi.stubEnv("SECRET_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("FIEF_PLUGIN_HMAC_SECRET", "test_plugin_hmac_secret_e2e");
vi.stubEnv("MONGODB_DATABASE", "fief_app_e2e_test");
vi.stubEnv("TZ", "UTC");

export {};
