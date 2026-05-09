import type Stripe from "stripe";
import { type Client } from "urql";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SubscriptionDraftOrderCompleteDocument,
  SubscriptionDraftOrderCreateDocument,
  SubscriptionTransactionCreateDocument,
} from "@/generated/graphql";

import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  mintOrderFromInvoice,
  SaleorOrderFromInvoice,
  SaleorOrderFromInvoiceError,
} from "./saleor-order-from-invoice";

/**
 * T30: Stripe Tax line copying. The implementation uses option (c) from the
 * task brief — set the draft-order line's `price` (PositiveDecimal, major
 * units) to `amount_paid / 100 / quantity` so the Saleor order total matches
 * the Stripe charge exactly, and stamp `stripeTaxCents` + `stripeSubtotalCents`
 * onto the order's metadata for downstream OwlBooks AR reconciliation. The
 * Sales Tax-as-shipping option (a) is not viable on Saleor 3.22 because
 * `DraftOrderInput` has no `shippingPrice` field, and the dedicated tax
 * variant option (b) would require provisioning a special variant ahead of
 * time. Option (c) keeps a single line, matches order total to invoice total
 * by construction, and surfaces the breakdown via metadata.
 */

const buildSubscriptionRecord = (
  overrides?: Partial<ConstructorParameters<typeof SubscriptionRecord>[0]>,
) =>
  new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId("sub_test_123"),
    stripeCustomerId: createStripeCustomerId("cus_test_123"),
    saleorChannelSlug: createSaleorChannelSlug("owlbooks"),
    saleorUserId: "VXNlcjox",
    fiefUserId: createFiefUserId("fief_user_uuid"),
    saleorEntityId: null,
    stripePriceId: createStripePriceId("price_test_basic"),
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

const buildInvoice = (overrides?: Record<string, unknown>): Stripe.Invoice =>
  ({
    id: "in_test_001",
    object: "invoice",
    amount_paid: 4900,
    currency: "usd",
    charge: "ch_test_001",
    /*
     * T30: tax-aware invoice fields. Default fixture has NO tax — subtotal
     * equals amount_paid. Tests that exercise tax handling override
     * `total_tax_amounts`, `total_excluding_tax`, and `amount_paid` together.
     */
    total_excluding_tax: 4900,
    total_tax_amounts: [],
    ...overrides,
  }) as unknown as Stripe.Invoice;

/**
 * Build a fake `Pick<Client, "mutation" | "query">` whose `mutation`
 * dispatches by document. Each step's response is queued; tests can also
 * override individual responses.
 */
