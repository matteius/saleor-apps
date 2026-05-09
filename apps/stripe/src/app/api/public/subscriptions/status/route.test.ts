/*
 * @vitest-environment node
 *
 * HTTP integration test for GET /api/public/subscriptions/status (T19a).
 */
import { createHmac } from "node:crypto";

import { generateKeyPair, type KeyLike, SignJWT } from "jose";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as statusHandlers from "./route";

const TEST_SECRET = "x".repeat(32);
const ROUTE_PATH = "/api/public/subscriptions/status";

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

describe("GET /api/public/subscriptions/status", () => {
  it("bubbles up 501 NOT_IMPLEMENTED from the internal stub when looking up by stripeSubscriptionId", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    // GET signs over an empty body
    const hmac = createHmac("sha256", TEST_SECRET)
      .update(`${ROUTE_PATH}\n${timestamp}\n`)
      .digest("hex");
    const jwt = await new SignJWT({ sub: "user-1", email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await testApiHandler({
      appHandler: statusHandlers,
      url: `${ROUTE_PATH}?stripeSubscriptionId=sub_abc123`,
      async test({ fetch }) {
        const response = await fetch({
          method: "GET",
          headers: {
            "x-storefront-auth": hmac,
            "x-storefront-timestamp": timestamp,
            authorization: `Bearer ${jwt}`,
          },
        });

        expect(response.status).toBe(501);

        const json = await response.json();

        expect(String(json.message)).toMatch(/T23/);
      },
    });
  });

  it("returns 400 when neither query param is provided", async () => {
    await testApiHandler({
      appHandler: statusHandlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });

        expect(response.status).toBe(400);
      },
    });
  });

  it("rejects fiefUserId query that does not match JWT sub with 401", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmac = createHmac("sha256", TEST_SECRET)
      .update(`${ROUTE_PATH}\n${timestamp}\n`)
      .digest("hex");
    const jwt = await new SignJWT({ sub: "user-1", email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await testApiHandler({
      appHandler: statusHandlers,
      url: `${ROUTE_PATH}?fiefUserId=user-attacker`,
      async test({ fetch }) {
        const response = await fetch({
          method: "GET",
          headers: {
            "x-storefront-auth": hmac,
            "x-storefront-timestamp": timestamp,
            authorization: `Bearer ${jwt}`,
          },
        });

        expect(response.status).toBe(401);
      },
    });
  });
});
