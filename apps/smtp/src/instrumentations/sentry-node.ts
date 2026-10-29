import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "../../sentry.options";

const hasExternalTracing = process.env.OTEL_ENABLED === "true";

Sentry.init({
  ...sentryOptions,
  dsn: process.env.SENTRY_DSN || sentryOptions.dsn,
  environment: process.env.SENTRY_ENVIRONMENT || sentryOptions.environment,
  release: process.env.SENTRY_RELEASE,
  enabled:
    process.env.SENTRY_ENABLED !== "false" &&
    (process.env.NODE_ENV === "production" || process.env.SENTRY_ENABLED === "true"),
  skipOpenTelemetrySetup: hasExternalTracing,
  tracesSampleRate: hasExternalTracing ? 0 : 0.1,
});
