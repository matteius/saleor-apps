import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, rootLogger } from "./logger";
import { loggerContext, withLoggerContext } from "./logger-context";

type CapturedLog = {
  message?: unknown;
  attributes?: Record<string, unknown>;
  _meta?: { name?: string };
};

const captured: CapturedLog[] = [];

/*
 * Attach an in-memory transport to the root logger so we can assert on emitted
 * records. The transport is registered once for the whole file; tests reset
 * the buffer in afterEach.
 */
rootLogger.attachTransport((logObj) => {
  captured.push(logObj as CapturedLog);
});

const buildRequest = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { headers: new Headers(headers) });

describe("withLoggerContext", () => {
  afterEach(() => {
    captured.length = 0;
  });

  it("enriches log records emitted inside the wrapped handler with saleorApiUrl from the header", async () => {
    const handler = withLoggerContext(async () => {
      const logger = createLogger("test.handler");

      logger.info("inside-handler");

      return new Response("ok");
    });

    await handler(
      buildRequest("https://app.test/api/webhooks/saleor/foo", {
        "saleor-api-url": "https://shop.example/graphql/",
      }),
    );

    const record = captured.find((r) => r.message === "inside-handler");

    expect(record).toBeDefined();
    expect(record?.attributes?.saleorApiUrl).toBe("https://shop.example/graphql/");
  });

  it("attaches a per-request correlation ID that differs across requests", async () => {
    const handler = withLoggerContext(async () => {
      createLogger("test.handler").info("ping");

      return new Response("ok");
    });

    await handler(buildRequest("https://app.test/api/x"));
    await handler(buildRequest("https://app.test/api/x"));

    const records = captured.filter((r) => r.message === "ping");

    expect(records).toHaveLength(2);
    const ids = records.map((r) => r.attributes?.correlationId);

    expect(ids[0]).toBeTypeOf("string");
    expect(ids[1]).toBeTypeOf("string");
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("includes the request path on every log line emitted in scope", async () => {
    const handler = withLoggerContext(async () => {
      createLogger("test.handler").info("with-path");

      return new Response("ok");
    });

    await handler(buildRequest("https://app.test/api/webhooks/saleor/customer-created"));

    const record = captured.find((r) => r.message === "with-path");

    expect(record?.attributes?.path).toBe("/api/webhooks/saleor/customer-created");
  });

  it("is composable (returns a NextAppRouterHandler-shaped fn that yields the inner Response)", async () => {
    const handler = withLoggerContext(async () => new Response("body", { status: 202 }));

    const res = await handler(buildRequest("https://app.test/api/x"));

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("body");
  });

  it("exposes loggerContext.set so downstream middleware can stash attributes", async () => {
    const handler = withLoggerContext(async () => {
      loggerContext.set("custom-key", "custom-value");
      createLogger("test.handler").info("with-extra");

      return new Response("ok");
    });

    await handler(buildRequest("https://app.test/api/x"));

    const record = captured.find((r) => r.message === "with-extra");

    expect(record?.attributes?.["custom-key"]).toBe("custom-value");
  });
});
