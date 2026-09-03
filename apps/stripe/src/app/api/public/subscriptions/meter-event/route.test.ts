/* @vitest-environment node */
import { createHmac } from "node:crypto";

import { ok } from "neverthrow";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as EnvModule from "@/lib/env";

import * as handlers from "./route";

const TEST_SECRET = "m".repeat(32);
const TEST_PRICE_ID = "price_LIGHTNVR";
const ROUTE_PATH = "/api/public/subscriptions/meter-event";
const { getBySubscriptionId, createMeterEvent } = vi.hoisted(() => ({
  getBySubscriptionId: vi.fn(),
  createMeterEvent: vi.fn(),
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();

  return {
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "LIGHTNVR_METER_BRIDGE_SECRET") return TEST_SECRET;
        if (prop === "LIGHTNVR_METER_EVENT_NAME") return "lightnvr_cloud_usage";
        if (prop === "LIGHTNVR_METER_PRICE_ID") return TEST_PRICE_ID;

        return Reflect.get(target, prop);
      },
    }),
  };
});

vi.mock("@/modules/subscriptions/internal-runtime", () => ({
  resolveInternalSubscriptionRuntime: async () => ({
    accessPattern: { saleorApiUrl: "https://saleor.example/graphql/", appId: "app_test" },
    subscriptionRepo: { getBySubscriptionId },
    stripeSubscriptionsApi: { createMeterEvent },
  }),
}));

const signedRequest = (body: string, valid = true) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = valid
    ? createHmac("sha256", TEST_SECRET).update(`${ROUTE_PATH}\n${timestamp}\n${body}`).digest("hex")
    : "0".repeat(64);

  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      "x-lightnvr-auth": signature,
      "x-storefront-timestamp": timestamp,
    },
    body,
  };
};

beforeEach(() => {
  getBySubscriptionId.mockReset();
  createMeterEvent.mockReset();
  getBySubscriptionId.mockResolvedValue(
    ok({
      status: "active",
      stripeCustomerId: "cus_TEST",
      stripePriceId: TEST_PRICE_ID,
    }),
  );
  createMeterEvent.mockResolvedValue(
    ok({ identifier: "lnvr-interval-1", event_name: "lightnvr_cloud_usage" }),
  );
});

describe("POST /api/public/subscriptions/meter-event", () => {
  const payload = {
    stripeSubscriptionId: "sub_TEST",
    eventName: "lightnvr_cloud_usage",
    value: 34247,
    identifier: "lnvr-interval-1",
    timestamp: 1_800_000_000,
    dimensions: { lightnvr_tenant_id: "tenant-1" },
  };

  it("accepts and forwards a service-authenticated allocation interval", async () => {
    const body = JSON.stringify(payload);

    await testApiHandler({
      appHandler: handlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch(signedRequest(body));

        expect(response.status).toBe(202);
        expect(await response.json()).toStrictEqual({
          identifier: "lnvr-interval-1",
          eventName: "lightnvr_cloud_usage",
        });
        expect(createMeterEvent).toHaveBeenCalledExactlyOnceWith({
          customerId: "cus_TEST",
          eventName: "lightnvr_cloud_usage",
          value: 34247,
          identifier: "lnvr-interval-1",
          timestamp: 1_800_000_000,
          dimensions: { lightnvr_tenant_id: "tenant-1" },
        });
      },
    });
  });

  it("rejects a bad service signature before looking up the subscription", async () => {
    const body = JSON.stringify(payload);

    await testApiHandler({
      appHandler: handlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch(signedRequest(body, false));

        expect(response.status).toBe(401);
        expect(getBySubscriptionId).not.toHaveBeenCalled();
      },
    });
  });

  it("does not report usage for a non-billable subscription", async () => {
    getBySubscriptionId.mockResolvedValue(
      ok({
        status: "canceled",
        stripeCustomerId: "cus_TEST",
        stripePriceId: TEST_PRICE_ID,
      }),
    );
    const body = JSON.stringify(payload);

    await testApiHandler({
      appHandler: handlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch(signedRequest(body));

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: "subscription_not_billable",
          status: "canceled",
        });
        expect(createMeterEvent).not.toHaveBeenCalled();
      },
    });
  });

  it("rejects subscriptions that do not use the configured LightNVR Price", async () => {
    getBySubscriptionId.mockResolvedValue(
      ok({
        status: "active",
        stripeCustomerId: "cus_TEST",
        stripePriceId: "price_OWLBOOKS",
      }),
    );
    const body = JSON.stringify(payload);

    await testApiHandler({
      appHandler: handlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch(signedRequest(body));

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "subscription_not_allowed" });
        expect(createMeterEvent).not.toHaveBeenCalled();
      },
    });
  });

  it("rejects meter names outside the configured LightNVR meter", async () => {
    const body = JSON.stringify({ ...payload, eventName: "owlbooks_tokens" });

    await testApiHandler({
      appHandler: handlers,
      url: ROUTE_PATH,
      async test({ fetch }) {
        const response = await fetch(signedRequest(body));

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "meter_not_allowed" });
        expect(getBySubscriptionId).not.toHaveBeenCalled();
      },
    });
  });
});
