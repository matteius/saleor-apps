import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, rootLogger } from "./logger";
import { withLoggerContext } from "./logger-context";
import { withSaleorApiUrlAttributes } from "./observability-saleor-api-url";

type CapturedLog = {
  message?: unknown;
  attributes?: Record<string, unknown>;
};

const captured: CapturedLog[] = [];

rootLogger.attachTransport((logObj) => {
  captured.push(logObj as CapturedLog);
});

const compose = <T>(...fns: Array<(arg: T) => T>) =>
  fns.reduce((prev, next) => (value: T) => prev(next(value)));

const buildRequest = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { headers: new Headers(headers) });

describe("withSaleorApiUrlAttributes", () => {
  afterEach(() => {
    captured.length = 0;
  });

  it("composes with withLoggerContext via the shared `compose` shape", async () => {
    const inner = async () => {
      createLogger("composed.handler").info("composed");

      return new Response("ok");
    };

    const wrapped = compose(withLoggerContext, withSaleorApiUrlAttributes)(inner);

    const res = await wrapped(
      buildRequest("https://app.test/api/y", {
        "saleor-api-url": "https://shop.example/graphql/",
        "saleor-schema-version": "3.22",
      }),
    );

    expect(res.status).toBe(200);

    const record = captured.find((r) => r.message === "composed");

    expect(record?.attributes?.saleorApiUrl).toBe("https://shop.example/graphql/");
    expect(record?.attributes?.saleorVersion).toBe("3.22");
  });

  it("is a no-op (does not throw, does not change response) when saleor headers are absent", async () => {
    const wrapped = compose(
      withLoggerContext,
      withSaleorApiUrlAttributes,
    )(async () => new Response("body", { status: 201 }));

    const res = await wrapped(buildRequest("https://app.test/api/z"));

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("body");
  });
});
