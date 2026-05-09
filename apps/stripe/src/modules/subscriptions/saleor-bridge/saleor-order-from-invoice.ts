/**
 * Mints a Saleor draft order from a Stripe invoice and records the payment
 * transaction against it. Implementation for plan task T9; tax handling
 * extended in T30.
 *
 * Flow:
 *   1. `draftOrderCreate` — single-line digital draft order against the channel
 *      and Saleor user, with a quantity-1 line for the variant mapped to the
 *      Stripe price. **T30**: the line's `price` (PositiveDecimal, major
 *      units) is set to `amount_paid / 100 / quantity` so the Saleor order
 *      total matches what Stripe actually charged (subtotal + tax). The tax
 *      and subtotal cents are stamped onto the order's `metadata` as
 *      `stripeTaxCents` + `stripeSubtotalCents` for downstream OwlBooks AR
 *      reconciliation.
 *   2. `draftOrderComplete` — promote the draft to a real order.
 *   3. `transactionCreate` — record the Stripe charge against the order with
 *      `name: 'Stripe Subscription'`, `pspReference: stripeChargeId`,
 *      `amountCharged: { amount, currency }`, `availableActions: ['REFUND']`.
 *
 * **T30 — tax-on-Saleor-order strategy.** The PRD enumerated three options:
 *   (a) repurpose `DraftOrderInput.shippingPrice` as a tax field — NOT viable
 *       in Saleor 3.22, the field doesn't exist on either
 *       `DraftOrderCreateInput` or `DraftOrderInput`.
 *   (b) add a separate "Sales Tax" order line — would require provisioning a
 *       dedicated tax variant in the catalog ahead of time, adding ops
 *       overhead.
 *   (c) per-order line price override + metadata — `OrderLineCreateInput.price`
 *       IS available on Saleor 3.22 and accepts a custom per-unit price at
 *       draft-order-create time. We override the catalog price with the
 *       gross-inclusive price (subtotal + tax) so the order total naturally
 *       matches `invoice.amount_paid`, and write the tax+subtotal breakdown
 *       to order `metadata` so AR systems can derive the tax component.
 *       Chosen — single line, single mutation, exact total match by
 *       construction.
 *
 * **Tax mismatch guard.** Before issuing any GraphQL calls, we verify
 * `subtotal + tax === amount_paid` (within a $0.01 tolerance to absorb
 * Stripe's per-jurisdiction rounding). On mismatch we fire Sentry's
 * `captureException` with structured tags and return
 * `Err(TaxMismatchError)` so the webhook handler retries and on-call sees the
 * alert. We never mint a Saleor order whose total disagrees with the Stripe
 * charge — that would corrupt OwlBooks AR.
 *
 * **Channel resolution.** Saleor's `draftOrderCreate` takes `channelId`, not
 * `channelSlug`. The existing `ChannelsFetcher`
 * (`modules/saleor/channel-fetcher.ts`) returns `{id, slug}` for every
 * channel — perfect for slug→id lookup. Callers (T14) pass us a slug; we use
 * `ChannelsFetcher` to resolve to id at mint time. We do not cache the lookup
 * here because Saleor channel-create is rare and the underlying urql client
 * already caches the query in process.
 */
import { captureException as sentryCaptureException } from "@sentry/nextjs";
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

/**
 * Tolerance (in smallest currency unit, i.e. cents for USD) for the
 * Stripe-side rounding drift between `invoice.total_excluding_tax +
 * sum(invoice.total_tax_amounts[].amount)` and `invoice.amount_paid`. Each
 * jurisdiction's tax is computed independently and rounded — sum-of-rounds vs
 * round-of-sum can drift by 1 unit. Anything larger than this signals a real
 * discrepancy that we refuse to mint into Saleor.
 */
const TAX_MISMATCH_TOLERANCE_CENTS = 1;

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

/**
 * T30. Stripe-side `total_excluding_tax + sum(total_tax_amounts) !==
 * amount_paid` (beyond the rounding tolerance). Returned BEFORE any GraphQL
 * mutation runs so we never mint a Saleor order whose total disagrees with
 * the Stripe charge. The webhook handler should treat this as transient (the
 * invoice may be re-delivered with corrected fields) and Stripe's at-least-
 * once delivery will retry; ops investigates via the Sentry alert fired in
 * parallel.
 */
const TaxMismatchError = BaseError.subclass("SaleorOrderFromInvoice.TaxMismatchError", {
  props: {
    _internalName: "SaleorOrderFromInvoice.TaxMismatchError",
  },
});

export const SaleorOrderFromInvoiceError = {
  VariantMappingMissingError,
  ChannelResolutionFailedError,
  SaleorUserMissingError,
  InvoiceMissingChargeError,
  DraftOrderCreateFailedError,
  DraftOrderCompleteFailedError,
  TransactionCreateFailedError,
  TaxMismatchError,
};

export type SaleorOrderFromInvoiceError =
  | InstanceType<typeof VariantMappingMissingError>
  | InstanceType<typeof ChannelResolutionFailedError>
  | InstanceType<typeof SaleorUserMissingError>
  | InstanceType<typeof InvoiceMissingChargeError>
  | InstanceType<typeof DraftOrderCreateFailedError>
  | InstanceType<typeof DraftOrderCompleteFailedError>
  | InstanceType<typeof TransactionCreateFailedError>
  | InstanceType<typeof TaxMismatchError>;