function buildFakeClient(opts: {
  channels?: { id: string; slug: string }[];
  channelsError?: unknown;
  draftOrderCreateResponse?: { data?: unknown; error?: unknown };
  draftOrderCompleteResponse?: { data?: unknown; error?: unknown };
  transactionCreateResponse?: { data?: unknown; error?: unknown };
}) {
  const mutation = vi.fn(async (doc: unknown, _vars: unknown) => {
    if (doc === SubscriptionDraftOrderCreateDocument) {
      return (
        opts.draftOrderCreateResponse ?? {
          data: { draftOrderCreate: { order: { id: "T3JkZXI6MQ==" }, errors: [] } },
        }
      );
    }

    if (doc === SubscriptionDraftOrderCompleteDocument) {
      return (
        opts.draftOrderCompleteResponse ?? {
          data: { draftOrderComplete: { order: { id: "T3JkZXI6MQ==" }, errors: [] } },
        }
      );
    }

    if (doc === SubscriptionTransactionCreateDocument) {
      return (
        opts.transactionCreateResponse ?? {
          data: {
            transactionCreate: { transaction: { id: "VHJhbnNhY3Rpb246MQ==" }, errors: [] },
          },
        }
      );
    }

    throw new Error(`Unexpected mutation document: ${String(doc)}`);
  });

  const query = vi.fn(() => ({
    async toPromise() {
      if (opts.channelsError) {
        return { error: opts.channelsError };
      }

      return {
        data: {
          channels: opts.channels ?? [{ id: "Q2hhbm5lbDox", slug: "owlbooks" }],
        },
      };
    },
  }));

  return { mutation, query } as unknown as Pick<Client, "mutation" | "query"> & {
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
}

describe("mintOrderFromInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: calls draftOrderCreate, draftOrderComplete, transactionCreate and returns the minted order info", async () => {
    const client = buildFakeClient({});

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({
      saleorOrderId: "T3JkZXI6MQ==",
      stripeChargeId: "ch_test_001",
      amountCents: 4900,
      currency: "USD",
    });

    expect(client.mutation).toHaveBeenCalledTimes(3);

    const [draftCreateDoc, draftCreateVars] = client.mutation.mock.calls[0];

    expect(draftCreateDoc).toBe(SubscriptionDraftOrderCreateDocument);
    /*
     * T30: line carries an explicit `price` set to `amount_paid / 100 / qty`
     * so the Saleor order total matches what Stripe charged. With no tax,
     * 4900 / 100 / 1 = 49. Metadata stamps stripeTaxCents=0 + subtotal=4900.
     */
    expect(draftCreateVars).toStrictEqual({
      input: {
        channelId: "Q2hhbm5lbDox",
        user: "VXNlcjox",
        lines: [{ variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==", quantity: 1, price: 49 }],
        externalReference: "in_test_001",
        metadata: [
          { key: "stripeTaxCents", value: "0" },
          { key: "stripeSubtotalCents", value: "4900" },
        ],
      },
    });

    const [draftCompleteDoc, draftCompleteVars] = client.mutation.mock.calls[1];

    expect(draftCompleteDoc).toBe(SubscriptionDraftOrderCompleteDocument);
    expect(draftCompleteVars).toStrictEqual({ id: "T3JkZXI6MQ==" });

    const [txnDoc, txnVars] = client.mutation.mock.calls[2];

    expect(txnDoc).toBe(SubscriptionTransactionCreateDocument);
    expect(txnVars).toStrictEqual({
      id: "T3JkZXI6MQ==",
      transaction: {
        name: "Stripe Subscription",
        pspReference: "ch_test_001",
        amountCharged: { amount: 49, currency: "USD" },
        availableActions: ["REFUND"],
      },
    });
  });

  it("accepts a populated Charge object on invoice.charge and uses its id", async () => {
    const client = buildFakeClient({});

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice({
        // Stripe sometimes returns the expanded Charge object instead of an id.
        charge: { id: "ch_expanded_42", object: "charge" },
      }),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stripeChargeId).toBe("ch_expanded_42");
  });

  it("returns SaleorUserMissingError when subscriptionRecord.saleorUserId is the empty string (defensive runtime check)", async () => {
    const client = buildFakeClient({});

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord({ saleorUserId: "" }),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.SaleorUserMissingError,
    );
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("returns VariantMappingMissingError when saleorVariantId is empty", async () => {
    const client = buildFakeClient({});

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.VariantMappingMissingError,
    );
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("returns InvoiceMissingChargeError when invoice has no charge", async () => {
    const client = buildFakeClient({});

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice({ charge: null }),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.InvoiceMissingChargeError,
    );
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("returns ChannelResolutionFailedError when slug is unknown", async () => {
    const client = buildFakeClient({
      channels: [{ id: "Q2hhbm5lbDoy", slug: "default-channel" }],
    });

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.ChannelResolutionFailedError,
    );
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("error path: draftOrderCreate returns errors → does NOT call draftOrderComplete or transactionCreate", async () => {
    const client = buildFakeClient({
      draftOrderCreateResponse: {
        data: {
          draftOrderCreate: {
            order: null,
            errors: [
              {
                field: "lines",
                message: "Variant not found",
                code: "NOT_FOUND",
              },
            ],
          },
        },
      },
    });

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.DraftOrderCreateFailedError,
    );

    // Critical: only draftOrderCreate was called — no further mutations attempted.
    expect(client.mutation).toHaveBeenCalledTimes(1);
    expect(client.mutation.mock.calls[0][0]).toBe(SubscriptionDraftOrderCreateDocument);
  });

  it("error path: draftOrderCreate transport error → returns DraftOrderCreateFailedError", async () => {
    const client = buildFakeClient({
      draftOrderCreateResponse: { error: new Error("network down") },
    });

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.DraftOrderCreateFailedError,
    );
    expect(client.mutation).toHaveBeenCalledTimes(1);
  });

  it("error path: draftOrderComplete returns errors → does NOT call transactionCreate", async () => {
    const client = buildFakeClient({
      draftOrderCompleteResponse: {
        data: {
          draftOrderComplete: {
            order: null,
            errors: [{ field: null, message: "Cannot complete unverified order", code: "INVALID" }],
          },
        },
      },
    });

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.DraftOrderCompleteFailedError,
    );

    expect(client.mutation).toHaveBeenCalledTimes(2);
    expect(client.mutation.mock.calls[0][0]).toBe(SubscriptionDraftOrderCreateDocument);
    expect(client.mutation.mock.calls[1][0]).toBe(SubscriptionDraftOrderCompleteDocument);
  });

  it("error path: transactionCreate returns errors → returns TransactionCreateFailedError after all 3 calls", async () => {
    const client = buildFakeClient({
      transactionCreateResponse: {
        data: {
          transactionCreate: {
            transaction: null,
            errors: [{ field: "pspReference", message: "Already exists", code: "UNIQUE" }],
          },
        },
      },
    });

    const result = await mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorOrderFromInvoiceError.TransactionCreateFailedError,
    );
    expect(client.mutation).toHaveBeenCalledTimes(3);
  });

  it("class wrapper SaleorOrderFromInvoice.mintOrderFromInvoice matches function-form behavior", async () => {
    const client = buildFakeClient({});
    const instance = new SaleorOrderFromInvoice();

    const result = await instance.mintOrderFromInvoice({
      invoice: buildInvoice(),
      subscriptionRecord: buildSubscriptionRecord(),
      saleorChannelSlug: "owlbooks",
      saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
      graphqlClient: client,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().saleorOrderId).toBe("T3JkZXI6MQ==");
  });

  /*
   * -------------------------------------------------------------------------
   * T30: Stripe Tax → Saleor order line
   * -------------------------------------------------------------------------
   */
  describe("T30 — Stripe Tax line copying", () => {
    it("invoice with single-jurisdiction tax: line price = (subtotal+tax)/qty, metadata stamps tax+subtotal cents", async () => {
      const client = buildFakeClient({});

      const result = await mintOrderFromInvoice({
        invoice: buildInvoice({
          amount_paid: 5290, // 4900 subtotal + 390 tax
          total_excluding_tax: 4900,
          total_tax_amounts: [{ amount: 390 }],
        }),
        subscriptionRecord: buildSubscriptionRecord(),
        saleorChannelSlug: "owlbooks",
        saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
        graphqlClient: client,
      });

      expect(result.isOk()).toBe(true);

      const [, draftCreateVars] = client.mutation.mock.calls[0] as [
        unknown,
        {
          input: {
            lines: Array<{ price: number }>;
            metadata: Array<{ key: string; value: string }>;
          };
        },
      ];

      // 5290 / 100 / 1 = 52.9
      expect(draftCreateVars.input.lines[0].price).toBe(52.9);
      expect(draftCreateVars.input.metadata).toStrictEqual(
        expect.arrayContaining([
          { key: "stripeTaxCents", value: "390" },
          { key: "stripeSubtotalCents", value: "4900" },
        ]),
      );

      // amountCents on the result (and downstream transactionCreate) still equals invoice.amount_paid.
      expect(result._unsafeUnwrap().amountCents).toBe(5290);
    });

    it("invoice with NO tax (empty total_tax_amounts): order line price = subtotal/qty, taxCents metadata = 0", async () => {
      const client = buildFakeClient({});

      const result = await mintOrderFromInvoice({
        invoice: buildInvoice({
          amount_paid: 4900,
          total_excluding_tax: 4900,
          total_tax_amounts: [],
        }),
        subscriptionRecord: buildSubscriptionRecord(),
        saleorChannelSlug: "owlbooks",
        saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
        graphqlClient: client,
      });

      expect(result.isOk()).toBe(true);

      const [, draftCreateVars] = client.mutation.mock.calls[0] as [
        unknown,
        {
          input: {
            lines: Array<{ price: number }>;
            metadata: Array<{ key: string; value: string }>;
          };
        },
      ];

      expect(draftCreateVars.input.lines[0].price).toBe(49);
      expect(draftCreateVars.input.metadata).toStrictEqual(
        expect.arrayContaining([
          { key: "stripeTaxCents", value: "0" },
          { key: "stripeSubtotalCents", value: "4900" },
        ]),
      );
    });

    it("invoice with multi-jurisdiction tax (2 entries): sums correctly, line price reflects total", async () => {
      const client = buildFakeClient({});

      const result = await mintOrderFromInvoice({
        invoice: buildInvoice({
          amount_paid: 5300, // 5000 subtotal + 200 + 100 tax = 5300
          total_excluding_tax: 5000,
          total_tax_amounts: [{ amount: 200 }, { amount: 100 }],
        }),
        subscriptionRecord: buildSubscriptionRecord(),
        saleorChannelSlug: "owlbooks",
        saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
        graphqlClient: client,
      });

      expect(result.isOk()).toBe(true);

      const [, draftCreateVars] = client.mutation.mock.calls[0] as [
        unknown,
        {
          input: {
            lines: Array<{ price: number }>;
            metadata: Array<{ key: string; value: string }>;
          };
        },
      ];

      // 5300 / 100 / 1 = 53
      expect(draftCreateVars.input.lines[0].price).toBe(53);
      expect(draftCreateVars.input.metadata).toStrictEqual(
        expect.arrayContaining([
          { key: "stripeTaxCents", value: "300" },
          { key: "stripeSubtotalCents", value: "5000" },
        ]),
      );
    });

    it("mismatch path: synthetic invoice where amount_paid != subtotal+tax (delta > 1 cent) → returns TaxMismatchError, fires Sentry captureException with structured tags, performs ZERO mutations", async () => {
      const client = buildFakeClient({});
      const captureExceptionMock = vi.fn();

      const result = await mintOrderFromInvoice({
        invoice: buildInvoice({
          amount_paid: 5500, // claimed paid
          total_excluding_tax: 4900,
          total_tax_amounts: [{ amount: 390 }], // 4900 + 390 = 5290 != 5500 → 210-cent delta
        }),
        subscriptionRecord: buildSubscriptionRecord(),
        saleorChannelSlug: "owlbooks",
        saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
        graphqlClient: client,
        captureException: captureExceptionMock,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        SaleorOrderFromInvoiceError.TaxMismatchError,
      );

      // No order mutations should have been issued.
      expect(client.mutation).not.toHaveBeenCalled();

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [capturedError, captureContext] = captureExceptionMock.mock.calls[0] as [
        Error,
        { tags?: Record<string, unknown>; extra?: Record<string, unknown> },
      ];

      expect(capturedError).toBeInstanceOf(SaleorOrderFromInvoiceError.TaxMismatchError);
      expect(captureContext.tags).toMatchObject({
        subsystem: "stripe-subscriptions",
        event: "invoice.paid.tax-mismatch",
        stripeInvoiceId: "in_test_001",
      });
      expect(captureContext.extra).toMatchObject({
        expectedTotal: 5500,
        actualTotal: 5290,
        deltaCents: 210,
      });
    });

    it("mismatch path: 1-cent delta is tolerated (within $0.01 threshold) → succeeds, no Sentry", async () => {
      const client = buildFakeClient({});
      const captureExceptionMock = vi.fn();

      const result = await mintOrderFromInvoice({
        invoice: buildInvoice({
          amount_paid: 4901, // off-by-one rounding
          total_excluding_tax: 4900,
          total_tax_amounts: [{ amount: 0 }], // 4900+0=4900, delta=1 cent → tolerated
        }),
        subscriptionRecord: buildSubscriptionRecord(),
        saleorChannelSlug: "owlbooks",
        saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
        graphqlClient: client,
        captureException: captureExceptionMock,
      });

      expect(result.isOk()).toBe(true);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });
  });
});
