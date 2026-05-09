/**
 * @vitest-environment node
 *
 * T41 — Saleor webhook invocation helpers.
 *
 * The Saleor App SDK's `SaleorAsyncWebhook.createHandler(...)` runs the
 * JWKS signature check inside the wrapper before our route body is invoked.
 * Standing JWKS up here would re-do work covered by the dedicated
 * `verify-signature.test.ts` suite (T48). The pattern in
 * `customer-created/route.test.ts` is to `vi.mock(...)` the SDK adapter
 * and inject a synthetic ctx — we reuse that pattern, just expose a small
 * helper to drive it consistently across the four event suites.
 *
 * Each test file MUST install the SDK mock at module scope (vitest hoists
 * `vi.mock` calls); this helper provides the shared `__nextCtx` shape and
 * the request builder.
 */

/**
 * Synthetic webhook delivery ctx exposed to the route's `createHandler`
 * callback. Mirrors the `ctx` the SDK builds in production.
 */
export interface SyntheticSaleorCtx {
  payload: unknown;
  authData: { saleorApiUrl: string; appId: string; token: string };
}

/**
 * Build a synthetic Saleor User payload for the four customer events.
 * `metadata` / `privateMetadata` are honored as-is so loop-canary tests
 * can stamp the origin marker.
 */
export const buildSaleorUserPayload = (overrides: {
  id?: string;
  email?: string;
  metadata?: Array<{ key: string; value: string }>;
  privateMetadata?: Array<{ key: string; value: string }>;
}): Record<string, unknown> => ({
  version: "3.20.0",
  user: {
    id: overrides.id ?? "VXNlcjox",
    email: overrides.email ?? "alice@example.com",
    firstName: "Alice",
    lastName: "Example",
    isActive: true,
    isConfirmed: true,
    languageCode: "EN_US",
    dateJoined: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    metadata: overrides.metadata ?? [],
    privateMetadata: overrides.privateMetadata ?? [],
  },
});

/**
 * Build a Next-compatible `Request` for invocation against a Saleor
 * webhook route. The handler reads `req.nextUrl.pathname` (via the
 * `withLoggerContext` wrapper); plain `Request` doesn't carry `nextUrl`
 * so we polyfill it.
 */
export const buildSaleorWebhookRequest = (args: {
  pathname: string;
  saleorApiUrl: string;
  event: string;
}): Request => {
  const url = `https://app.test${args.pathname}`;
  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify({ webhook: "saleor", event: args.event }),
    headers: { "saleor-api-url": args.saleorApiUrl },
  });

  Object.defineProperty(req, "nextUrl", { value: new URL(url) });

  return req;
};
