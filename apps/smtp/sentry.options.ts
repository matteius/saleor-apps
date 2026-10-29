import type { ErrorEvent } from "@sentry/nextjs";

import project from "./sentry.project.json";

export const sentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || project.dsn,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  enabled:
    process.env.NEXT_PUBLIC_SENTRY_ENABLED !== "false" && process.env.NODE_ENV === "production",
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  maxRequestBodySize: "none" as const,
  beforeSend(event: ErrorEvent) {
    delete event.user;
    if (event.request) {
      delete event.request.data;
      delete event.request.cookies;
      delete event.request.headers;
      delete event.request.query_string;
      if (event.request.url) event.request.url = event.request.url.split(/[?#]/)[0];
    }
    // Business logs can contain payment, email or registration data.
    event.breadcrumbs = event.breadcrumbs?.filter((item) => item.category !== "console");

    return event;
  },
};
