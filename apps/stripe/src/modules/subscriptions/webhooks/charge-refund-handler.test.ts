/**
 * RED→GREEN Vitest for T17 — `ChargeRefundHandler`.
 *
 * Covers the four routing decisions:
 *   - one-shot purchase refund (no subscription on invoice) → PassThrough
 *   - full subscription refund → orderVoid + OwlBooks order.voided notify
 *   - partial subscription refund → Sentry + pending-review DLQ; no void/notify
 *   - cache miss (out-of-order delivery) → failed-refund DLQ; no void/notify
 *
 * Plus error handling:
 *   - charges.retrieve failure → Err
 *
 * Plus refund-amount math:
 *   - 1000 captured + 1000 refunded → full path
 *   - 1000 captured +  600 refunded → partial path
 *
 * Mocks the Stripe SDK wrapper, GraphQL client, repo, notifier, and
 * `captureException` so no I/O is performed.
 */
import { type captureException as sentryCaptureExceptionFn } from "@sentry/nextjs";
import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { type Client } from "urql";
import { describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { BaseError } from "@/lib/errors";
import { StripeInvalidRequestError } from "@/modules/stripe/stripe-api-error";

import { type IStripeChargesApi } from "../api/stripe-charges-api";
import {
  NotifyError,
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "../notifiers/owlbooks-notifier";
import { type RefundDlqRepo } from "../repositories/refund-dlq-repo";
import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import {
  ChargeRefundHandler,
  ChargeRefundHandlerError,
  PassThroughToOneShotRefundHandlerResponse,
} from "./charge-refund-handler";
import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

/*
 * ---------------------------------------------------------------------------
 * Fixtures + helpers
 * ---------------------------------------------------------------------------
 */

const SALEOR_ORDER_ID = "T3JkZXI6MQ==";
const STRIPE_SUBSCRIPTION_ID = "sub_T17_abc";
const STRIPE_CUSTOMER_ID = "cus_T17_abc";
const STRIPE_PRICE_ID = "price_T17_growth";
const STRIPE_INVOICE_ID = "in_T17_xyz";

function buildContext(): SubscriptionWebhookContext {
  return {
    saleorApiUrl: mockedSaleorApiUrl,
    appId: "app_T17",
    stripeEnv: "TEST",
    restrictedKey: mockedStripeRestrictedKey,
  };
}

function buildSubscriptionRecord(
  overrides: { lastSaleorOrderId?: string | null; lastInvoiceId?: string | null } = {},
): SubscriptionRecord {
  return new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId(STRIPE_SUBSCRIPTION_ID),
    stripeCustomerId: createStripeCustomerId(STRIPE_CUSTOMER_ID),
    saleorChannelSlug: createSaleorChannelSlug("default-channel"),
    saleorUserId: "saleor_user_abc",
    fiefUserId: createFiefUserId("fief_user_123"),
    stripePriceId: createStripePriceId(STRIPE_PRICE_ID),
    status: "active",
    currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    lastInvoiceId: overrides.lastInvoiceId ?? STRIPE_INVOICE_ID,
    lastSaleorOrderId:
      overrides.lastSaleorOrderId === undefined ? SALEOR_ORDER_ID : overrides.lastSaleorOrderId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
}

function buildChargeRefundedEvent(args: {
  chargeId?: string;
  amountCaptured: number;
  amountRefunded: number;
  currency?: string;
}): Stripe.ChargeRefundedEvent {
  return {
    id: "evt_charge_refunded",
    object: "event",
    api_version: "2024-06-20",
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "charge.refunded",
    data: {
      object: {
        id: args.chargeId ?? "ch_T17_full",
        object: "charge",
        amount_captured: args.amountCaptured,
        amount_refunded: args.amountRefunded,
        currency: args.currency ?? "usd",
        invoice: STRIPE_INVOICE_ID,
        refunded: args.amountRefunded >= args.amountCaptured,
        refunds: { object: "list", data: [], has_more: false, url: "" },
      },
    },
  } as unknown as Stripe.ChargeRefundedEvent;
}

interface Harness {
  handler: ChargeRefundHandler;
  stripeChargesApi: { retrieveChargeWithInvoice: ReturnType<typeof vi.fn> };
  subscriptionRepo: {
    upsert: ReturnType<typeof vi.fn>;
    getBySubscriptionId: ReturnType<typeof vi.fn>;
    getByCustomerId: ReturnType<typeof vi.fn>;
    getByFiefUserId: ReturnType<typeof vi.fn>;
  };
  refundDlqRepo: {
    recordFailedRefund: ReturnType<typeof vi.fn>;
    recordPendingReview: ReturnType<typeof vi.fn>;
  };
  notifier: { notify: ReturnType<typeof vi.fn> };
  graphqlClient: { mutation: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  captureException: ReturnType<typeof vi.fn>;
}

type BaseErrorInstance = InstanceType<typeof BaseError>;

function buildHarness(
  opts: {
    expandedChargeOverride?: unknown;
    expandedChargeError?: unknown;
    cacheRecord?: SubscriptionRecord | null;
    cacheError?: BaseErrorInstance;
    orderVoidGraphqlResponse?: unknown;
    orderVoidGraphqlError?: unknown;
    notifierOverride?: OwlBooksWebhookNotifier;
    dlqFailedError?: BaseErrorInstance;
    dlqPendingError?: BaseErrorInstance;
  } = {},
): Harness {
  const expandedDefault = {
    id: "ch_T17_full",
    amount_captured: 1000,
    amount_refunded: 1000,
    currency: "usd",
    invoice: { id: STRIPE_INVOICE_ID, subscription: STRIPE_SUBSCRIPTION_ID },
  };

  const stripeChargesApi: IStripeChargesApi = {
    retrieveChargeWithInvoice: vi
      .fn()
      .mockResolvedValue(
        opts.expandedChargeError
          ? err(opts.expandedChargeError)
          : ok(opts.expandedChargeOverride ?? expandedDefault),
      ),
  };

  const subscriptionRepo: SubscriptionRepo = {
    upsert: vi.fn(),
    getBySubscriptionId: vi
      .fn()
      .mockResolvedValue(
        opts.cacheError
          ? err(opts.cacheError)
          : ok(opts.cacheRecord === undefined ? buildSubscriptionRecord() : opts.cacheRecord),
      ),
    getByCustomerId: vi.fn(),
    getByFiefUserId: vi.fn(),
  };

  const refundDlqRepo: RefundDlqRepo = {
    recordFailedRefund: vi
      .fn()
      .mockResolvedValue(opts.dlqFailedError ? err(opts.dlqFailedError) : ok(null)),
    recordPendingReview: vi
      .fn()
      .mockResolvedValue(opts.dlqPendingError ? err(opts.dlqPendingError) : ok(null)),
  };

  const notifier: OwlBooksWebhookNotifier = opts.notifierOverride ?? {
    notify: vi.fn().mockResolvedValue(ok(undefined)),
  };

  const graphqlMutation = vi.fn().mockReturnValue({
    toPromise: () =>
      Promise.resolve(
        opts.orderVoidGraphqlError
          ? { error: opts.orderVoidGraphqlError, data: undefined }
          : opts.orderVoidGraphqlResponse ?? {
              data: { orderVoid: { order: { id: SALEOR_ORDER_ID }, errors: [] } },
            },
      ),
  });

  const graphqlClient = {
    mutation: graphqlMutation,
    query: vi.fn(),
  };

  const captureExceptionMock = vi.fn();

  const handler = new ChargeRefundHandler({
    stripeChargesApi,
    subscriptionRepo,
    refundDlqRepo,
    notifier,
    graphqlClient: graphqlClient as unknown as Pick<Client, "mutation" | "query">,
    captureException: captureExceptionMock as unknown as typeof sentryCaptureExceptionFn,
  });

  return {
    handler,
    stripeChargesApi: stripeChargesApi as unknown as Harness["stripeChargesApi"],
    subscriptionRepo: subscriptionRepo as unknown as Harness["subscriptionRepo"],
    refundDlqRepo: refundDlqRepo as unknown as Harness["refundDlqRepo"],
    notifier: notifier as unknown as Harness["notifier"],
    graphqlClient: graphqlClient as unknown as Harness["graphqlClient"],
    captureException: captureExceptionMock,
  };
}

/*
 * ---------------------------------------------------------------------------
 * One-shot pass-through (no subscription on invoice)
 * ---------------------------------------------------------------------------
 */

describe("ChargeRefundHandler — pass-through path", () => {
  it("returns PassThrough sentinel when expanded invoice has no subscription", async () => {
    const h = buildHarness({
      expandedChargeOverride: {
        id: "ch_oneshot",
        amount_captured: 500,
        amount_refunded: 500,
        currency: "usd",
        invoice: { id: "in_oneshot", subscription: null },
      },
    });

    const event = buildChargeRefundedEvent({
      chargeId: "ch_oneshot",
      amountCaptured: 500,
      amountRefunded: 500,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    expect(value).toBeInstanceOf(PassThroughToOneShotRefundHandlerResponse);
    expect((value as PassThroughToOneShotRefundHandlerResponse).stripeChargeId).toBe("ch_oneshot");

    expect(h.stripeChargesApi.retrieveChargeWithInvoice).toHaveBeenCalledTimes(1);
    expect(h.subscriptionRepo.getBySubscriptionId).not.toHaveBeenCalled();
    expect(h.graphqlClient.mutation).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(h.refundDlqRepo.recordFailedRefund).not.toHaveBeenCalled();
    expect(h.refundDlqRepo.recordPendingReview).not.toHaveBeenCalled();
  });

  it("returns PassThrough sentinel when invoice is null entirely", async () => {
    const h = buildHarness({
      expandedChargeOverride: {
        id: "ch_no_invoice",
        amount_captured: 200,
        amount_refunded: 200,
        currency: "usd",
        invoice: null,
      },
    });

    const event = buildChargeRefundedEvent({
      chargeId: "ch_no_invoice",
      amountCaptured: 200,
      amountRefunded: 200,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeInstanceOf(PassThroughToOneShotRefundHandlerResponse);
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Full refund — auto-void + notify
 * ---------------------------------------------------------------------------
 */

describe("ChargeRefundHandler — full subscription refund", () => {
  it("calls Saleor orderVoid once and fires OwlBooks order.voided notifier", async () => {
    const h = buildHarness();

    const event = buildChargeRefundedEvent({
      chargeId: "ch_T17_full",
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    expect(value).toMatchObject({
      _tag: "ChargeRefundHandlerSuccess",
      stripeChargeId: "ch_T17_full",
      voidedSaleorOrderId: SALEOR_ORDER_ID,
    });

    expect(h.subscriptionRepo.getBySubscriptionId).toHaveBeenCalledTimes(1);
    expect(h.graphqlClient.mutation).toHaveBeenCalledTimes(1);

    /* Confirm the orderVoid mutation was called with the right id variable. */
    const mutCallArgs = h.graphqlClient.mutation.mock.calls[0];

    expect(mutCallArgs[1]).toStrictEqual({ id: SALEOR_ORDER_ID });

    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
    const payload = h.notifier.notify.mock.calls[0][0] as OwlBooksWebhookPayload;

    expect(payload.type).toBe("order.voided");
    expect(payload.lastSaleorOrderId).toBe(SALEOR_ORDER_ID);
    expect(payload.lastInvoiceId).toBe(STRIPE_INVOICE_ID);
    expect(payload.stripeChargeId).toBe("ch_T17_full");
    expect(payload.voidedAt).toStrictEqual(expect.any(String));
    /* No DLQ writes on the happy path. */
    expect(h.refundDlqRepo.recordFailedRefund).not.toHaveBeenCalled();
    expect(h.refundDlqRepo.recordPendingReview).not.toHaveBeenCalled();
    /* No Sentry on the happy path. */
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it("returns Err when Saleor orderVoid mutation returns errors[]", async () => {
    const h = buildHarness({
      orderVoidGraphqlResponse: {
        data: {
          orderVoid: {
            order: null,
            errors: [{ field: "id", message: "Cannot void", code: "CANNOT_CANCEL_ORDER" }],
          },
        },
      },
    });

    const event = buildChargeRefundedEvent({
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChargeRefundHandlerError.OrderVoidFailedError);
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("returns Err when notifier fails (so Stripe will retry)", async () => {
    const h = buildHarness({
      notifierOverride: {
        notify: vi.fn().mockResolvedValue(err(new NotifyError.TransportError("simulated"))),
      },
    });

    const event = buildChargeRefundedEvent({
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChargeRefundHandlerError.NotifierFailedError);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Partial refund — Sentry + DLQ; no void/notify
 * ---------------------------------------------------------------------------
 */

describe("ChargeRefundHandler — partial subscription refund", () => {
  it("does NOT call orderVoid; fires captureException + writes pending-review DLQ", async () => {
    const h = buildHarness({
      expandedChargeOverride: {
        id: "ch_partial",
        amount_captured: 1000,
        amount_refunded: 600,
        currency: "usd",
        invoice: { id: STRIPE_INVOICE_ID, subscription: STRIPE_SUBSCRIPTION_ID },
      },
    });

    const event = buildChargeRefundedEvent({
      chargeId: "ch_partial",
      amountCaptured: 1000,
      amountRefunded: 600,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    expect(value).toMatchObject({
      _tag: "ChargeRefundHandlerSuccess",
      stripeChargeId: "ch_partial",
      voidedSaleorOrderId: null,
    });

    expect(h.graphqlClient.mutation).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalledTimes(1);

    expect(h.refundDlqRepo.recordPendingReview).toHaveBeenCalledTimes(1);
    const dlqArgs = h.refundDlqRepo.recordPendingReview.mock.calls[0];

    expect(dlqArgs[1]).toMatchObject({
      stripeChargeId: "ch_partial",
      invoiceId: STRIPE_INVOICE_ID,
      saleorOrderId: SALEOR_ORDER_ID,
      refundAmountCents: 600,
      capturedAmountCents: 1000,
      currency: "usd",
    });
    expect(h.refundDlqRepo.recordFailedRefund).not.toHaveBeenCalled();
  });

  it("returns Err when DLQ write itself fails", async () => {
    const h = buildHarness({
      expandedChargeOverride: {
        id: "ch_partial2",
        amount_captured: 1000,
        amount_refunded: 600,
        currency: "usd",
        invoice: { id: STRIPE_INVOICE_ID, subscription: STRIPE_SUBSCRIPTION_ID },
      },
      dlqPendingError: new BaseError("ddb down"),
    });

    const event = buildChargeRefundedEvent({
      chargeId: "ch_partial2",
      amountCaptured: 1000,
      amountRefunded: 600,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isErr()).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Cache miss — failed-refund DLQ
 * ---------------------------------------------------------------------------
 */

describe("ChargeRefundHandler — cache miss / out-of-order delivery", () => {
  it("writes failed-refund DLQ entry and skips void+notify when no SubscriptionRecord cache hit", async () => {
    const h = buildHarness({ cacheRecord: null });

    const event = buildChargeRefundedEvent({
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      _tag: "ChargeRefundHandlerSuccess",
      voidedSaleorOrderId: null,
    });

    expect(h.refundDlqRepo.recordFailedRefund).toHaveBeenCalledTimes(1);
    expect(h.graphqlClient.mutation).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("writes failed-refund DLQ entry when cache record exists but lastSaleorOrderId is null", async () => {
    const h = buildHarness({ cacheRecord: buildSubscriptionRecord({ lastSaleorOrderId: null }) });

    const event = buildChargeRefundedEvent({
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isOk()).toBe(true);
    expect(h.refundDlqRepo.recordFailedRefund).toHaveBeenCalledTimes(1);
    expect(h.graphqlClient.mutation).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });
});

/*
 * ---------------------------------------------------------------------------
 * charges.retrieve failure
 * ---------------------------------------------------------------------------
 */

describe("ChargeRefundHandler — charges.retrieve failure", () => {
  it("returns Err with ChargeRetrieveFailedError when Stripe API errors", async () => {
    const h = buildHarness({
      expandedChargeError: new StripeInvalidRequestError("boom"),
    });

    const event = buildChargeRefundedEvent({
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      ChargeRefundHandlerError.ChargeRetrieveFailedError,
    );
    expect(h.subscriptionRepo.getBySubscriptionId).not.toHaveBeenCalled();
  });

  it("returns Err when subscription cache read fails", async () => {
    const h = buildHarness({
      cacheError: new BaseError("ddb timeout"),
    });

    const event = buildChargeRefundedEvent({
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    const result = await h.handler.handle(event, buildContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChargeRefundHandlerError.CacheReadFailedError);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Refund-amount math gate
 * ---------------------------------------------------------------------------
 */

describe("ChargeRefundHandler — refund-amount math", () => {
  it("1000 captured + 1000 refunded → full path (orderVoid called once)", async () => {
    const h = buildHarness({
      expandedChargeOverride: {
        id: "ch_full_eq",
        amount_captured: 1000,
        amount_refunded: 1000,
        currency: "usd",
        invoice: { id: STRIPE_INVOICE_ID, subscription: STRIPE_SUBSCRIPTION_ID },
      },
    });

    const event = buildChargeRefundedEvent({
      chargeId: "ch_full_eq",
      amountCaptured: 1000,
      amountRefunded: 1000,
    });

    await h.handler.handle(event, buildContext());

    expect(h.graphqlClient.mutation).toHaveBeenCalledTimes(1);
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
    expect(h.refundDlqRepo.recordPendingReview).not.toHaveBeenCalled();
  });

  it("1000 captured + 600 refunded → partial path (no void)", async () => {
    const h = buildHarness({
      expandedChargeOverride: {
        id: "ch_partial_lt",
        amount_captured: 1000,
        amount_refunded: 600,
        currency: "usd",
        invoice: { id: STRIPE_INVOICE_ID, subscription: STRIPE_SUBSCRIPTION_ID },
      },
    });

    const event = buildChargeRefundedEvent({
      chargeId: "ch_partial_lt",
      amountCaptured: 1000,
      amountRefunded: 600,
    });

    await h.handler.handle(event, buildContext());

    expect(h.graphqlClient.mutation).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(h.refundDlqRepo.recordPendingReview).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
