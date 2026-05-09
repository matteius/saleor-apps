/**
 * RED-phase Vitest for `HttpOwlBooksWebhookNotifier`.
 */
import * as crypto from "crypto";
import { describe, expect, it, vi } from "vitest";

import {
  HttpOwlBooksWebhookNotifier,
  NotifyError,
  type OwlBooksWebhookPayload,
  signOwlBooksPayload,
} from "./owlbooks-notifier";

const TEST_URL = "https://owlbooks.test/api/webhooks/subscription-status";
// 32+ char hex secret to mirror the Zod min-length guard on the env var.
const TEST_SECRET = "x".repeat(64);

function buildPayload(overrides: Partial<OwlBooksWebhookPayload> = {}): OwlBooksWebhookPayload {
  return {
    type: "subscription.created",
    stripeSubscriptionId: "sub_T12_abc",
    stripeCustomerId: "cus_T12_abc",
    fiefUserId: "fief_user_T12",
    stripeEventCreatedAt: 1_700_000_123,
    status: "ACTIVE",
    stripePriceId: "price_T12_abc",
    currentPeriodStart: "2026-05-09T00:00:00.000Z",
    currentPeriodEnd: "2026-06-09T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe("signOwlBooksPayload", () => {
  it("computes a deterministic hex HMAC-SHA256 over the raw body", () => {
    const body = JSON.stringify({ a: 1 });
    const secret = "secret_value";

    const expected = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

    expect(signOwlBooksPayload(body, secret)).toBe(expected);
  });
});

describe("HttpOwlBooksWebhookNotifier", () => {
  it("POSTs the payload as JSON with HMAC-SHA256 hex signature in the X-OwlBooks-Webhook-Signature header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const payload = buildPayload();
    const result = await notifier.notify(payload);

    expect(result.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchMock.mock.calls[0]!;

    expect(calledUrl).toBe(TEST_URL);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;

    expect(headers["Content-Type"]).toBe("application/json");

    const body = init.body as string;

    expect(body).toBe(JSON.stringify(payload));

    const expectedSig = signOwlBooksPayload(body, TEST_SECRET);

    expect(headers["X-OwlBooks-Webhook-Signature"]).toBe(expectedSig);
    // 64 hex chars = SHA256 digest length
    expect(headers["X-OwlBooks-Webhook-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // signal should be set so the timeout aborts a hung request
    expect(init.signal).toBeDefined();
  });

  it("returns Err(ConfigurationMissingError) when URL is missing", async () => {
    const fetchMock = vi.fn();
    const notifier = new HttpOwlBooksWebhookNotifier({
      url: undefined,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotifyError.ConfigurationMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Err(ConfigurationMissingError) when secret is missing", async () => {
    const fetchMock = vi.fn();
    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: undefined,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotifyError.ConfigurationMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Err(NonSuccessResponseError) on non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload());

    expect(result.isErr()).toBe(true);
    const err = result._unsafeUnwrapErr();

    expect(err).toBeInstanceOf(NotifyError.NonSuccessResponseError);
    expect((err as InstanceType<typeof NotifyError.NonSuccessResponseError>).message).toContain(
      "500",
    );
  });

  it("returns Err(TransportError) when fetch rejects (network failure or timeout)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotifyError.TransportError);
  });

  it("uses the configured timeoutMs to abort hung requests", async () => {
    /*
     * Resolve only after `signal.aborted` flips — simulates a slow upstream
     * the AbortController should kill via the timeout.
     */
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;

      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      timeoutMs: 10,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotifyError.TransportError);
  });

  it("T31 Layer B — parses { ok: true, action: 'duplicate' } body to {processed: 'duplicate'}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, action: "duplicate" }), { status: 200 }),
      );

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload({ type: "invoice.paid" }));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ processed: "duplicate" });
  });

  it("T31 Layer B — { ok: true, action: 'updated' } body resolves to {processed: 'new'}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, action: "updated" }), { status: 200 }),
      );

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload({ type: "invoice.paid" }));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ processed: "new" });
  });

  it("T31 Layer B — empty 200 body still resolves Ok({processed: 'new'}) for non-T28 receivers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await notifier.notify(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ processed: "new" });
  });

  it("preserves the exact payload bytes used for signing — no double-stringify", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

    const notifier = new HttpOwlBooksWebhookNotifier({
      url: TEST_URL,
      secret: TEST_SECRET,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const payload = buildPayload({
      type: "invoice.paid",
      lastInvoiceId: "in_T12_xyz",
      lastSaleorOrderId: "T3JkZXI6MQ==",
      saleorChannelSlug: "owlbooks",
      amountCents: 4_900,
      taxCents: 0,
      currency: "usd",
      stripeChargeId: "ch_T12_xyz",
    });

    await notifier.notify(payload);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sentBody = init.body as string;
    const headers = init.headers as Record<string, string>;
    const recomputed = signOwlBooksPayload(sentBody, TEST_SECRET);

    expect(headers["X-OwlBooks-Webhook-Signature"]).toBe(recomputed);
    expect(JSON.parse(sentBody)).toStrictEqual(payload);
  });
});
