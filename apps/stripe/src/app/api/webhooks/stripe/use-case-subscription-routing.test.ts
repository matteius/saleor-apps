/**
 * RED-phase tests for T18 — `StripeWebhookUseCase.processEvent` routing
 * decisions for subscription-origin events.
 *
 * Verifies:
 *   1. `event.data.object.object === "subscription"` → SubscriptionWebhookUseCase.execute
 *   2. `event.data.object.object === "invoice"`      → SubscriptionWebhookUseCase.execute
 *   3. `event.data.object.object === "customer"`     → SubscriptionWebhookUseCase.execute
 *   4. `payment_intent` WITH `saleor_transaction_id` metadata → existing
 *       one-shot StripePaymentIntentHandler path (NOT subscription).
 *   5. `payment_intent` WITHOUT metadata, WITH `invoice` field → NoOp
 *       (subscription cycle-1 PI, deferred to invoice.paid).
 *   6. `payment_intent` orphan (no metadata, no `invoice` field) → existing
 *       ObjectMetadataMissingError → ObjectCreatedOutsideOfSaleorResponse.
 *   7. `charge.refunded` (object: `charge`) WITH `saleor_transaction_id`
 *       metadata → existing one-shot StripeRefundHandler path.
 *   8. `charge.refunded` (object: `charge`) WITHOUT metadata → subscription
 *       path (T17 ChargeRefundHandler).
 */
import { type APL } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockAdyenWebhookUrl, mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { getMockedPaymentIntentSucceededEvent } from "@/__tests__/mocks/stripe-events/mocked-payment-intent-succeeded";
import { StripeProblemReporter } from "@/modules/app-problems";
import { type ITransactionEventReporter } from "@/modules/saleor/transaction-event-reporter";
import { StripeWebhookManager } from "@/modules/stripe/stripe-webhook-manager";
import {
  type IStripeEventVerify,
  type IStripePaymentIntentsApiFactory,
} from "@/modules/stripe/types";

import { StripeWebhookUseCase } from "./use-case";
import { WebhookParams } from "./webhook-params";

