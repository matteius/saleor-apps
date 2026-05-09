/*
 * @vitest-environment node
 * Use Node env (not jsdom) — jsdom stubs Request/Response which breaks
 * Node 24's strict instance checks on AbortSignal in next-test-api-route-handler.
 */
import { testApiHandler } from "next-test-api-route-handler";
import { describe, expect, it, vi } from "vitest";

import manifestHandler from "@/pages/api/manifest";

vi.mock("@/lib/env", async () => {
  const original = await vi.importActual("@/lib/env");

  return {
    env: {
      // @ts-expect-error - it doesn't inherit the type
      ...original.env,
      APP_API_BASE_URL: "https://localhost:3000",
      APP_IFRAME_BASE_URL: "https://localhost:3000",
      APP_NAME: "Fief",
      MANIFEST_APP_ID: "saleor.app.fief",
    },
  };
});

describe("Fief app manifest handler", () => {
  it("returns a JSON manifest with the expected shape and an empty webhooks list (T1)", async () => {
    await testApiHandler({
      pagesHandler: manifestHandler,
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });

        expect(res.status).toBe(200);

        const body = await res.json();

        expect(body).toMatchObject({
          appUrl: "https://localhost:3000",
          author: "OpenSensor",
          brand: { logo: { default: "https://localhost:3000/logo.png" } },
          extensions: [],
          id: "saleor.app.fief",
          name: "Fief",
          permissions: ["MANAGE_USERS"],
          requiredSaleorVersion: ">=3.21 <4",
          tokenTargetUrl: "https://localhost:3000/api/register",
          webhooks: [],
        });
        expect(typeof body.version).toBe("string");
      },
    });
  });
});
