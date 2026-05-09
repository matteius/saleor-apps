/**
 * @vitest-environment node
 *
 * T40 — Integration test for `POST /api/auth/external-authentication-url`.
 *
 * Boots `mongodb-memory-server` + msw-mocked Fief OIDC + admin endpoints,
 * seeds a real `ProviderConnection` and `ChannelConfiguration`, and
 * exercises the route through the central composition root.
 *
 * Latency budget: p95 < 200 ms over 1000 sequential requests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { verify as verifyBrandingOrigin } from "@/modules/branding/origin-signer";

import {
  ALLOWED_ORIGIN,
  buildSignedRequest,
  CHANNEL_SLUG,
  FIEF_BASE_URL,
  FIEF_CLIENT_ID,
  type IntegrationHarness,
  measureLatency,
  percentile,
  REDIRECT_URI,
  SALEOR_API_URL,
  seedConnection,
  SIGNING_KEY,
  startHarness,
  stopHarness,
} from "./harness";

const ROUTE_PATHNAME = "/api/auth/external-authentication-url";

let harness: IntegrationHarness;

beforeAll(async () => {
  harness = await startHarness();
  await seedConnection();
}, 120_000);

afterAll(async () => {
  await stopHarness();
});

beforeEach(() => {
  harness.fiefMock.reset();
});

const callRoute = async (req: Request): Promise<Response> => {
  const { POST } = await import("@/app/api/auth/external-authentication-url/route");

  return POST(req as never);
};

describe("T40 — external-authentication-url end-to-end", () => {
  it("returns a Fief authorize URL with verifiable branding_origin", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          redirectUri: REDIRECT_URI,
          origin: ALLOWED_ORIGIN,
        },
      },
    });

    const res = await callRoute(req);

    expect(res.status).toBe(200);

    const body = (await res.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);

    expect(url.origin).toBe(FIEF_BASE_URL);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe(FIEF_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);

    const brandingToken = url.searchParams.get("branding_origin");

    expect(brandingToken).toBeTruthy();

    const verifyResult = verifyBrandingOrigin(brandingToken!, SIGNING_KEY, [ALLOWED_ORIGIN]);

    expect(verifyResult.isOk()).toBe(true);
    expect(verifyResult._unsafeUnwrap().origin).toBe(ALLOWED_ORIGIN);
  });

  it("returns 401 on bad HMAC signature", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: { redirectUri: REDIRECT_URI, origin: ALLOWED_ORIGIN },
      },
      secret: "the-wrong-secret",
    });

    const res = await callRoute(req);

    expect(res.status).toBe(401);
  });

  it("returns 404 when no channel-config exists for the saleor instance", async () => {
    /*
     * Use a saleorApiUrl we never seeded — the channel-config repo returns
     * `null`, the resolver returns `null`, the route maps it to 404.
     * Distinct from "channel slug doesn't match" because our seed sets a
     * defaultConnectionId, which catches unknown slugs by design.
     */
    const otherSaleorUrl = "https://shop-2.saleor.cloud/graphql/";
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {
        saleorApiUrl: otherSaleorUrl,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: { redirectUri: REDIRECT_URI, origin: ALLOWED_ORIGIN },
      },
      saleorApiUrl: otherSaleorUrl,
    });

    const res = await callRoute(req);

    expect(res.status).toBe(404);
  });

  it("returns 400 on origin not in connection allowedOrigins", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {
        saleorApiUrl: SALEOR_API_URL as unknown as string,
        channelSlug: CHANNEL_SLUG as unknown as string,
        input: {
          redirectUri: REDIRECT_URI,
          origin: "https://malicious.example.com",
        },
      },
    });

    const res = await callRoute(req);

    expect(res.status).toBe(400);
  });

  it(
    "p95 latency over 1000 requests is under 200 ms (T18 budget)",
    { timeout: 300_000 },
    async () => {
      const samples = await measureLatency(1000, async () => {
        const req = buildSignedRequest({
          pathname: ROUTE_PATHNAME,
          body: {
            saleorApiUrl: SALEOR_API_URL as unknown as string,
            channelSlug: CHANNEL_SLUG as unknown as string,
            input: { redirectUri: REDIRECT_URI, origin: ALLOWED_ORIGIN },
          },
        });

        const res = await callRoute(req);

        if (res.status !== 200) {
          throw new Error(`expected 200, got ${res.status}`);
        }
      });

      const p95 = percentile(samples.perRequestMs, 95);
      const p99 = percentile(samples.perRequestMs, 99);
      const median = percentile(samples.perRequestMs, 50);

      console.log(
        `T18 latency over 1000 reqs: median=${median.toFixed(2)}ms p95=${p95.toFixed(
          2,
        )}ms p99=${p99.toFixed(2)}ms total=${samples.totalMs.toFixed(0)}ms`,
      );

      expect(p95).toBeLessThan(200);
    },
  );

  it("verifies the connection-pool singleton invariant — one connect across the run", () => {
    const calls = harness.getConnectCallCount();

    expect(calls).toBe(1);
  });
});
