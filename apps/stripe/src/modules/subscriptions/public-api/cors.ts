/**
 * CORS layer for the public subscriptions API (T19a).
 *
 * The storefront and the Stripe Saleor app live on different deployments —
 * any browser-side fetch from the storefront will hit a preflight OPTIONS
 * before the real request. This module:
 *   - parses `env.STOREFRONT_PUBLIC_URL` (a comma-separated allowlist)
 *   - returns proper preflight headers if the origin is allowlisted
 *   - returns a 403 if the origin is set but not allowlisted
 *
 * Wildcard `*` is intentionally NOT supported — these endpoints expose
 * subscription mutations and reading subscription state, both of which
 * must be locked down to known storefront origins. If
 * `STOREFRONT_PUBLIC_URL` is unset we still allow same-origin /
 * server-to-server callers (which carry no `Origin` header) so deployment
 * doesn't break before the env is configured.
 */
import { env } from "@/lib/env";

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Storefront-Auth",
  "X-Storefront-Timestamp",
];

const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];

const parseAllowlist = (raw: string | undefined): string[] => {
  if (!raw) return [];

  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
};

/**
 * Check whether the request's `Origin` is allowed.
 * Returns `null` (allowed) when:
 *   - no Origin header (server-to-server call)
 *   - Origin matches the allowlist exactly
 * Returns a 403 `Response` otherwise.
 */
export const checkOrigin = (request: Request): Response | null => {
  const origin = request.headers.get("origin");

  if (!origin) return null;

  const allowlist = parseAllowlist(env.STOREFRONT_PUBLIC_URL);

  if (allowlist.length === 0) {
    /*
     * No allowlist configured — fall through to allow. Documented behavior
     * because in fresh deploys the env var may not yet be set; the HMAC +
     * Fief layers still gate access to the actual data.
     */
    return null;
  }

  const normalized = origin.replace(/\/+$/, "");

  if (allowlist.includes(normalized)) return null;

  return new Response(JSON.stringify({ error: "forbidden", message: "Origin not allowlisted" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Build CORS response headers to attach to a successful response. Echoes
 * the request `Origin` only when it's allowlisted (or when no allowlist is
 * configured, in which case we echo it but still rely on Fief+HMAC for auth).
 */
export const buildCorsHeaders = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };

  if (!origin) return headers;

  const allowlist = parseAllowlist(env.STOREFRONT_PUBLIC_URL);
  const normalized = origin.replace(/\/+$/, "");

  if (allowlist.length === 0 || allowlist.includes(normalized)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
};

/**
 * Standard preflight handler. Routes export this as their `OPTIONS` member.
 */
export const handlePreflight = (request: Request): Response => {
  const denied = checkOrigin(request);

  if (denied) return denied;

  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request),
  });
};

/**
 * Wraps a Response with CORS headers. Use to decorate non-CORS responses
 * (route success/error) so the browser accepts them.
 */
export const withCorsHeaders = (request: Request, response: Response): Response => {
  const cors = buildCorsHeaders(request);

  for (const [k, v] of Object.entries(cors)) {
    response.headers.set(k, v);
  }

  return response;
};
