import { describe, expect, it } from "vitest";

import { appInternalTracer } from "./tracing";

describe("appInternalTracer (no-op shim)", () => {
  it("exposes startActiveSpan", () => {
    expect(typeof appInternalTracer.startActiveSpan).toBe("function");
  });

  it("invokes the wrapped function and returns its result", () => {
    const result = appInternalTracer.startActiveSpan("unit-span", () => 42);

    expect(result).toBe(42);
  });

  it("passes a span-shaped argument that exposes no-op end/setAttribute methods", () => {
    appInternalTracer.startActiveSpan("noop-span", (span) => {
      /*
       * None of these should throw — the span is a no-op shim that satisfies
       * the OTel call-site contract so future migration is a single-file swap.
       */
      expect(typeof span.end).toBe("function");
      expect(typeof span.setAttribute).toBe("function");
      expect(typeof span.setAttributes).toBe("function");
      expect(typeof span.recordException).toBe("function");
      expect(typeof span.setStatus).toBe("function");

      span.end();
      span.setAttribute("k", "v");
      span.setAttributes({ a: 1, b: "2" });
      span.recordException(new Error("boom"));
      span.setStatus({ code: 1 });
    });
  });

  it("supports an async wrapped function and returns the awaited result", async () => {
    const result = await appInternalTracer.startActiveSpan("async-span", async () => {
      return "ok";
    });

    expect(result).toBe("ok");
  });

  it("propagates errors thrown inside the wrapped fn (does not swallow)", () => {
    expect(() =>
      appInternalTracer.startActiveSpan("throwing-span", () => {
        throw new Error("call-site error");
      }),
    ).toThrow("call-site error");
  });
});
