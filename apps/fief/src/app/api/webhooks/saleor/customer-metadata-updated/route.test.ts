/*
 * @vitest-environment node
 *
 * T28 — Saleor `CUSTOMER_METADATA_UPDATED` webhook route handler test.
 *
 * Mirrors T26's route test exactly; the route is "kill switch + origin-marker
 * + enqueue" and the use case (covered separately in
 * `customer-metadata-updated.use-case.test.ts`) is what implements the
 * reverse-sync gate. We only assert the route's branching here:
 *
 *   - kill switch (T54) → 503 (no enqueue)
 *   - origin marker `"fief"` (T13) → 200 + skipped (no enqueue)
 *   - happy path (clean payload) → 200 + enqueued with eventType
 *     `saleor.customer_metadata_updated`
 *   - bad sig: simulated by SDK adapter rejecting before our handler runs
 *     (the SDK formats a 401 itself); we stub the handler factory to mimic
 *     that path.
 *   - transient enqueue failure → 5xx so Saleor retries.
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
        eventType: "saleor.customer_metadata_updated",
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
    getWebhookManifest: () => ({ name: "Customer Metadata Updated" }),
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
  const url = "https://app.test/api/webhooks/saleor/customer-metadata-updated";
  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify({ webhook: "saleor", event: "CUSTOMER_METADATA_UPDATED" }),
    headers: { "saleor-api-url": SALEOR_API_URL },
  });

  Object.defineProperty(req, "nextUrl", { value: new URL(url) });

  return req;
};

describe("Saleor CUSTOMER_METADATA_UPDATED route — T28", () => {
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

  it("happy path: enqueues the event with saleor.customer_metadata_updated and returns 200", async () => {
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    const args = (enqueueMock.mock.calls as unknown as unknown[][])[0]?.[0] as {
      eventType: string;
      saleorApiUrl: string;
    };

    expect(args.eventType).toBe("saleor.customer_metadata_updated");
    expect(args.saleorApiUrl).toBe(SALEOR_API_URL);
  });

  it("kill switch returns 503 and does NOT enqueue", async () => {
    isSaleorToFiefDisabledMock.mockReturnValue(true);
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect(res.status).toBe(503);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("origin marker 'fief' is filtered before enqueue (200 skipped) — loop guard", async () => {
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

  it("if enqueue fails transiently, route returns 5xx so Saleor retries", async () => {
    enqueueMock.mockResolvedValueOnce(err(new Error("mongo down")) as never);
    const { POST } = await import("./route");

    const res = await POST(buildRequest() as never);

    expect([500, 503]).toContain(res.status);
  });
});
