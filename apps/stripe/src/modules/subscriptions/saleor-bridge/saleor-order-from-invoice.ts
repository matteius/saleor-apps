/**
 * Mints a Saleor draft order from a Stripe invoice and records the payment
 * transaction against it. Implementation for plan task T9.
 *
 * Flow:
 *   1. `draftOrderCreate` — single-line digital draft order against the channel
 *      and Saleor user, with a quantity-1 line for the variant mapped to the
 *      Stripe price.
 *   2. `draftOrderComplete` — promote the draft to a real order.
 *   3. `transactionCreate` — record the Stripe charge against the order with
 *      `name: 'Stripe Subscription'`, `pspReference: stripeChargeId`,
 *      `amountCharged: { amount, currency }`, `availableActions: ['REFUND']`.
 *
 * **Tax handling is NOT implemented in T9.** The `invoice` argument is included
 * on `MintOrderFromInvoiceArgs` so T30 can extend this function to read
 * `invoice.total_tax_amounts` and append a tax line via `draftOrderUpdate`
 * (or via the `shippingPrice` field for digital orders) without changing the
 * call sites in T14. The current implementation passes `invoice.amount_paid`
 * (which already includes Stripe-Tax-collected tax) as `amountCharged`, so
 * the transaction record matches the Stripe charge exactly even though the
 * Saleor order line total will not yet reflect tax.
 *
 * **Channel resolution.** Saleor's `draftOrderCreate` takes `channelId`, not
 * `channelSlug`. The existing `ChannelsFetcher`
 * (`modules/saleor/channel-fetcher.ts`) returns `{id, slug}` for every
 * channel — perfect for slug→id lookup. Callers (T14) pass us a slug; we use
 * `ChannelsFetcher` to resolve to id at mint time. We do not cache the lookup
 * here because Saleor channel-create is rare and the underlying urql client
 * already caches the query in process.
 */
import { err, ok, type Result } from "neverthrow";
import type Stripe from "stripe";
import { type Client } from "urql";

import {
  type OrderErrorCode,
  SubscriptionDraftOrderCompleteDocument,
  SubscriptionDraftOrderCreateDocument,
  SubscriptionTransactionCreateDocument,
  type TransactionCreateErrorCode,
} from "@/generated/graphql";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { ChannelsFetcher } from "@/modules/saleor/channel-fetcher";

import { type SubscriptionRecord } from "../repositories/subscription-record";

const VariantMappingMissingError = BaseError.subclass(
  "SaleorOrderFromInvoice.VariantMappingMissingError",
  {
    props: {
      _internalName: "SaleorOrderFromInvoice.VariantMappingMissingError",
    },
  },
);

const ChannelResolutionFailedError = BaseError.subclass(
  "SaleorOrderFromInvoice.ChannelResolutionFailedError",
  {
    props: {
      _internalName: "SaleorOrderFromInvoice.ChannelResolutionFailedError",
    },
  },
);

const SaleorUserMissingError = BaseError.subclass("SaleorOrderFromInvoice.SaleorUserMissingError", {
  props: {
    _internalName: "SaleorOrderFromInvoice.SaleorUserMissingError",
  },
});

const InvoiceMissingChargeError = BaseError.subclass(
  "SaleorOrderFromInvoice.InvoiceMissingChargeError",
  {
    props: {
      _internalName: "SaleorOrderFromInvoice.InvoiceMissingChargeError",
    },
  },
);

const DraftOrderCreateFailedError = BaseError.subclass(
  "SaleorOrderFromInvoice.DraftOrderCreateFailedError",
  {
    props: {
      _internalName: "SaleorOrderFromInvoice.DraftOrderCreateFailedError",
    },
  },
);

const DraftOrderCompleteFailedError = BaseError.subclass(
  "SaleorOrderFromInvoice.DraftOrderCompleteFailedError",
  {
    props: {
      _internalName: "SaleorOrderFromInvoice.DraftOrderCompleteFailedError",
    },
  },
);

const TransactionCreateFailedError = BaseError.subclass(
  "SaleorOrderFromInvoice.TransactionCreateFailedError",
  {
    props: {
      _internalName: "SaleorOrderFromInvoice.TransactionCreateFailedError",
    },
  },
);

export const SaleorOrderFromInvoiceError = {
  VariantMappingMissingError,
  ChannelResolutionFailedError,
  SaleorUserMissingError,
  InvoiceMissingChargeError,
  DraftOrderCreateFailedError,
  DraftOrderCompleteFailedError,
  TransactionCreateFailedError,
};

export type SaleorOrderFromInvoiceError =
  | InstanceType<typeof VariantMappingMissingError>
  | InstanceType<typeof ChannelResolutionFailedError>
  | InstanceType<typeof SaleorUserMissingError>
  | InstanceType<typeof InvoiceMissingChargeError>
  | InstanceType<typeof DraftOrderCreateFailedError>
  | InstanceType<typeof DraftOrderCompleteFailedError>
  | InstanceType<typeof TransactionCreateFailedError>;

