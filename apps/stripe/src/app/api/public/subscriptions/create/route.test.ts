/*
 * @vitest-environment node
 *
 * HTTP integration test for POST /api/public/subscriptions/create (T19a).
 * Confirms the route wires through the auth helper into the internal tRPC
 * caller and returns its setup-intent response.
 */
import { createHmac } from "node:crypto";

import { generateKeyPair, type KeyLike, SignJWT } from "jose";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as createHandlers from "./route";

const TEST_SECRET = "x".repeat(32);
const ROUTE_PATH = "/api/public/subscriptions/create";
const { createSubscription } = vi.hoisted(() => ({ createSubscription: vi.fn() }));

vi.mock("@/modules/trpc/internal-caller", () => ({
  createInternalSubscriptionsCaller: () => ({ create: createSubscription }),
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();

  return {
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "STOREFRONT_BRIDGE_SECRET") return TEST_SECRET;
        if (prop === "FIEF_JWKS_URL") return "https://test.fief.example/.well-known/jwks.json";

        return Reflect.get(target, prop);
      },
    }),
  };
});

let privateKey: KeyLike;
let publicKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });

  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

beforeEach(() => {
  createSubscription.mockReset();
  createSubscription.mockResolvedValue({
    stripeSubscriptionId: "sub_abc123",
    stripeCustomerId: "cus_abc123",
    clientSecret: "seti_secret_abc123",
    intentType: "setup",
    publishableKey: "pk_test_abc123",
  });
});

vi.mock("@/modules/subscriptions/public-api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/subscriptions/public-api/auth")>();

  return {
    ...actual,
    verifyPublicApiRequest: (input: Parameters<typeof actual.verifyPublicApiRequest>[0]) =>
      actual.verifyPublicApiRequest({
        ...input,
        jwksOverride: (async () => publicKey) as never,
      }),
  };
});

describe("POST /api/public/subscriptions/create", () => {
  it("creates a trial subscription and returns its setup intent", async () => {
    const body = JSON.stringify({
      fiefUserId: "user-1",
      email: "alice@example.com",
      stripePriceId: "price_abc123",
      trialEnd: 1_800_000_000,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmac = createHmac("sha256", TEST_SECRET)
      .update(`${ROUTE_PATH}\n${timestamp}\n${body}`)
      .digest("hex");
    const jwt = await new SignJWT({ sub: "user-1", email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await testApiHandler({
      appHandler: createHandlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-storefront-auth": hmac,
            "x-storefront-timestamp": timestamp,
            authorization: `Bearer ${jwt}`,
          },
          body,
        });

        expect(response.status).toBe(200);

        const json = await response.json();

        expect(json).toStrictEqual({
          stripeSubscriptionId: "sub_abc123",
          stripeCustomerId: "cus_abc123",
          clientSecret: "seti_secret_abc123",
          intentType: "setup",
          publishableKey: "pk_test_abc123",
        });
        expect(createSubscription).toHaveBeenCalledExactlyOnceWith({
          fiefUserId: "user-1",
          email: "alice@example.com",
          stripePriceId: "price_abc123",
          trialEnd: 1_800_000_000,
        });
      },
    });
  });

  it("rejects with 401 when HMAC is invalid", async () => {
    const body = JSON.stringify({
      fiefUserId: "user-1",
      email: "alice@example.com",
      stripePriceId: "price_abc123",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const jwt = await new SignJWT({ sub: "user-1", email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await testApiHandler({
      appHandler: createHandlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-storefront-auth": "0".repeat(64),
            "x-storefront-timestamp": timestamp,
            authorization: `Bearer ${jwt}`,
          },
          body,
        });

        expect(response.status).toBe(401);
      },
    });
  });

  it("returns 400 when the body is malformed", async () => {
    await testApiHandler({
      appHandler: createHandlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        });

        expect(response.status).toBe(400);
      },
    });
  });
});

describe("OPTIONS /api/public/subscriptions/create", () => {
  it("returns CORS preflight headers", async () => {
    await testApiHandler({
      appHandler: createHandlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch({
          method: "OPTIONS",
          headers: { origin: "https://storefront.example" },
        });

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-methods")).toContain("POST");
      },
    });
  });
});
