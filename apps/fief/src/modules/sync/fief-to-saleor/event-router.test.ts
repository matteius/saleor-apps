import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import { EventRouter, type WebhookEventPayload } from "./event-router";

/*
 * Unit tests for the Fief webhook event-router (T22).
 *
 * The router is deliberately small — it owns only the Map<eventType, handler>
 * registry + an outcome-typed `dispatch`. The receiver test (`receiver.test.ts`)
 * covers the cross-cutting orchestration; here we exercise the registry
 * semantics in isolation so a future refactor can keep the unit boundary
 * tight.
 */

const buildPayload = (overrides: Partial<WebhookEventPayload> = {}): WebhookEventPayload => ({
  type: "user.created",
  data: { id: "fief-user-1" },
  eventId: "evt_abc",
  ...overrides,
});

describe("EventRouter — T22", () => {
  describe("registration", () => {
    it("returns itself from registerHandler so chained registration is supported", () => {
      const router = new EventRouter();
      const handler = vi.fn(() => ok(undefined));

      const chain = router
        .registerHandler("user.created", handler)
        .registerHandler("user.updated", handler);

      expect(chain).toBe(router);
      expect(router.hasHandler("user.created")).toBe(true);
      expect(router.hasHandler("user.updated")).toBe(true);
      expect(router.hasHandler("user.deleted")).toBe(false);
    });

    it("overwrites a previously-registered handler when the same eventType is registered twice", async () => {
      const router = new EventRouter();
      const first = vi.fn(() => ok("first"));
      const second = vi.fn(() => ok("second"));

      router.registerHandler("user.created", first).registerHandler("user.created", second);

      const outcome = await router.dispatch(buildPayload());

      expect(outcome.isOk()).toBe(true);
      // Only the most-recently-registered handler should have been invoked.
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispatch — happy path", () => {
    it("invokes the registered handler with the payload and returns a 'dispatched' outcome", async () => {
      const router = new EventRouter();
      const handler = vi.fn(() => ok(undefined));

      router.registerHandler("user.created", handler);
      const payload = buildPayload({ type: "user.created", data: { id: "u1" } });

      const result = await router.dispatch(payload);

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("dispatched");
      expect(outcome.eventType).toBe("user.created");
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it("awaits async handlers before returning", async () => {
      const router = new EventRouter();
      let resolved = false;
      const handler = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        resolved = true;

        return ok(undefined);
      });

      router.registerHandler("user.updated", handler);

      const result = await router.dispatch(buildPayload({ type: "user.updated" }));

      expect(resolved).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("dispatched");
    });
  });

  describe("dispatch — handler returns Err", () => {
    it("translates an Err result into a 'failed' outcome carrying the underlying error", async () => {
      const router = new EventRouter();
      const handlerError = new Error("downstream Saleor mutation rejected");
      const handler = vi.fn(() => err(handlerError));

      router.registerHandler("user.created", handler);

      const result = await router.dispatch(buildPayload());

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.error).toBe(handlerError);
      }
    });
  });

  describe("dispatch — handler throws", () => {
    it("treats a thrown exception as 'failed' (defensive — handlers should return Result)", async () => {
      const router = new EventRouter();
      const thrownError = new Error("handler crashed unexpectedly");
      const handler = vi.fn(() => {
        throw thrownError;
      });

      router.registerHandler("user.created", handler);

      const result = await router.dispatch(buildPayload());

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.error).toBe(thrownError);
      }
    });
  });

  describe("dispatch — no handler registered", () => {
    it("returns 'no-handler' outcome (forward-compat) without invoking any handler", async () => {
      const router = new EventRouter();

      const result = await router.dispatch(
        buildPayload({ type: "tenant.created", data: { id: "t1" } }),
      );

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("no-handler");
      expect(outcome.eventType).toBe("tenant.created");
    });

    it("does not invoke handlers registered for other event types", async () => {
      const router = new EventRouter();
      const otherHandler = vi.fn(() => ok(undefined));

      router.registerHandler("user.created", otherHandler);

      await router.dispatch(buildPayload({ type: "user.deleted" }));

      expect(otherHandler).not.toHaveBeenCalled();
    });
  });
});
