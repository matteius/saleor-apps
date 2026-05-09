/**
 * Vitest for T14 (`handlePaid`) and T16 (`handleFailed`) on `InvoiceHandler`.
 *
 * Coverage matrix:
 * - handlePaid happy path: lookup → idempotency → variant resolve → mint →
 *   cache update → notify
 * - handlePaid idempotency: same `invoice.id` short-circuits without calling
 *   mint
 * - handlePaid unknown price: `priceVariantMapRepo.get → Ok(null)` returns
 *   `Err(UnknownStripePriceError)` and does NOT call mint
 * - handlePaid missing subscription record: returns `Err`, no mint
 * - handlePaid non-subscription invoice (no `subscription` field): `Ok` no-op
 * - handlePaid mint failure: returns `Err`, no DLQ written here (T32)
 * - handleFailed: status → past_due, no mint, OwlBooks notified
 * - Tax sum: invoice with 2 tax_amounts → `taxCents = sum`
 *
 * All deps are mocked via `vi.fn()` returning `Result` values from `neverthrow`.
 */
import { type APL, type AuthData } from "@saleor/app-sdk/APL";
import { err, ok, type Result } from "neverthrow";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import {
  type NotifyError,
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "../notifiers/owlbooks-notifier";
import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoError,
} from "../repositories/subscription-repo";
import {
  createSaleorVariantId,
  type PriceVariantMapping,
  type PriceVariantMapRepo,
} from "../saleor-bridge/price-variant-map";
import {
  type MintOrderFromInvoiceArgs,
  type MintOrderFromInvoiceResult,
  SaleorOrderFromInvoiceError,
} from "../saleor-bridge/saleor-order-from-invoice";
import {
  type IInvoiceHandler,
  InvoiceHandler,
  type InvoiceHandlerError,
  InvoiceHandlerErrors,
  type InvoiceHandlerSuccess,
  type MintOrderFromInvoiceFn,
} from "./invoice-handler";
import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

/*
 * ---------------------------------------------------------------------------
 * Test data builders
 * ---------------------------------------------------------------------------
 */

const TEST_SUB_ID = "sub_test_T14";
const TEST_CUSTOMER_ID = "cus_test_T14";
const TEST_PRICE_ID = "price_test_T14";
const TEST_VARIANT_ID = "VmFyaWFudDox";
const TEST_CHANNEL_SLUG = "owlbooks";
const TEST_FIEF_USER_ID = "fief_user_T14";
const TEST_INVOICE_ID = "in_test_T14_001";
const TEST_CHARGE_ID = "ch_test_T14_001";
const TEST_SALEOR_USER_ID = "VXNlcjox";
const MINTED_ORDER_ID = "T3JkZXI6MTAwMQ==";

const TEST_AUTH_DATA: AuthData = {
  appId: "app_test_T14",
  token: "test_token_T14",
  saleorApiUrl: mockedSaleorApiUrl,
};

function buildContext(): SubscriptionWebhookContext {
  return {
    saleorApiUrl: mockedSaleorApiUrl,
    appId: "app_test_T14",
    stripeEnv: "TEST",
    restrictedKey: mockedStripeRestrictedKey,
  };
}

function buildSubscriptionRecord(
  overrides?: Partial<ConstructorParameters<typeof SubscriptionRecord>[0]>,
): SubscriptionRecord {
  return new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId(TEST_SUB_ID),
    stripeCustomerId: createStripeCustomerId(TEST_CUSTOMER_ID),
    saleorChannelSlug: createSaleorChannelSlug(TEST_CHANNEL_SLUG),
    saleorUserId: TEST_SALEOR_USER_ID,
    fiefUserId: createFiefUserId(TEST_FIEF_USER_ID),
    saleorEntityId: null,
    stripePriceId: createStripePriceId(TEST_PRICE_ID),
    status: "active",
    currentPeriodStart: new Date("2026-05-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-06-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    lastInvoiceId: null,
    lastSaleorOrderId: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  });
}

function buildMapping(): PriceVariantMapping {
  return {
    stripePriceId: createStripePriceId(TEST_PRICE_ID),
    saleorVariantId: createSaleorVariantId(TEST_VARIANT_ID),
    saleorChannelSlug: createSaleorChannelSlug(TEST_CHANNEL_SLUG),
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
  };
}

