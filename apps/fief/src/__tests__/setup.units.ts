import { vi } from "vitest";

/*
 * The env layer (src/lib/env.ts) fails fast on missing required vars at module
 * import. Stub the minimum set required by the schema so test files can import
 * any module without booting a real config.
 */
// 64 hex chars = 32 bytes — required by env.ts's aes256HexKey validator.
vi.stubEnv("SECRET_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("FIEF_PLUGIN_HMAC_SECRET", "test_plugin_hmac_secret");

process.env.TZ = "UTC";

export {};
