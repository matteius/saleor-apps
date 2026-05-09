import { newSecretKeyRuntimeEnv } from "@saleor/apps-shared/secret-key-resolution";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { fromError } from "zod-validation-error";

import { BaseError } from "@/lib/errors";

/**
 * AES-256-CBC requires a 32-byte key. We hex-encode it on the wire, so the
 * env value MUST be exactly 64 hex characters. Validating here means the
 * server fails fast at boot with a clear message rather than blowing up
 * deep in a save flow with the generic Node "Invalid key length".
 * Generate with `openssl rand -hex 32`.
 */
const aes256HexKey = z
  .string()
  .regex(
    /^[0-9a-fA-F]{64}$/,
    "Must be 64 hex characters (32 bytes for AES-256). Generate with `openssl rand -hex 32`.",
  );

const booleanFromString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }

    return value === "true" || value === "1";
  })
  .default(false);

export const env = createEnv({
  client: {},
  server: {
    /*
     * --- Crypto / secrets ---
     * AES-256-CBC keys. SECRET_KEY is required; NEW_SECRET_KEY is the
     * rotation target (when set, new writes use it and SECRET_KEY becomes
     * decrypt-only). Both must be 64 hex characters (32 bytes for AES-256).
     * The shared `newSecretKeyServerSchema` only enforces non-empty, so we
     * tighten both keys here to fail fast at boot instead of at first save.
     */
    SECRET_KEY: aes256HexKey,
    NEW_SECRET_KEY: aes256HexKey.optional(),

    /*
     * --- Saleor app metadata ---
     * Regex pattern controlling which Saleor domains can install this app.
     * Consumed by the register handler (T16).
     */
    ALLOWED_DOMAIN_PATTERN: z.string().optional(),

    /*
     * APL backend selection. `mongodb` is the production target (T3).
     * `file` is the local-dev default; `saleor-cloud` and `dynamodb` are
     * preserved so other Saleor-platform deployments can use them, but
     * the canonical Fief-app deployment uses MongoDB.
     */
    APL: z.enum(["saleor-cloud", "file", "dynamodb", "mongodb"]).default("file"),

    APP_API_BASE_URL: z.string().optional(),
    APP_IFRAME_BASE_URL: z.string().optional(),

    APP_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    MANIFEST_APP_ID: z.string().default("saleor.app.fief"),
    APP_NAME: z.string().default("Fief"),

    PORT: z.coerce.number().default(3000),

    /*
     * --- MongoDB (config + identity-map storage) ---
     * Optional at this scaffold stage; T3 wires the Mongo client and will
     * require these when APL=mongodb is selected.
     */
    MONGODB_URL: z.string().optional(),
    MONGODB_DATABASE: z.string().optional(),

    /*
     * --- Fief integration ---
     * Base URL of the Fief admin/OIDC tenant the app talks to. T5/T6 read
     * this when constructing the Fief admin and OIDC clients.
     */
    FIEF_BASE_URL: z.string().url().optional(),

    /*
     * --- Kill switches (incident response, T54) ---
     * Operator playbook lives in T45. Both flags default to disabled
     * (i.e. sync runs normally).
     */
    FIEF_SYNC_DISABLED: booleanFromString,
    FIEF_SALEOR_TO_FIEF_DISABLED: booleanFromString,

    /*
     * --- Cron / reconciliation (T32) ---
     * Bearer token required on the reconciliation cron endpoint.
     */
    CRON_SECRET: z.string().optional(),

    /*
     * --- Plugin auth (T58) ---
     * Shared HMAC secret used by the Saleor `BasePlugin` (T56/T57) when calling
     * the auth-plane endpoints (T18-T21). Per the Path A pivot, this is a
     * single install-level secret rather than a per-connection one — the
     * plugin signs every request with the same secret, and the apps/fief
     * verifier (T58) uses the same value to validate. Per-connection rotation
     * is a deliberate follow-up: at the entry point of T18-T21 the connection
     * has not been resolved yet (channel-scope resolution happens AFTER auth),
     * so per-connection secrets would require a chicken-and-egg dance
     * (resolve → re-verify) that v1 trades for operational simplicity.
     */
    FIEF_PLUGIN_HMAC_SECRET: z.string().min(1),

    /*
     * --- Build/deploy metadata (informational; not required at runtime) ---
     */
    VERCEL_ENV: z.string().optional(),
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
    REPOSITORY_URL: z.string().optional(),
  },
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    ENV: z.enum(["local", "development", "staging", "production"]).default("local"),
  },
  /*
   * Manual destructuring so values participate in turbo.json env-declarations
   * and are visible to Next.js's edge runtime (which strips dynamic
   * process.env access).
   */
  runtimeEnv: {
    ...newSecretKeyRuntimeEnv,
    ALLOWED_DOMAIN_PATTERN: process.env.ALLOWED_DOMAIN_PATTERN,
    APL: process.env.APL,
    APP_API_BASE_URL: process.env.APP_API_BASE_URL,
    APP_IFRAME_BASE_URL: process.env.APP_IFRAME_BASE_URL,
    APP_LOG_LEVEL: process.env.APP_LOG_LEVEL,
    APP_NAME: process.env.APP_NAME,
    CRON_SECRET: process.env.CRON_SECRET,
    ENV: process.env.ENV,
    FIEF_BASE_URL: process.env.FIEF_BASE_URL,
    FIEF_PLUGIN_HMAC_SECRET: process.env.FIEF_PLUGIN_HMAC_SECRET,
    FIEF_SALEOR_TO_FIEF_DISABLED: process.env.FIEF_SALEOR_TO_FIEF_DISABLED,
    FIEF_SYNC_DISABLED: process.env.FIEF_SYNC_DISABLED,
    MANIFEST_APP_ID: process.env.MANIFEST_APP_ID,
    MONGODB_DATABASE: process.env.MONGODB_DATABASE,
    MONGODB_URL: process.env.MONGODB_URL,
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    REPOSITORY_URL: process.env.REPOSITORY_URL,
    SECRET_KEY: process.env.SECRET_KEY,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  },
  isServer: typeof window === "undefined" || process.env.NODE_ENV === "test",
  /*
   * `next build` imports route modules to collect page data, which transitively
   * loads this env file. The build environment doesn't (and shouldn't) hold
   * production secrets — validation must run at runtime, not at build time.
   * NEXT_PHASE === "phase-production-build" during `next build`. Operators can
   * also set SKIP_ENV_VALIDATION=1 explicitly (e.g. CI lint jobs).
   */
  skipValidation:
    !!process.env.SKIP_ENV_VALIDATION || process.env.NEXT_PHASE === "phase-production-build",
  onValidationError(issues) {
    const validationError = fromError(issues);
    const EnvValidationError = BaseError.subclass("EnvValidationError");

    throw new EnvValidationError(validationError.toString(), {
      cause: issues,
    });
  },
});