function buildInvoice(overrides?: Record<string, unknown>): Stripe.Invoice {
  return {
    id: TEST_INVOICE_ID,
    object: "invoice",
    amount_paid: 4900,
    currency: "usd",
    charge: TEST_CHARGE_ID,
    subscription: TEST_SUB_ID,
    total_excluding_tax: 4900,
    total_tax_amounts: [],
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function buildPaidEvent(invoiceOverrides?: Record<string, unknown>): Stripe.InvoicePaidEvent {
  return {
    id: "evt_invoice_paid_T14",
    object: "event",
    api_version: "2024-06-20",
    created: 1_715_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "invoice.paid",
    data: { object: buildInvoice(invoiceOverrides) },
  } as unknown as Stripe.InvoicePaidEvent;
}

function buildFailedEvent(
  invoiceOverrides?: Record<string, unknown>,
): Stripe.InvoicePaymentFailedEvent {
  return {
    id: "evt_invoice_payment_failed_T16",
    object: "event",
    api_version: "2024-06-20",
    created: 1_715_000_500,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "invoice.payment_failed",
    data: { object: buildInvoice(invoiceOverrides) },
  } as unknown as Stripe.InvoicePaymentFailedEvent;
}

/*
 * ---------------------------------------------------------------------------
 * Mock harness
 * ---------------------------------------------------------------------------
 */

interface Harness {
  handler: IInvoiceHandler;
  subscriptionRepo: {
    upsert: ReturnType<typeof vi.fn>;
    getBySubscriptionId: ReturnType<typeof vi.fn>;
    getByCustomerId: ReturnType<typeof vi.fn>;
    getByFiefUserId: ReturnType<typeof vi.fn>;
  };
  priceVariantMapRepo: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  notifier: { notify: ReturnType<typeof vi.fn> };
  apl: { get: ReturnType<typeof vi.fn> };
  mintFn: ReturnType<typeof vi.fn>;
  graphqlClientFactory: ReturnType<typeof vi.fn>;
  fakeGraphqlClient: MintOrderFromInvoiceArgs["graphqlClient"];
}

function makeHarness(opts?: {
  initialRecord?: SubscriptionRecord | null;
  mapping?: PriceVariantMapping | null;
  mintResult?: Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>;
  notifierResult?: Result<void, NotifyError>;
  recordLookupErr?: SubscriptionRepoError;
  upsertResult?: Result<null, SubscriptionRepoError>;
  authData?: AuthData | null;
}): Harness {
  const fakeGraphqlClient = {
    mutation: vi.fn(),
    query: vi.fn(),
  } as unknown as MintOrderFromInvoiceArgs["graphqlClient"];

  const subscriptionRepo = {
    upsert: vi.fn().mockResolvedValue(opts?.upsertResult ?? ok(null)),
    getBySubscriptionId: vi
      .fn()
      .mockResolvedValue(
        opts?.recordLookupErr ? err(opts.recordLookupErr) : ok(opts?.initialRecord ?? null),
      ),
    getByCustomerId: vi.fn().mockResolvedValue(ok(null)),
    getByFiefUserId: vi.fn().mockResolvedValue(ok(null)),
  };

  const priceVariantMapRepo = {
    set: vi.fn().mockResolvedValue(ok(null)),
    get: vi.fn().mockResolvedValue(ok(opts?.mapping ?? null)),
    delete: vi.fn().mockResolvedValue(ok(null)),
    list: vi.fn().mockResolvedValue(ok([])),
  };

  const notifier = {
    notify: vi.fn().mockResolvedValue(opts?.notifierResult ?? ok(undefined)),
  };

  const apl = {
    get: vi.fn().mockResolvedValue(opts?.authData === undefined ? TEST_AUTH_DATA : opts.authData),
  };

  const defaultMintResult: Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError> = ok({
    saleorOrderId: MINTED_ORDER_ID,
    stripeChargeId: TEST_CHARGE_ID,
    amountCents: 4900,
    currency: "USD",
  });

  const mintFn = vi.fn().mockResolvedValue(opts?.mintResult ?? defaultMintResult);

  const graphqlClientFactory = vi.fn().mockReturnValue(fakeGraphqlClient);

  const handler = new InvoiceHandler({
    subscriptionRepo: subscriptionRepo as unknown as SubscriptionRepo,
    priceVariantMapRepo: priceVariantMapRepo as unknown as PriceVariantMapRepo,
    owlbooksWebhookNotifier: notifier as unknown as OwlBooksWebhookNotifier,
    apl: apl as unknown as APL,
    mintOrderFromInvoice: mintFn as unknown as MintOrderFromInvoiceFn,
    graphqlClientFactory,
  });

  return {
    handler,
    subscriptionRepo,
    priceVariantMapRepo,
    notifier,
    apl,
    mintFn,
    graphqlClientFactory,
    fakeGraphqlClient,
  };
}

function expectOk<T, E>(r: Result<T, E>): T {
  if (r.isErr()) {
    throw new Error(`Expected Ok, got Err: ${String(r.error)}`);
  }

  return r.value;
}

function expectErr<T, E>(r: Result<T, E>): E {
  if (r.isOk()) {
    throw new Error(`Expected Err, got Ok: ${JSON.stringify(r.value)}`);
  }

  return r.error;
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe("InvoiceHandler.handlePaid (T14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: looks up record → idempotency miss → resolves variant → mints order → upserts cache → notifies OwlBooks", async () => {
    const subscriptionRecord = buildSubscriptionRecord();
    const harness = makeHarness({
      initialRecord: subscriptionRecord,
      mapping: buildMapping(),
    });

    const event = buildPaidEvent({
      total_tax_amounts: [{ amount: 250 }, { amount: 150 }],
    });

    const result = await harness.handler.handlePaid(event, buildContext());

    const value = expectOk<InvoiceHandlerSuccess, InvoiceHandlerError>(result);

    expect(value.stripeInvoiceId).toBe(TEST_INVOICE_ID);
    expect(value.mintedSaleorOrderId).toBe(MINTED_ORDER_ID);

    // Lookup
    expect(harness.subscriptionRepo.getBySubscriptionId).toHaveBeenCalledTimes(1);
    expect(harness.subscriptionRepo.getBySubscriptionId).toHaveBeenCalledWith(
      { saleorApiUrl: mockedSaleorApiUrl, appId: "app_test_T14" },
      TEST_SUB_ID,
    );

    // Variant resolution
    expect(harness.priceVariantMapRepo.get).toHaveBeenCalledTimes(1);
    expect(harness.priceVariantMapRepo.get).toHaveBeenCalledWith(
      { saleorApiUrl: mockedSaleorApiUrl, appId: "app_test_T14" },
      TEST_PRICE_ID,
    );

    // GraphQL client built via factory using authData from APL
    expect(harness.apl.get).toHaveBeenCalledWith(mockedSaleorApiUrl);
    expect(harness.graphqlClientFactory).toHaveBeenCalledWith({
      saleorApiUrl: mockedSaleorApiUrl,
      token: TEST_AUTH_DATA.token,
    });

    // Mint
    expect(harness.mintFn).toHaveBeenCalledTimes(1);
    const [mintArgs] = harness.mintFn.mock.calls[0]!;

    expect(mintArgs.invoice.id).toBe(TEST_INVOICE_ID);
    expect(mintArgs.subscriptionRecord).toBe(subscriptionRecord);
    expect(mintArgs.saleorChannelSlug).toBe(TEST_CHANNEL_SLUG);
    expect(mintArgs.saleorVariantId).toBe(TEST_VARIANT_ID);
    expect(mintArgs.graphqlClient).toBe(harness.fakeGraphqlClient);

    // Cache upsert with new lastInvoiceId / lastSaleorOrderId
    expect(harness.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);
    const [, upsertedRecord] = harness.subscriptionRepo.upsert.mock.calls[0]!;

    expect(upsertedRecord.lastInvoiceId).toBe(TEST_INVOICE_ID);
    expect(upsertedRecord.lastSaleorOrderId).toBe(MINTED_ORDER_ID);
    expect(upsertedRecord.stripeSubscriptionId).toBe(subscriptionRecord.stripeSubscriptionId);

    // Notify OwlBooks
    expect(harness.notifier.notify).toHaveBeenCalledTimes(1);
    const [payload] = harness.notifier.notify.mock.calls[0]! as [OwlBooksWebhookPayload];

    expect(payload.type).toBe("invoice.paid");
    expect(payload.stripeSubscriptionId).toBe(TEST_SUB_ID);
    expect(payload.stripeCustomerId).toBe(TEST_CUSTOMER_ID);
    expect(payload.fiefUserId).toBe(TEST_FIEF_USER_ID);
    expect(payload.lastInvoiceId).toBe(TEST_INVOICE_ID);
    expect(payload.lastSaleorOrderId).toBe(MINTED_ORDER_ID);
    expect(payload.saleorChannelSlug).toBe(TEST_CHANNEL_SLUG);
    expect(payload.amountCents).toBe(4900);
    expect(payload.taxCents).toBe(400);
    expect(payload.currency).toBe("usd");
    expect(payload.stripeChargeId).toBe(TEST_CHARGE_ID);
    expect(payload.stripeEventCreatedAt).toBe(1_715_000_000);
    expect(payload.status).toBe("ACTIVE");
  });

  it("idempotency: replay of the same invoice id short-circuits to Ok WITHOUT calling mint, upsert or notify", async () => {
    const subscriptionRecord = buildSubscriptionRecord({
      lastInvoiceId: TEST_INVOICE_ID,
      lastSaleorOrderId: MINTED_ORDER_ID,
    });
    const harness = makeHarness({
      initialRecord: subscriptionRecord,
      mapping: buildMapping(),
    });

    const result = await harness.handler.handlePaid(buildPaidEvent(), buildContext());

    const value = expectOk<InvoiceHandlerSuccess, InvoiceHandlerError>(result);

    expect(value.stripeInvoiceId).toBe(TEST_INVOICE_ID);
    expect(value.mintedSaleorOrderId).toBe(MINTED_ORDER_ID);

    expect(harness.subscriptionRepo.getBySubscriptionId).toHaveBeenCalledTimes(1);
    // No further work past idempotency check
    expect(harness.priceVariantMapRepo.get).not.toHaveBeenCalled();
    expect(harness.mintFn).not.toHaveBeenCalled();
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
    expect(harness.graphqlClientFactory).not.toHaveBeenCalled();
  });

  it("unknown stripe price (mapping is Ok(null)): returns Err(UnknownStripePriceError) WITHOUT calling mint", async () => {
    const harness = makeHarness({
      initialRecord: buildSubscriptionRecord(),
      mapping: null,
    });

    const result = await harness.handler.handlePaid(buildPaidEvent(), buildContext());

    const error = expectErr(result);

    expect(error).toBeInstanceOf(InvoiceHandlerErrors.UnknownStripePriceError);

    expect(harness.priceVariantMapRepo.get).toHaveBeenCalledTimes(1);
    expect(harness.mintFn).not.toHaveBeenCalled();
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });

  it("missing subscription record: returns Err(SubscriptionRecordMissingError), no mint", async () => {
    const harness = makeHarness({
      initialRecord: null,
    });

    const result = await harness.handler.handlePaid(buildPaidEvent(), buildContext());

    const error = expectErr(result);

    expect(error).toBeInstanceOf(InvoiceHandlerErrors.SubscriptionRecordMissingError);

    expect(harness.priceVariantMapRepo.get).not.toHaveBeenCalled();
    expect(harness.mintFn).not.toHaveBeenCalled();
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });

  it("non-subscription invoice (no `subscription` field): returns Ok no-op without any work", async () => {
    const harness = makeHarness({
      initialRecord: buildSubscriptionRecord(),
      mapping: buildMapping(),
    });

    const event = buildPaidEvent({ subscription: null });

    const result = await harness.handler.handlePaid(event, buildContext());

    const value = expectOk<InvoiceHandlerSuccess, InvoiceHandlerError>(result);

    expect(value.stripeInvoiceId).toBe(TEST_INVOICE_ID);
    expect(value.mintedSaleorOrderId).toBeNull();

    expect(harness.subscriptionRepo.getBySubscriptionId).not.toHaveBeenCalled();
    expect(harness.priceVariantMapRepo.get).not.toHaveBeenCalled();
    expect(harness.mintFn).not.toHaveBeenCalled();
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });

  it("mint failure: returns Err(MintFailedError); no DLQ written here (T32 owns DLQ); no cache update", async () => {
    const harness = makeHarness({
      initialRecord: buildSubscriptionRecord(),
      mapping: buildMapping(),
      mintResult: err(
        new SaleorOrderFromInvoiceError.DraftOrderCreateFailedError(
          "draftOrderCreate returned errors: NOT_FOUND(variantId): missing",
        ),
      ),
    });

    const result = await harness.handler.handlePaid(buildPaidEvent(), buildContext());

    const error = expectErr(result);

    expect(error).toBeInstanceOf(InvoiceHandlerErrors.MintFailedError);
    expect(harness.mintFn).toHaveBeenCalledTimes(1);
    // Cache must NOT be updated when mint failed
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    // OwlBooks must NOT be notified of a paid event we couldn't fulfill
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });

  it("tax sum: invoice with two tax_amounts → taxCents = sum of amounts", async () => {
    const harness = makeHarness({
      initialRecord: buildSubscriptionRecord(),
      mapping: buildMapping(),
    });

    const event = buildPaidEvent({
      total_tax_amounts: [{ amount: 123 }, { amount: 77 }, { amount: 50 }],
    });

    const result = await harness.handler.handlePaid(event, buildContext());

    expectOk<InvoiceHandlerSuccess, InvoiceHandlerError>(result);

    const [payload] = harness.notifier.notify.mock.calls[0]! as [OwlBooksWebhookPayload];

    expect(payload.taxCents).toBe(250);
  });

  it("missing total_tax_amounts: taxCents defaults to 0", async () => {
    const harness = makeHarness({
      initialRecord: buildSubscriptionRecord(),
      mapping: buildMapping(),
    });

    const event = buildPaidEvent({ total_tax_amounts: undefined });

    await harness.handler.handlePaid(event, buildContext());

    const [payload] = harness.notifier.notify.mock.calls[0]! as [OwlBooksWebhookPayload];

    expect(payload.taxCents).toBe(0);
  });
});

describe("InvoiceHandler.handleFailed (T16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates cached status to past_due, does NOT call mint, notifies OwlBooks with PAST_DUE", async () => {
    const subscriptionRecord = buildSubscriptionRecord({ status: "active" });
    const harness = makeHarness({
      initialRecord: subscriptionRecord,
      mapping: buildMapping(),
    });

    const result = await harness.handler.handleFailed(buildFailedEvent(), buildContext());

    const value = expectOk<InvoiceHandlerSuccess, InvoiceHandlerError>(result);

    expect(value.mintedSaleorOrderId).toBeNull();
    expect(value.stripeInvoiceId).toBe(TEST_INVOICE_ID);

    // Mint must NOT be called
    expect(harness.mintFn).not.toHaveBeenCalled();
    expect(harness.priceVariantMapRepo.get).not.toHaveBeenCalled();

    // Cache upsert with status = past_due
    expect(harness.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);
    const [, upserted] = harness.subscriptionRepo.upsert.mock.calls[0]!;

    expect(upserted.status).toBe("past_due");

    // Notify with PAST_DUE
    expect(harness.notifier.notify).toHaveBeenCalledTimes(1);
    const [payload] = harness.notifier.notify.mock.calls[0]! as [OwlBooksWebhookPayload];

    expect(payload.type).toBe("invoice.payment_failed");
    expect(payload.status).toBe("PAST_DUE");
    expect(payload.lastInvoiceId).toBeUndefined();
    expect(payload.lastSaleorOrderId).toBeUndefined();
    expect(payload.amountCents).toBeUndefined();
  });

  it("missing subscription record: returns Err(SubscriptionRecordMissingError), no upsert, no notify", async () => {
    const harness = makeHarness({
      initialRecord: null,
    });

    const result = await harness.handler.handleFailed(buildFailedEvent(), buildContext());

    const error = expectErr(result);

    expect(error).toBeInstanceOf(InvoiceHandlerErrors.SubscriptionRecordMissingError);
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });

  it("non-subscription invoice on payment_failed: Ok no-op", async () => {
    const harness = makeHarness({
      initialRecord: buildSubscriptionRecord(),
    });

    const event = buildFailedEvent({ subscription: null });

    const result = await harness.handler.handleFailed(event, buildContext());

    const value = expectOk<InvoiceHandlerSuccess, InvoiceHandlerError>(result);

    expect(value.mintedSaleorOrderId).toBeNull();
    expect(harness.subscriptionRepo.getBySubscriptionId).not.toHaveBeenCalled();
    expect(harness.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(harness.notifier.notify).not.toHaveBeenCalled();
  });
});

describe("InvoiceHandler — wiring guards", () => {
  it("returns Err(NotConfiguredError) on handlePaid when constructed without deps", async () => {
    const handler = new InvoiceHandler();

    const result = await handler.handlePaid(buildPaidEvent(), buildContext());

    expect(result.isErr()).toBe(true);
    expect(expectErr(result)).toBeInstanceOf(InvoiceHandlerErrors.NotConfiguredError);
  });

  it("returns Err(NotConfiguredError) on handleFailed when constructed without deps", async () => {
    const handler = new InvoiceHandler();

    const result = await handler.handleFailed(buildFailedEvent(), buildContext());

    expect(result.isErr()).toBe(true);
    expect(expectErr(result)).toBeInstanceOf(InvoiceHandlerErrors.NotConfiguredError);
  });
});
