/**
 * RED-phase Vitest for T12's `SubscriptionWebhookUseCase` dispatcher.
 *
 * These tests exercise the *routing* surface only — handler implementations
 * land in T13–T17. Each handler is mocked via `vi.fn()` returning a Result
 * carrying a deterministic `_tag` so the tests can assert "this method was
 * called with this event."
 */
import type { APL } from "@saleor/app-sdk/APL";
import { ok, type Result } from "neverthrow";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";

import { type IStripeSubscriptionsApiFactory } from "../api/stripe-subscriptions-api-factory";
import { type OwlBooksWebhookNotifier } from "../notifiers/owlbooks-notifier";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import { type IPriceVariantMapRepo } from "../saleor-bridge/price-variant-map";
import { type ISaleorCustomerResolver } from "../saleor-bridge/saleor-customer-resolver";
import {
  type ChargeRefundHandlerError,
  type ChargeRefundHandlerSuccess,
  type IChargeRefundHandler,
} from "./charge-refund-handler";
import {
  type CustomerSubscriptionHandlerError,
  type CustomerSubscriptionHandlerSuccess,
  type ICustomerSubscriptionHandler,
} from "./customer-subscription-handler";
import {
  type IInvoiceHandler,
  type InvoiceHandlerError,
  type InvoiceHandlerSuccess,
} from "./invoice-handler";
import {
  isSubscriptionWebhookEventType,
  type SubscriptionWebhookContext,
  SubscriptionWebhookNoOpResponse,
  SubscriptionWebhookUseCase,
} from "./subscription-webhook-use-case";

/*
 * ---------------------------------------------------------------------------
 * Test harness
 * ---------------------------------------------------------------------------
 */

type CustomerSubscriptionResult = Result<
  CustomerSubscriptionHandlerSuccess,
  CustomerSubscriptionHandlerError
>;
type InvoiceResult = Result<InvoiceHandlerSuccess, InvoiceHandlerError>;
type ChargeRefundResult = Result<ChargeRefundHandlerSuccess, ChargeRefundHandlerError>;

function buildContext(): SubscriptionWebhookContext {
  return {
    saleorApiUrl: mockedSaleorApiUrl,
    appId: "app_test_T12",
    stripeEnv: "TEST",
    restrictedKey: mockedStripeRestrictedKey,
  };
}

function buildEvent<T extends Stripe.Event["type"]>(type: T): Stripe.Event {
  return {
    id: `evt_${type}`,
    object: "event",
    api_version: "2024-06-20",
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: { id: `obj_${type}`, object: "subscription" } },
  } as unknown as Stripe.Event;
}

type CustomerSubMock = (
  event: Stripe.Event,
  ctx: SubscriptionWebhookContext,
) => Promise<CustomerSubscriptionResult>;
type InvoiceMock = (event: Stripe.Event, ctx: SubscriptionWebhookContext) => Promise<InvoiceResult>;
type ChargeRefundMock = (
  event: Stripe.Event,
  ctx: SubscriptionWebhookContext,
) => Promise<ChargeRefundResult>;

interface Harness {
  useCase: SubscriptionWebhookUseCase;
  customerSubscriptionHandler: {
    handleCreated: ReturnType<typeof vi.fn<CustomerSubMock>>;
    handleUpdated: ReturnType<typeof vi.fn<CustomerSubMock>>;
    handleDeleted: ReturnType<typeof vi.fn<CustomerSubMock>>;
  };
  invoiceHandler: {
    handlePaid: ReturnType<typeof vi.fn<InvoiceMock>>;
    handleFailed: ReturnType<typeof vi.fn<InvoiceMock>>;
  };
  chargeRefundHandler: {
    handle: ReturnType<typeof vi.fn<ChargeRefundMock>>;
  };
  notifier: { notify: ReturnType<typeof vi.fn> };
}