vi.mock("@saleor/app-problems", () => ({
  AppProblemsReporter: class {
    reportProblem() {
      return Promise.resolve({ isErr: () => false });
    }
    clearProblems() {
      return Promise.resolve({ isErr: () => false });
    }
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const rawEventBody = JSON.stringify({ id: 1 });

const mockApl = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
} satisfies APL;

const eventVerify = {
  verifyEvent: vi.fn(),
} satisfies IStripeEventVerify;

const webhookParams = WebhookParams.createFromWebhookUrl(mockAdyenWebhookUrl)._unsafeUnwrap();

const mockEventReporter = {
  reportTransactionEvent: vi.fn(),
} satisfies ITransactionEventReporter;

const mockTransactionRecorder = new MockedTransactionRecorder();

const stripePaymentIntentsApiFactory = {
  create: () => mockedStripePaymentIntentsApi,
} satisfies IStripePaymentIntentsApiFactory;

/**
 * Mocked SubscriptionWebhookUseCase — we only care that it's CALLED for the
 * right events; its internal dispatch is tested in
 * `subscription-webhook-use-case.test.ts`.
 */
function buildMockSubscriptionUseCase() {
  return {
    execute: vi.fn().mockResolvedValue(
      ok({
        _tag: "SubscriptionWebhookNoOpResponse" as const,
        handledEventType: "invoice.paid" as Stripe.Event["type"],
        reason: "informational" as const,
      }),
    ),
  };
}

let instance: StripeWebhookUseCase;
let mockSubscriptionUseCase: ReturnType<typeof buildMockSubscriptionUseCase>;

beforeEach(() => {
  mockApl.get.mockImplementation(async () => mockAuthData);
  mockTransactionRecorder.reset();
  mockSubscriptionUseCase = buildMockSubscriptionUseCase();

  instance = new StripeWebhookUseCase({
    apl: mockApl,
    appConfigRepo: mockedAppConfigRepo,
    webhookEventVerifyFactory: () => eventVerify,
    transactionEventReporterFactory() {
      return mockEventReporter;
    },
    problemReporterFactory: () => new StripeProblemReporter({} as never),
    transactionRecorder: mockTransactionRecorder,
    webhookManager: new StripeWebhookManager(),
    stripePaymentIntentsApiFactory,
    subscriptionWebhookUseCase: mockSubscriptionUseCase,
  });
});

describe("StripeWebhookUseCase - T18 subscription routing", () => {
  it("routes `subscription` object events to SubscriptionWebhookUseCase", async () => {
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          object: "subscription",
          id: "sub_test_T18_routing",
        },
      },
    } as unknown as Stripe.CustomerSubscriptionUpdatedEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(result.isOk()).toBe(true);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        saleorApiUrl: webhookParams.saleorApiUrl,
        appId: mockAuthData.appId,
      }),
    );
    expect(mockEventReporter.reportTransactionEvent).not.toHaveBeenCalled();
  });

  it("routes `invoice` object events to SubscriptionWebhookUseCase", async () => {
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          object: "invoice",
          id: "in_test_T18",
        },
      },
    } as unknown as Stripe.InvoicePaidEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(result.isOk()).toBe(true);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledWith(event, expect.anything());
  });

  it("routes `customer` object events to SubscriptionWebhookUseCase", async () => {
    const event = {
      type: "customer.created",
      data: {
        object: {
          object: "customer",
          id: "cus_test_T18",
        },
      },
    } as unknown as Stripe.CustomerCreatedEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(result.isOk()).toBe(true);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps payment_intent WITH `saleor_transaction_id` metadata on the existing one-shot path", async () => {
    const event = getMockedPaymentIntentSucceededEvent();

    /* Default fixture already has `saleor_transaction_id` metadata. */
    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(mockSubscriptionUseCase.execute).not.toHaveBeenCalled();
    /*
     * StripePaymentIntentHandler is invoked synchronously by the existing
     * path; downstream effects (transaction recorder lookup) confirm we
     * routed to the one-shot path. We don't assert the final response here
     * because the one-shot success path requires a recorded transaction —
     * the routing assertion (`subscriptionUseCase NOT called`) is sufficient.
     */
  });

  it("returns NoOp for cycle-1 subscription PI (no metadata, with `invoice` field)", async () => {
    const event = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          object: "payment_intent",
          id: mockedStripePaymentIntentId.toString(),
          metadata: {},
          /* The `invoice` field is the subscription cycle-1 PI marker. */
          invoice: "in_test_subscription_cycle1",
        },
      },
    } as unknown as Stripe.PaymentIntentSucceededEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    /*
     * The cycle-1 PI is a NoOp — Stripe should see 200 because the
     * corresponding `invoice.paid` mints the order. The SubscriptionUseCase
     * is NOT called for this — the no-op happens in the dispatcher itself.
     */
    expect(result.isOk()).toBe(true);
    expect(mockSubscriptionUseCase.execute).not.toHaveBeenCalled();
    expect(mockEventReporter.reportTransactionEvent).not.toHaveBeenCalled();
  });

  it("falls through to existing ObjectMetadataMissingError for orphan payment_intent (no metadata, no invoice)", async () => {
    const event = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          object: "payment_intent",
          id: mockedStripePaymentIntentId.toString(),
          metadata: {},
        },
      },
    } as unknown as Stripe.PaymentIntentSucceededEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(result._unsafeUnwrapErr()).toMatchInlineSnapshot(`
      ObjectCreatedOutsideOfSaleorResponse {
        "message": "Object created outside of Saleor is not processable",
        "statusCode": 400,
      }
    `);
    expect(mockSubscriptionUseCase.execute).not.toHaveBeenCalled();
  });

  it("keeps charge.refunded (object: charge) WITH `saleor_transaction_id` metadata on existing refund path", async () => {
    const event = {
      type: "charge.refunded",
      data: {
        object: {
          object: "charge",
          id: "ch_test_T18_oneshot",
          metadata: {
            saleor_transaction_id: mockedSaleorTransactionId as string,
          },
        },
      },
    } as unknown as Stripe.ChargeRefundedEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(mockSubscriptionUseCase.execute).not.toHaveBeenCalled();
  });

  it("routes charge.refunded WITHOUT metadata to SubscriptionWebhookUseCase", async () => {
    const event = {
      type: "charge.refunded",
      data: {
        object: {
          object: "charge",
          id: "ch_test_T18_subscription",
          metadata: {},
        },
      },
    } as unknown as Stripe.ChargeRefundedEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(result.isOk()).toBe(true);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledWith(event, expect.anything());
  });

  it("routes legacy refund (object: refund) WITHOUT metadata to SubscriptionWebhookUseCase", async () => {
    const event = {
      type: "charge.refund.updated",
      data: {
        object: {
          object: "refund",
          id: "re_test_T18_subscription",
          payment_intent: mockedStripePaymentIntentId.toString(),
          metadata: {},
        },
      },
    } as unknown as Stripe.ChargeRefundUpdatedEvent;

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    const result = await instance.execute({
      rawBody: rawEventBody,
      signatureHeader: "test-signature",
      webhookParams,
    });

    expect(result.isOk()).toBe(true);
    expect(mockSubscriptionUseCase.execute).toHaveBeenCalledTimes(1);
  });
});