export interface MintOrderFromInvoiceArgs {
  /**
   * The Stripe Invoice that just transitioned to `paid`. Currently used only
   * for `amount_paid`, `currency`, and the resolved `charge.id` extraction.
   * T30 will extend usage to read `invoice.total_tax_amounts` for tax-line
   * copying.
   */
  invoice: Stripe.Invoice;
  /** Cached subscription record (DynamoDB row from T8). */
  subscriptionRecord: SubscriptionRecord;
  /** Slug of the Saleor channel the order should be created in. */
  saleorChannelSlug: string;
  /** Saleor variant the order line should reference. Resolved by T10 caller. */
  saleorVariantId: string;
  /**
   * Saleor GraphQL client built via `createInstrumentedGraphqlClient(authData)`
   * (see `apps/stripe/src/lib/graphql-client.ts`). Accepted as a dependency so
   * the same APL-resolved auth is used for query + mutation calls.
   */
  graphqlClient: Pick<Client, "mutation" | "query">;
}

export interface MintOrderFromInvoiceResult {
  saleorOrderId: string;
  stripeChargeId: string;
  amountCents: number;
  currency: string;
}

export interface ISaleorOrderFromInvoice {
  mintOrderFromInvoice(
    args: MintOrderFromInvoiceArgs,
  ): Promise<Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>>;
}

const logger = createLogger("SaleorOrderFromInvoice");

/**
 * Stripe invoice's `charge` field can be an ID string, a populated `Charge`
 * object, or null. Normalize to a string ID; null/undefined means the invoice
 * never produced a charge (e.g. a $0 invoice) and we cannot record a Stripe
 * pspReference against the Saleor order.
 */
function extractChargeId(invoice: Stripe.Invoice): string | null {
  const charge = (invoice as Stripe.Invoice & { charge?: string | Stripe.Charge | null }).charge;

  if (!charge) {
    return null;
  }

  return typeof charge === "string" ? charge : charge.id;
}

function formatGraphqlErrors(
  errors: ReadonlyArray<{
    readonly field?: string | null;
    readonly message?: string | null;
    readonly code: OrderErrorCode | TransactionCreateErrorCode;
  }>,
): string {
  return errors
    .map((e) => `${e.code}${e.field ? `(${e.field})` : ""}: ${e.message ?? "<no message>"}`)
    .join("; ");
}