function buildHarness(): Harness {
  const customerSubscriptionHandlerMock = {
    handleCreated: vi
      .fn()
      .mockResolvedValue(
        ok({ _tag: "CustomerSubscriptionHandlerSuccess", stripeSubscriptionId: "sub_T12" }),
      ),
    handleUpdated: vi
      .fn()
      .mockResolvedValue(
        ok({ _tag: "CustomerSubscriptionHandlerSuccess", stripeSubscriptionId: "sub_T12" }),
      ),
    handleDeleted: vi
      .fn()
      .mockResolvedValue(
        ok({ _tag: "CustomerSubscriptionHandlerSuccess", stripeSubscriptionId: "sub_T12" }),
      ),
  } satisfies ICustomerSubscriptionHandler;

  const invoiceHandlerMock = {
    handlePaid: vi.fn().mockResolvedValue(
      ok({
        _tag: "InvoiceHandlerSuccess",
        stripeInvoiceId: "in_T12",
        mintedSaleorOrderId: "order_T12",
      }),
    ),
    handleFailed: vi.fn().mockResolvedValue(
      ok({
        _tag: "InvoiceHandlerSuccess",
        stripeInvoiceId: "in_T12",
        mintedSaleorOrderId: null,
      }),
    ),
  } satisfies IInvoiceHandler;

  const chargeRefundHandlerMock = {
    handle: vi.fn().mockResolvedValue(
      ok({
        _tag: "ChargeRefundHandlerSuccess",
        stripeChargeId: "ch_T12",
        voidedSaleorOrderId: "order_T12",
      }),
    ),
  } satisfies IChargeRefundHandler;

  const notifierMock: OwlBooksWebhookNotifier = {
    notify: vi.fn().mockResolvedValue(ok({ processed: "new" as const })),
  };

  const subscriptionRepoMock: SubscriptionRepo = {
    upsert: vi.fn(),
    markInvoiceProcessed: vi.fn(),
    getBySubscriptionId: vi.fn(),
    getByCustomerId: vi.fn(),
    getByFiefUserId: vi.fn(),
  };

  const priceVariantMapRepoMock: IPriceVariantMapRepo = {
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };

  const customerResolverMock: ISaleorCustomerResolver = {
    resolveSaleorUser: vi.fn(),
    resolveStripeCustomer: vi.fn(),
  };

  const stripeSubscriptionsApiFactoryMock: IStripeSubscriptionsApiFactory = {
    createSubscriptionsApi: vi.fn(),
    createCustomerApi: vi.fn(),
  };

  const aplMock = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(),
    isReady: vi.fn(),
    isConfigured: vi.fn(),
  } as unknown as APL;

  const useCase = new SubscriptionWebhookUseCase({
    apl: aplMock,
    appConfigRepo: mockedAppConfigRepo as unknown as AppConfigRepo,
    subscriptionRepo: subscriptionRepoMock,
    priceVariantMapRepo: priceVariantMapRepoMock,
    customerResolver: customerResolverMock,
    stripeSubscriptionsApiFactory: stripeSubscriptionsApiFactoryMock,
    owlbooksWebhookNotifier: notifierMock,
    customerSubscriptionHandler:
      customerSubscriptionHandlerMock as unknown as ICustomerSubscriptionHandler,
    invoiceHandler: invoiceHandlerMock as unknown as IInvoiceHandler,
    chargeRefundHandler: chargeRefundHandlerMock as unknown as IChargeRefundHandler,
  });

  return {
    useCase,
    customerSubscriptionHandler:
      customerSubscriptionHandlerMock as unknown as Harness["customerSubscriptionHandler"],
    invoiceHandler: invoiceHandlerMock as unknown as Harness["invoiceHandler"],
    chargeRefundHandler: chargeRefundHandlerMock as unknown as Harness["chargeRefundHandler"],
    notifier: notifierMock as unknown as Harness["notifier"],
  };
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe("SubscriptionWebhookUseCase — dispatch", () => {
  it("routes customer.subscription.created to customerSubscriptionHandler.handleCreated", async () => {
    const h = buildHarness();
    const ctx = buildContext();
    const event = buildEvent("customer.subscription.created");

    const result = await h.useCase.execute(event, ctx);

    expect(result.isOk()).toBe(true);
    expect(h.customerSubscriptionHandler.handleCreated).toHaveBeenCalledTimes(1);
    expect(h.customerSubscriptionHandler.handleCreated).toHaveBeenCalledWith(event, ctx);
    expect(h.customerSubscriptionHandler.handleUpdated).not.toHaveBeenCalled();
    expect(h.customerSubscriptionHandler.handleDeleted).not.toHaveBeenCalled();
    expect(h.invoiceHandler.handlePaid).not.toHaveBeenCalled();
    expect(h.chargeRefundHandler.handle).not.toHaveBeenCalled();
  });

  it("routes customer.subscription.updated to customerSubscriptionHandler.handleUpdated", async () => {
    const h = buildHarness();
    const event = buildEvent("customer.subscription.updated");

    await h.useCase.execute(event, buildContext());

    expect(h.customerSubscriptionHandler.handleUpdated).toHaveBeenCalledTimes(1);
    expect(h.customerSubscriptionHandler.handleCreated).not.toHaveBeenCalled();
  });

  it("routes customer.subscription.deleted to customerSubscriptionHandler.handleDeleted", async () => {
    const h = buildHarness();
    const event = buildEvent("customer.subscription.deleted");

    await h.useCase.execute(event, buildContext());

    expect(h.customerSubscriptionHandler.handleDeleted).toHaveBeenCalledTimes(1);
  });

  it("routes invoice.paid to invoiceHandler.handlePaid", async () => {
    const h = buildHarness();
    const ctx = buildContext();
    const event = buildEvent("invoice.paid");

    const result = await h.useCase.execute(event, ctx);

    expect(result.isOk()).toBe(true);
    expect(h.invoiceHandler.handlePaid).toHaveBeenCalledTimes(1);
    expect(h.invoiceHandler.handlePaid).toHaveBeenCalledWith(event, ctx);
    expect(h.invoiceHandler.handleFailed).not.toHaveBeenCalled();
  });

  it("routes invoice.payment_failed to invoiceHandler.handleFailed", async () => {
    const h = buildHarness();
    const event = buildEvent("invoice.payment_failed");

    await h.useCase.execute(event, buildContext());

    expect(h.invoiceHandler.handleFailed).toHaveBeenCalledTimes(1);
    expect(h.invoiceHandler.handlePaid).not.toHaveBeenCalled();
  });

  it("routes charge.refunded to chargeRefundHandler.handle", async () => {
    const h = buildHarness();
    const event = buildEvent("charge.refunded");

    const result = await h.useCase.execute(event, buildContext());

    expect(result.isOk()).toBe(true);
    expect(h.chargeRefundHandler.handle).toHaveBeenCalledTimes(1);
  });

  it.each(["invoice.created", "invoice.finalized"] as const)(
    "returns Ok(NoOpResponse) for informational event %s and calls no handler",
    async (eventType) => {
      const h = buildHarness();
      const event = buildEvent(eventType);

      const result = await h.useCase.execute(event, buildContext());

      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();

      expect(value).toBeInstanceOf(SubscriptionWebhookNoOpResponse);
      expect((value as SubscriptionWebhookNoOpResponse).reason).toBe("informational");
      expect((value as SubscriptionWebhookNoOpResponse).handledEventType).toBe(eventType);

      expect(h.customerSubscriptionHandler.handleCreated).not.toHaveBeenCalled();
      expect(h.invoiceHandler.handlePaid).not.toHaveBeenCalled();
      expect(h.chargeRefundHandler.handle).not.toHaveBeenCalled();
    },
  );

  it("returns Ok(NoOpResponse) for unsupported event type and calls no handler", async () => {
    const h = buildHarness();
    /*
     * `customer.created` is a real Stripe event we do not subscribe to; safe
     * unsupported example.
     */
    const event = buildEvent("customer.created");

    const result = await h.useCase.execute(event, buildContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    expect(value).toBeInstanceOf(SubscriptionWebhookNoOpResponse);
    expect((value as SubscriptionWebhookNoOpResponse).reason).toBe("unsupported");
    expect((value as SubscriptionWebhookNoOpResponse).handledEventType).toBe("customer.created");

    expect(h.customerSubscriptionHandler.handleCreated).not.toHaveBeenCalled();
    expect(h.invoiceHandler.handlePaid).not.toHaveBeenCalled();
    expect(h.chargeRefundHandler.handle).not.toHaveBeenCalled();
  });

  it("propagates handler success Result through to caller", async () => {
    const h = buildHarness();
    const event = buildEvent("invoice.paid");

    const result = await h.useCase.execute(event, buildContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap() as InvoiceHandlerSuccess;

    expect(value._tag).toBe("InvoiceHandlerSuccess");
    expect(value.mintedSaleorOrderId).toBe("order_T12");
  });
});

describe("isSubscriptionWebhookEventType", () => {
  it("returns true for the events T12 dispatches", () => {
    for (const type of [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.created",
      "invoice.finalized",
      "invoice.paid",
      "invoice.payment_failed",
      "charge.refunded",
    ] as const) {
      expect(isSubscriptionWebhookEventType(type)).toBe(true);
    }
  });

  it("returns false for the existing one-shot payment-intent events", () => {
    for (const type of [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "refund.created",
    ] as const) {
      expect(isSubscriptionWebhookEventType(type)).toBe(false);
    }
  });
});
