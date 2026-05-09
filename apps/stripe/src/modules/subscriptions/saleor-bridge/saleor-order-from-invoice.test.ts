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
    expect(draftCreateVars).toStrictEqual({
      input: {
        channelId: "Q2hhbm5lbDox",
        user: "VXNlcjox",
        lines: [{ variantId: "UHJvZHVjdFZhcmlhbnQ6MQ==", quantity: 1 }],
        externalReference: "in_test_001",
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
});