export async function mintOrderFromInvoice(
  args: MintOrderFromInvoiceArgs,
): Promise<Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>> {
  const { invoice, subscriptionRecord, saleorChannelSlug, saleorVariantId, graphqlClient } = args;

  if (!saleorVariantId) {
    return err(
      new VariantMappingMissingError(
        `Missing Saleor variant id for Stripe price ${subscriptionRecord.stripePriceId}`,
      ),
    );
  }

  /*
   * Defense-in-depth: SubscriptionRecord.saleorUserId is typed `string` (not
   * nullable) per T8, but we still reject an empty string at runtime since
   * GraphQL would otherwise reject `user: ""` with a less obvious error.
   */
  if (!subscriptionRecord.saleorUserId) {
    return err(
      new SaleorUserMissingError(
        `Subscription ${subscriptionRecord.stripeSubscriptionId} has no resolved Saleor user id`,
      ),
    );
  }

  const stripeChargeId = extractChargeId(invoice);

  if (!stripeChargeId) {
    return err(
      new InvoiceMissingChargeError(
        `Invoice ${invoice.id} has no charge — cannot record Stripe pspReference on Saleor order`,
      ),
    );
  }

  /*
   * Step 0: resolve channel slug → channel id (Saleor `draftOrderCreate`
   * takes `channelId`, not `channelSlug`).
   */
  const channelsFetcher = new ChannelsFetcher(graphqlClient);
  const channelsResult = await channelsFetcher.fetchChannels();

  if (channelsResult.isErr()) {
    return err(
      new ChannelResolutionFailedError(
        `Failed to fetch Saleor channels while resolving slug=${saleorChannelSlug}`,
        { cause: channelsResult.error },
      ),
    );
  }

  const channel = channelsResult.value.find((c) => c.slug === saleorChannelSlug);

  if (!channel) {
    return err(
      new ChannelResolutionFailedError(`Saleor channel with slug=${saleorChannelSlug} not found`),
    );
  }

  // Step 1: draftOrderCreate.
  let draftOrderCreateResult;

  try {
    draftOrderCreateResult = await graphqlClient.mutation(SubscriptionDraftOrderCreateDocument, {
      input: {
        channelId: channel.id,
        user: subscriptionRecord.saleorUserId,
        lines: [
          {
            variantId: saleorVariantId,
            quantity: 1,
          },
        ],
        externalReference: invoice.id,
      },
    });
  } catch (e) {
    return err(
      new DraftOrderCreateFailedError("Network error calling draftOrderCreate", { cause: e }),
    );
  }

  if (draftOrderCreateResult.error) {
    return err(
      new DraftOrderCreateFailedError("GraphQL transport error on draftOrderCreate", {
        cause: draftOrderCreateResult.error,
      }),
    );
  }

  const draftOrderCreateMutation = draftOrderCreateResult.data?.draftOrderCreate;
  const draftOrderCreateErrors = draftOrderCreateMutation?.errors ?? [];

  if (draftOrderCreateErrors.length > 0) {
    return err(
      new DraftOrderCreateFailedError(
        `draftOrderCreate returned errors: ${formatGraphqlErrors(draftOrderCreateErrors)}`,
      ),
    );
  }

  const draftOrderId = draftOrderCreateMutation?.order?.id;

  if (!draftOrderId) {
    return err(new DraftOrderCreateFailedError("draftOrderCreate returned no order.id"));
  }

  // Step 2: draftOrderComplete.
  let draftOrderCompleteResult;

  try {
    draftOrderCompleteResult = await graphqlClient.mutation(
      SubscriptionDraftOrderCompleteDocument,
      { id: draftOrderId },
    );
  } catch (e) {
    return err(
      new DraftOrderCompleteFailedError("Network error calling draftOrderComplete", { cause: e }),
    );
  }

  if (draftOrderCompleteResult.error) {
    return err(
      new DraftOrderCompleteFailedError("GraphQL transport error on draftOrderComplete", {
        cause: draftOrderCompleteResult.error,
      }),
    );
  }

  const draftOrderCompleteMutation = draftOrderCompleteResult.data?.draftOrderComplete;
  const draftOrderCompleteErrors = draftOrderCompleteMutation?.errors ?? [];

  if (draftOrderCompleteErrors.length > 0) {
    return err(
      new DraftOrderCompleteFailedError(
        `draftOrderComplete returned errors: ${formatGraphqlErrors(draftOrderCompleteErrors)}`,
      ),
    );
  }

  const completedOrderId = draftOrderCompleteMutation?.order?.id ?? draftOrderId;

  /*
   * Step 3: transactionCreate.
   * `invoice.amount_paid` is in the smallest currency unit (cents for USD).
   * `MoneyInput.amount` is `PositiveDecimal` (codegen scalar = number) so we
   * must convert cents → major units. Stripe currencies have varying decimal
   * counts; for USD it's 2. The full currency-aware conversion lives in
   * `SaleorMoney.createFromStripe`, but we don't need a SaleorMoney instance
   * here — only the float value. Using `amount / 100` is correct for USD and
   * every other 2-decimal currency we ship in v1.
   */
  const amountCents = invoice.amount_paid;
  const currencyUpper = invoice.currency.toUpperCase();
  const amountMajor = amountCents / 100;

  let transactionCreateResult;

  try {
    transactionCreateResult = await graphqlClient.mutation(SubscriptionTransactionCreateDocument, {
      id: completedOrderId,
      transaction: {
        name: "Stripe Subscription",
        pspReference: stripeChargeId,
        amountCharged: {
          amount: amountMajor,
          currency: currencyUpper,
        },
        availableActions: ["REFUND"],
      },
    });
  } catch (e) {
    return err(
      new TransactionCreateFailedError("Network error calling transactionCreate", { cause: e }),
    );
  }

  if (transactionCreateResult.error) {
    return err(
      new TransactionCreateFailedError("GraphQL transport error on transactionCreate", {
        cause: transactionCreateResult.error,
      }),
    );
  }

  const transactionCreateMutation = transactionCreateResult.data?.transactionCreate;
  const transactionCreateErrors = transactionCreateMutation?.errors ?? [];

  if (transactionCreateErrors.length > 0) {
    return err(
      new TransactionCreateFailedError(
        `transactionCreate returned errors: ${formatGraphqlErrors(transactionCreateErrors)}`,
      ),
    );
  }

  if (!transactionCreateMutation?.transaction?.id) {
    return err(new TransactionCreateFailedError("transactionCreate returned no transaction.id"));
  }

  logger.info("Minted Saleor order from Stripe invoice", {
    saleorOrderId: completedOrderId,
    stripeChargeId,
    stripeInvoiceId: invoice.id,
    amountCents,
    currency: currencyUpper,
  });

  return ok({
    saleorOrderId: completedOrderId,
    stripeChargeId,
    amountCents,
    currency: currencyUpper,
  });
}

/**
 * Class wrapper for DI parity with the rest of the app (e.g. `TransactionEventReporter`).
 * The function-style export above is the primary surface; T14 may use either.
 */
export class SaleorOrderFromInvoice implements ISaleorOrderFromInvoice {
  async mintOrderFromInvoice(
    args: MintOrderFromInvoiceArgs,
  ): Promise<Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>> {
    return mintOrderFromInvoice(args);
  }
}
