// cspell:ignore HMAC hmac signup
/**
 * Build a request to the storefront-facing public subscriptions API.
 *
 * The endpoint enforces two-layer auth (T19a):
 *   - HMAC-SHA256 over `${path}\n${timestamp}\n${rawBody}` keyed by
 *     `STOREFRONT_BRIDGE_SECRET`.
 *   - A Fief-issued JWT in `Authorization: Bearer ...`.
 *
 * In E2E, the JWT must be obtained out-of-band from the test Fief instance
 * and supplied via env (`E2E_FIEF_TEST_JWT`). The HMAC secret is read from
 * `STOREFRONT_BRIDGE_SECRET` (same env the app reads — it's already loaded
 * by `playwright.config.ts` from `.env.test`).
 */
import { createHmac } from "node:crypto";

export type StorefrontRequestInput = {
  baseUrl: string;
  path: string; // e.g. "/api/public/subscriptions/create"
  body: Record<string, unknown>;
  hmacSecret: string;
  fiefJwt: string;
};

export type StorefrontRequestArtifacts = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export function buildStorefrontRequest(input: StorefrontRequestInput): StorefrontRequestArtifacts {
  const body = JSON.stringify(input.body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${input.path}\n${timestamp}\n${body}`;
  const hmac = createHmac("sha256", input.hmacSecret).update(payload).digest("hex");

  return {
    url: new URL(input.path, input.baseUrl).toString(),
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Storefront-Auth": hmac,
      "X-Storefront-Timestamp": timestamp,
      Authorization: `Bearer ${input.fiefJwt}`,
    },
  };
}
