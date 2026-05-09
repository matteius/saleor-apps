/**
 * Map TRPCError codes to HTTP responses for the public subscriptions API
 * (T19a). The internal tRPC procedures (T20–T23) signal failure using
 * `TRPCError`; we translate those into JSON responses with appropriate
 * HTTP status codes for the storefront client.
 */
import { TRPCError } from "@trpc/server";

import { createLogger } from "@/lib/logger";

const logger = createLogger("publicSubscriptionsErrorMapping");

/**
 * Mirror of @trpc/server's `getHTTPStatusCodeFromError` minus the
 * dependency surface so we don't pull in additional internals. Covers the
 * codes T20–T23 are expected to throw.
 */
const HTTP_STATUS_FROM_TRPC_CODE: Record<string, number> = {
  PARSE_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 408,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
  CLIENT_CLOSED_REQUEST: 499,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

export const trpcErrorToResponse = (e: unknown, path: string): Response => {
  if (e instanceof TRPCError) {
    const status = HTTP_STATUS_FROM_TRPC_CODE[e.code] ?? 500;

    if (status >= 500) {
      logger.error(`Internal error from public API ${path}`, { code: e.code, message: e.message });
    } else {
      logger.info(`Client error from public API ${path}`, { code: e.code, message: e.message });
    }

    return new Response(JSON.stringify({ error: e.code.toLowerCase(), message: e.message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  logger.error(`Unhandled error in public API ${path}`, { error: e });

  return new Response(
    JSON.stringify({ error: "internal_server_error", message: "Unhandled server error" }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
};

/**
 * Validation-only zod errors → 400.
 */
export const validationErrorResponse = (message: string): Response =>
  new Response(JSON.stringify({ error: "bad_request", message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
