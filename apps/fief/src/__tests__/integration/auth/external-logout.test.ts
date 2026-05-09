/**
 * @vitest-environment node
 *
 * T40 — Integration test for `POST /api/auth/external-logout`.
 *
 * Boots Mongo + msw + composition root. The Fief revoke endpoint is served
 * by msw so we can assert the route hits it (counter on `harness.fiefMock.state`).
 *
 * Required tests:
 *   - Happy path: revoke called, returns 200.
 *   - Bad HMAC → 401, revoke not called.
 *   - No refresh token → 200, no revoke (verify-and-ack fast path).
 *   - Latency benchmark: p95 < 200 ms over 1000 sequential requests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buildSignedRequest,
  CHANNEL_SLUG,
  type IntegrationHarness,
  measureLatency,
  percentile,
  SALEOR_API_URL,
  seedConnection,
  startHarness,
  stopHarness,
} from "./harness";

const ROUTE_PATHNAME = "/api/auth/external-logout";

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
  const { POST } = await import("@/app/api/auth/external-logout/route");

  return POST(req as never);
};

describe("T40 — external-logout end-to-end", () => {
  it("happy path: invokes Fief revoke + returns 200", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: { refreshToken: "fief-refresh-token-1" },
    });

    const res = await callRoute(req);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    expect(harness.fiefMock.state.revokeCount).toBe(1);
  });

  it("bad HMAC → 401, revoke NOT called", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: { refreshToken: "fief-refresh-token-1" },
      secret: "the-wrong-secret",
    });

    const res = await callRoute(req);

    expect(res.status).toBe(401);
    expect(harness.fiefMock.state.revokeCount).toBe(0);
  });

  it("no refresh token in body → 200, no revoke call (verify-and-ack)", async () => {
    const req = buildSignedRequest({
      pathname: ROUTE_PATHNAME,
      body: {},
    });

    const res = await callRoute(req);

    expect(res.status).toBe(200);
    expect(harness.fiefMock.state.revokeCount).toBe(0);
  });

  it(
    "p95 latency over 1000 requests is under 200 ms (T21 budget)",
    { timeout: 300_000 },
    async () => {
      const samples = await measureLatency(1000, async () => {
        const req = buildSignedRequest({
          pathname: ROUTE_PATHNAME,
          body: { refreshToken: "fief-refresh-token-bench" },
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
        `T21 latency over 1000 reqs: median=${median.toFixed(2)}ms p95=${p95.toFixed(
          2,
        )}ms p99=${p99.toFixed(2)}ms total=${samples.totalMs.toFixed(0)}ms`,
      );

      expect(p95).toBeLessThan(200);
    },
  );

  it("connection-pool singleton invariant — only one MongoClient.connect across the run", () => {
    const calls = harness.getConnectCallCount();

    expect(calls).toBe(1);
  });
});

void CHANNEL_SLUG;
void SALEOR_API_URL;
