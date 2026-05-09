import { booleanEnv } from "@saleor/apps-shared/boolean-env";
import {
  newSecretKeyRuntimeEnv,
  newSecretKeyServerSchema,
} from "@saleor/apps-shared/secret-key-resolution";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { fromError } from "zod-validation-error";

import { BaseError } from "@/lib/errors";

export const env = createEnv({
  client: {
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  },
  server: {
    ...newSecretKeyServerSchema,
    ALLOWED_DOMAIN_PATTERN: z.string().optional(),
    APL: z.enum(["saleor-cloud", "file", "dynamodb", "mongodb"]).default("file"),
    APP_API_BASE_URL: z.string().optional(),
    APP_IFRAME_BASE_URL: z.string().optional(),
    APP_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    MANIFEST_APP_ID: z.string().default("saleor.app.payment.stripe"),
    OTEL_ACCESS_TOKEN: z.string().optional(),
    OTEL_ENABLED: booleanEnv.defaultFalse,
    OTEL_SERVICE_NAME: z.string().default("saleor-app-payment-stripe"),
    PORT: z.coerce.number().default(3000),
    REPOSITORY_URL: z.string().optional(),
    SECRET_KEY: z.string(),
    VERCEL_ENV: z.string().optional(),
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
    STRIPE_PARTNER_ID: z.string().optional(),
    DYNAMODB_MAIN_TABLE_NAME: z.string().optional(),
    DYNAMODB_REQUEST_TIMEOUT_MS: z.coerce.number().default(5_000),
    DYNAMODB_CONNECTION_TIMEOUT_MS: z.coerce.number().default(2_000),
    AWS_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_ROLE_ARN: z.string().optional(),
    MONGODB_URL: z.string().optional(),
    MONGODB_DATABASE: z.string().optional(),
    APPSTORE_URL: z.string().optional(),
    APP_NAME: z.string().default("Stripe"),
    // URL of the OwlBooks /api/webhooks/subscription-status receiver.
    OWLBOOKS_WEBHOOK_URL: z.string().url().optional(),
    // HMAC-SHA256 secret shared with OwlBooks for webhook signature verification.
    OWLBOOKS_WEBHOOK_SECRET: z.string().min(32).optional(),
    // HMAC-SHA256 secret shared with the storefront for the public subscription API in T19a.
    STOREFRONT_BRIDGE_SECRET: z.string().min(32).optional(),
    /*
     * Fief JWKS URL used by the public subscriptions API to verify storefront-issued
     * Fief access tokens (T19a Layer 2 auth). Example:
     * https://auth.opensensor.io/.well-known/jwks.json
     */
    FIEF_JWKS_URL: z.string().url().optional(),
    /*
     * Comma-separated allowlist of storefront origins permitted to call /api/public/*.
     * Used by the CORS layer of the public subscriptions API (T19a). Example:
     * https://storefront.opensensor.io,https://owlbooks.ai
     */
    STOREFRONT_PUBLIC_URL: z.string().optional(),
    // Vercel Cron auth bearer (used by the failed-mint retry job in T32a).
    CRON_SECRET: z.string().optional(),
  },
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    ENV: z.enum(["local", "development", "staging", "production"]).default("local"),
  },
  // we use the manual destruction here to validate if env variable is set inside turbo.json
  runtimeEnv: {
    ...newSecretKeyRuntimeEnv,
    ALLOWED_DOMAIN_PATTERN: process.env.ALLOWED_DOMAIN_PATTERN,
    APL: process.env.APL,
    APP_API_BASE_URL: process.env.APP_API_BASE_URL,
    APP_IFRAME_BASE_URL: process.env.APP_IFRAME_BASE_URL,
    APP_LOG_LEVEL: process.env.APP_LOG_LEVEL,
    ENV: process.env.ENV,
    MANIFEST_APP_ID: process.env.MANIFEST_APP_ID,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NODE_ENV: process.env.NODE_ENV,
    OTEL_ACCESS_TOKEN: process.env.OTEL_ACCESS_TOKEN,
    OTEL_ENABLED: process.env.OTEL_ENABLED,
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    PORT: process.env.PORT,
    REPOSITORY_URL: process.env.REPOSITORY_URL,
    SECRET_KEY: process.env.SECRET_KEY,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    STRIPE_PARTNER_ID: process.env.STRIPE_PARTNER_ID,
    DYNAMODB_MAIN_TABLE_NAME: process.env.DYNAMODB_MAIN_TABLE_NAME,
    DYNAMODB_REQUEST_TIMEOUT_MS: process.env.DYNAMODB_REQUEST_TIMEOUT_MS,
    DYNAMODB_CONNECTION_TIMEOUT_MS: process.env.DYNAMODB_CONNECTION_TIMEOUT_MS,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_ROLE_ARN: process.env.AWS_ROLE_ARN,
    MONGODB_URL: process.env.MONGODB_URL,
    MONGODB_DATABASE: process.env.MONGODB_DATABASE,
    APPSTORE_URL: process.env.APPSTORE_URL,
    APP_NAME: process.env.APP_NAME,
    OWLBOOKS_WEBHOOK_URL: process.env.OWLBOOKS_WEBHOOK_URL,
    OWLBOOKS_WEBHOOK_SECRET: process.env.OWLBOOKS_WEBHOOK_SECRET,
    STOREFRONT_BRIDGE_SECRET: process.env.STOREFRONT_BRIDGE_SECRET,
    FIEF_JWKS_URL: process.env.FIEF_JWKS_URL,
    STOREFRONT_PUBLIC_URL: process.env.STOREFRONT_PUBLIC_URL,
    CRON_SECRET: process.env.CRON_SECRET,
  },
  isServer: typeof window === "undefined" || process.env.NODE_ENV === "test",
  onValidationError(issues) {
    const validationError = fromError(issues);

    const EnvValidationError = BaseError.subclass("EnvValidationError");

    throw new EnvValidationError(validationError.toString(), {
      cause: issues,
    });
  },
});
