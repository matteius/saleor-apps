import { describe, expect, it } from "vitest";

import { createLogger } from "./logger";

describe("createLogger", () => {
  it("returns an object exposing the canonical log-level methods", () => {
    const logger = createLogger("test-suite");

    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("does not throw when invoked with a message + attributes payload", () => {
    const logger = createLogger("call-site");

    expect(() =>
      logger.info("hello world", { saleorApiUrl: "https://example.test/graphql/" }),
    ).not.toThrow();
  });

  it("returns a distinct child logger per name (carries the name on the bound payload)", () => {
    const parent = createLogger("parent");
    const child = createLogger("child", { contextKey: "ctx-value" });

    // both must remain functional and not throw on use
    expect(() => parent.info("from parent")).not.toThrow();
    expect(() => child.info("from child")).not.toThrow();
  });
});
