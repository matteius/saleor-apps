/*
 * @vitest-environment node
 *
 * HTTP integration test for POST /api/public/subscriptions/change-plan (T19a).
 */
import { createHmac } from "node:crypto";

import { generateKeyPair, type KeyLike, SignJWT } from "jose";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as changePlanHandlers from "./route";

const TEST_SECRET = "x".repeat(32);
const ROUTE_PATH = "/api/public/subscriptions/change-plan";

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

describe("POST /api/public/subscriptions/change-plan", () => {
  it("bubbles up 501 NOT_IMPLEMENTED from the internal stub", async () => {
    const body = JSON.stringify({
      stripeSubscriptionId: "sub_test_1",
      newStripePriceId: "price_pro_monthly",
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
      appHandler: changePlanHandlers,
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

        expect(response.status).toBe(501);

        const json = await response.json();

        expect(String(json.message)).toMatch(/T21/);
      },
    });
  });
});
