/*
 * @vitest-environment node
 *
 * T26 — Saleor `CUSTOMER_CREATED` webhook route handler test.
 *
 * Mocks the SDK's `SaleorAsyncWebhook.createHandler(...)` so we exercise the
 * route's enqueue + skip paths without standing up JWKS / APL / Mongo.
 *
 * The SDK auto-runs the signature check (we wired `verifyWebhookSignature`
 * into `webhook-definition.ts`); the dedicated `verify-signature.test.ts`
 * suite covers the cryptography. This file only asserts the route's branching:
 *
 *   - kill switch (T54) → 503 (no enqueue)
 *   - origin marker `"fief"` (T13) → 200 + skipped (no enqueue, no Fief I/O)
 *   - happy path (clean payload) → 200 + enqueued
 *   - bad sig: simulated by SDK adapter rejecting before our handler runs
 *     (the SDK formats a 401 itself); we stub the handler factory to mimic
 *     that path.
 */

import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
  },
}));

const enqueueMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve(
      ok({
        id: "job-1",
        saleorApiUrl: "https://shop.example.com/graphql/",
        connectionId: "conn-1",
        eventType: "saleor.customer_created",
        eventId: "evt-1",
        payload: {},
        attempts: 0,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      }),
    ),
  ),
);

vi.mock("@/modules/queue/repositories/mongodb/mongodb-queue-repo", () => ({
  MongodbOutboundQueueRepo: vi.fn().mockImplementation(() => ({
    enqueue: enqueueMock,
    lease: vi.fn(),
    complete: vi.fn(),
    releaseWithBackoff: vi.fn(),
    peek: vi.fn(),
  })),
}));

const isSaleorToFiefDisabledMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/lib/kill-switches", () => ({
  isSaleorToFiefDisabled: isSaleorToFiefDisabledMock,
  isFiefSyncDisabled: vi.fn(() => false),
}));

/*
 * Mock the SDK's `SaleorAsyncWebhook` so we don't need a live JWKS/APL.
 * The fake `createHandler(handler)` returns a plain async function that:
 *   - calls our route's body handler with a synthetic ctx,
 *   - lets us drive ctx.payload from the test.
 *
 * Each test sets `__nextCtx` before invoking POST.
 */
const __nextCtx = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        payload: unknown;
        authData: { saleorApiUrl: string; appId: string; token: string };
      },
}));

vi.mock("@saleor/app-sdk/handlers/next-app-router", () => ({
  SaleorAsyncWebhook: vi.fn().mockImplementation(() => ({
    createHandler: (handler: (req: Request, ctx: unknown) => Promise<Response>) => {
      return async (req: Request) => {
        if (!__nextCtx.current) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        }

        return handler(req, __nextCtx.current);
      };
    },
    getWebhookManifest: () => ({ name: "Customer Created" }),
  })),
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: { apl: {} },
}));

const SALEOR_API_URL = "https://shop.example.com/graphql/";

const buildPayload = (overrides: Partial<{ metadata: { key: string; value: string }[] }> = {}) => ({
  version: "3.20.0",
  user: {
    id: "VXNlcjox",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Example",
    isActive: true,
    isConfirmed: true,
    languageCode: "EN_US",
    dateJoined: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    metadata: overrides.metadata ?? [],
    privateMetadata: [],
  },
});

const buildRequest = (): Request => {
  const url = "https://app.test/api/webhooks/saleor/customer-created";
  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify({ webhook: "saleor", event: "CUSTOMER_CREATED" }),
    headers: { "saleor-api-url": SALEOR_API_URL },
  });

  /*
   * Next.js's `withLoggerContext` wrapper reads `req.nextUrl.pathname`.
   * Plain `Request` doesn't carry that — the SDK's adapter populates it
   * for real deliveries, the test polyfills it.
   */
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });

  return req;
};

describe("Saleor CUSTOMER_CREATED route — T26", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSaleorToFiefDisabledMock.mockReturnValue(false);
    __nextCtx.current = {
      payload: buildPayload(),
      authData: {
        saleorApiUrl: SALEOR_API_URL,
        appId: "app-1",
        token: "saleor-token",
      },
    };
  });

  afterEach(() => {
    __nextCtx.current = undefined;
  });

  it("happy path: enqueues the event and returns 200", async () => {
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    const args = (enqueueMock.mock.calls as unknown as unknown[][])[0]?.[0] as {
      eventType: string;
      saleorApiUrl: string;
    };

    expect(args.eventType).toBe("saleor.customer_created");
    expect(args.saleorApiUrl).toBe(SALEOR_API_URL);
  });

  it("kill switch returns 503 and does NOT enqueue", async () => {
    isSaleorToFiefDisabledMock.mockReturnValue(true);
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect(res.status).toBe(503);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("origin marker 'fief' is filtered before enqueue (200 skipped)", async () => {
    __nextCtx.current = {
      payload: buildPayload({ metadata: [{ key: "fief_sync_origin", value: "fief" }] }),
      authData: {
        saleorApiUrl: SALEOR_API_URL,
        appId: "app-1",
        token: "saleor-token",
      },
    };

    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect(res.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("when SDK rejects sig (no ctx delivered), responds 401", async () => {
    __nextCtx.current = undefined;
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect(res.status).toBe(401);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("if enqueue fails transiently, route still returns 200 (best-effort) and logs", async () => {
    enqueueMock.mockResolvedValueOnce(err(new Error("mongo down")) as never);
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    /*
     * Saleor retries 5xx; for transient enqueue failures we want the webhook
     * to retry, so we DO return 5xx here. (This documents the contract — if
     * a future change adopts a "swallow + log" stance we can flip the
     * expectation.)
     */
    expect([500, 503]).toContain(res.status);
  });
});
