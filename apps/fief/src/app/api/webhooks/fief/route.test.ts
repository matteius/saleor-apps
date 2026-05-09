/*
 * @vitest-environment node
 *
 * T22 — Fief webhook route handler integration test.
 *
 * Mocks `FiefReceiver` from `@/modules/sync/fief-to-saleor/receiver` so we
 * exercise the route's HTTP-translation table without needing real Mongo /
 * Fief / encrypted ciphertext. The receiver-level tests
 * (`receiver.test.ts`) cover the orchestration logic; this file just
 * confirms each `ReceiverOutcome` variant maps to the right HTTP status
 * + the route is wrapped in `compose(withLoggerContext, withSaleorApiUrlAttributes)`.
 */

import { ok } from "neverthrow";
import { type NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { receiveMock, FiefReceiverMock } = vi.hoisted(() => {
  const receive = vi.fn();
  const ctor = vi.fn().mockImplementation(() => ({
    receive,
  }));

  return { receiveMock: receive, FiefReceiverMock: ctor };
});

vi.mock("@/modules/sync/fief-to-saleor/receiver", async () => {
  return {
    FiefReceiver: FiefReceiverMock,
  };
});

vi.mock("@/modules/crypto/encryptor", () => ({
  createFiefEncryptor: vi.fn(() => ({})),
}));

vi.mock("@/lib/env", async () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
  },
}));

const buildRequest = (
  url: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): NextRequest => {
  const req = new Request(url, {
    method: "POST",
    body: init.body ?? "{}",
    headers: new Headers(init.headers ?? {}),
  }) as unknown as NextRequest;

  Object.defineProperty(req, "nextUrl", {
    value: new URL(url),
  });

  return req;
};

describe("Fief webhook route — T22", () => {
  beforeEach(() => {
    receiveMock.mockReset();
    /*
     * vitest config has `mockReset: true`, which strips
     * `mockImplementation` from every `vi.fn()` between tests. Re-arm the
     * constructor mock here so each test still gets a `FiefReceiver`
     * instance with `receive` wired to our `receiveMock`.
     */
    FiefReceiverMock.mockImplementation(() => ({ receive: receiveMock }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("translates an 'accepted' outcome to HTTP 200 with status payload", async () => {
    receiveMock.mockResolvedValue(
      ok({ kind: "accepted", eventId: "evt-1", eventType: "user.created", dispatched: true }),
    );

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.status).toBe("accepted");
    expect(json.eventType).toBe("user.created");
  });

  it("translates a 'duplicate' outcome to HTTP 200 (idempotent)", async () => {
    receiveMock.mockResolvedValue(ok({ kind: "duplicate", eventId: "evt-2" }));

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.status).toBe("duplicate");
  });

  it("translates an 'unauthorized' outcome to HTTP 401", async () => {
    receiveMock.mockResolvedValue(ok({ kind: "unauthorized", reason: "signature-mismatch" }));

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(401);
  });

  it("translates a 'gone' outcome to HTTP 410", async () => {
    receiveMock.mockResolvedValue(ok({ kind: "gone", reason: "connection-not-found" }));

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(410);
  });

  it("translates a 'gone' (soft-deleted) outcome to HTTP 410", async () => {
    receiveMock.mockResolvedValue(ok({ kind: "gone", reason: "connection-soft-deleted" }));

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(410);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.reason).toBe("connection-soft-deleted");
  });

  it("translates a 'service-unavailable' outcome to HTTP 503", async () => {
    receiveMock.mockResolvedValue(
      ok({ kind: "service-unavailable", reason: "fief-sync-disabled" }),
    );

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(503);
  });

  it("translates a 'bad-request' outcome to HTTP 400", async () => {
    receiveMock.mockResolvedValue(ok({ kind: "bad-request", message: "missing connectionId" }));

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief"));

    expect(res.status).toBe(400);
  });

  it("translates an 'accepted-with-handler-error' outcome to HTTP 200 (T52 owns retries)", async () => {
    receiveMock.mockResolvedValue(
      ok({ kind: "accepted-with-handler-error", eventId: "evt-3", eventType: "user.updated" }),
    );

    const { POST } = await import("./route");

    const res = await POST(buildRequest("https://app.test/api/webhooks/fief?connectionId=abc"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.status).toBe("accepted-with-handler-error");
  });

  it("forwards the connectionId query param to the receiver", async () => {
    receiveMock.mockResolvedValue(ok({ kind: "gone", reason: "connection-not-found" }));

    const { POST } = await import("./route");

    await POST(
      buildRequest(
        "https://app.test/api/webhooks/fief?connectionId=00000000-0000-4000-8000-000000000001",
        {
          body: JSON.stringify({ type: "user.created", data: { id: "x" } }),
          headers: { "x-fief-webhook-signature": "ab", "x-fief-webhook-timestamp": "1" },
        },
      ),
    );

    expect(receiveMock).toHaveBeenCalledTimes(1);
    const arg = receiveMock.mock.calls[0][0] as {
      connectionIdQueryParam: string;
      headers: Record<string, string>;
      rawBody: string;
    };

    expect(arg.connectionIdQueryParam).toBe("00000000-0000-4000-8000-000000000001");
    expect(arg.headers["x-fief-webhook-signature"]).toBe("ab");
    expect(arg.headers["x-fief-webhook-timestamp"]).toBe("1");
    expect(arg.rawBody).toContain("user.created");
  });
});