export interface MintOrderFromInvoiceArgs {
  /**
   * The Stripe Invoice that just transitioned to `paid`. T30 reads
   * `total_excluding_tax`, `total_tax_amounts[].amount`, and `amount_paid`
   * to derive the gross-inclusive line price + the
   * `stripeTaxCents`/`stripeSubtotalCents` metadata stamped on the order.
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
  /**
   * T30 — optional Sentry capture function. Fired with structured tags when
   * the Stripe invoice's tax fields disagree with `amount_paid` beyond the
   * rounding tolerance. Defaults to `@sentry/nextjs`'s `captureException` —
   * tests inject a mock to assert on call shape.
   */
  captureException?: typeof sentryCaptureException;
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

/**
 * T30 — Stripe Tax field accessors. Stripe's `Invoice` type evolves across
 * SDK versions; `total_tax_amounts` and `total_excluding_tax` aren't
 * universally on the published type yet, so we widen via intersection at the
 * call site rather than chasing SDK upgrades.
 */
type InvoiceWithTax = Stripe.Invoice & {
  total_tax_amounts?: Array<{ amount: number }> | null;
  total_excluding_tax?: number | null;
};

function sumTaxCents(invoice: InvoiceWithTax): number {
  const taxAmounts = invoice.total_tax_amounts;

  if (!taxAmounts || taxAmounts.length === 0) {
    return 0;
  }

  return taxAmounts.reduce((s, t) => s + t.amount, 0);
}

/**
 * Subtotal in smallest currency unit. Prefers Stripe's
 * `total_excluding_tax`; falls back to `amount_paid - taxSum` when Stripe
 * omits the field (older API versions, or invoices created before tax was
 * enabled on the account).
 */
function deriveSubtotalCents(invoice: InvoiceWithTax, taxCents: number): number {
  if (typeof invoice.total_excluding_tax === "number") {
    return invoice.total_excluding_tax;
  }

  return invoice.amount_paid - taxCents;
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
  const {
    invoice,
    subscriptionRecord,
    saleorChannelSlug,
    saleorVariantId,
    graphqlClient,
    captureException = sentryCaptureException,
  } = args;

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
   * T30 — Stripe Tax line copying. Compute the tax + subtotal cents and
   * confirm they reconcile to `amount_paid` within rounding tolerance BEFORE
   * we touch Saleor. On mismatch we Sentry-alert and bail without minting an
   * order. The webhook handler returns `Err` and Stripe at-least-once
   * delivery will retry; ops investigates via the alert.
   */
  const invoiceWithTax = invoice as InvoiceWithTax;
  const taxCents = sumTaxCents(invoiceWithTax);
  const subtotalCents = deriveSubtotalCents(invoiceWithTax, taxCents);
  const expectedTotalCents = subtotalCents + taxCents;
  const actualTotalCents = invoice.amount_paid;
  const deltaCents = Math.abs(actualTotalCents - expectedTotalCents);

  if (deltaCents > TAX_MISMATCH_TOLERANCE_CENTS) {
    const mismatchError = new TaxMismatchError(
      `Tax mismatch on invoice ${invoice.id}: subtotal(${subtotalCents}) + tax(${taxCents}) = ${expectedTotalCents}, but amount_paid = ${actualTotalCents} (delta = ${deltaCents} cents, tolerance = ${TAX_MISMATCH_TOLERANCE_CENTS})`,
    );

    captureException(mismatchError, {
      tags: {
        subsystem: "stripe-subscriptions",
        event: "invoice.paid.tax-mismatch",
        stripeInvoiceId: invoice.id ?? "",
      },
      extra: {
        expectedTotal: actualTotalCents,
        actualTotal: expectedTotalCents,
        deltaCents,
        subtotalCents,
        taxCents,
        currency: invoice.currency,
      },
    });

    logger.error("Refusing to mint Saleor order — Stripe tax fields do not reconcile", {
      stripeInvoiceId: invoice.id,
      subtotalCents,
      taxCents,
      amountPaidCents: actualTotalCents,
      deltaCents,
    });

    return err(mismatchError);
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

  /*
   * T30: gross-inclusive per-unit price = amount_paid / 100 / quantity. We
   * mint a single quantity-1 line per the T9 contract (one variant per
   * subscription price), so this is simply amount_paid / 100. PositiveDecimal
   * accepts a JS number; for non-2-decimal currencies (e.g. JPY which is
   * 0-decimal) this still produces the correct major-unit value because
   * amount_paid is always in the smallest currency unit and we divide by 100
   * — not currency-aware, matching the T9 transactionCreate amountCharged
   * conversion. The deferred currency-aware path lives in
   * `SaleorMoney.createFromStripe`; v1 ships USD-only.
   */
  const lineQuantity = 1;
  const linePriceMajor = invoice.amount_paid / 100 / lineQuantity;

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
            quantity: lineQuantity,
            price: linePriceMajor,
          },
        ],
        externalReference: invoice.id,
        /*
         * T30 — Stripe Tax breakdown stamped onto the order so OwlBooks AR
         * can reconstruct the tax component when ingesting the Saleor order.
         * Both values are integer cents serialized as strings (Saleor
         * MetadataInput.value is `String!`).
         */
        metadata: [
          { key: "stripeTaxCents", value: String(taxCents) },
          { key: "stripeSubtotalCents", value: String(subtotalCents) },
        ],
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
