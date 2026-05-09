/**
 * Mints a Saleor draft order from a Stripe invoice and records the payment
 * transaction against it.
 *
 * Implementation lands in T9 (and is extended in T30 for tax-line copying).
 */
import { type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

import { type SubscriptionRecord } from "../repositories/subscription-record";

export const TODO_T9_SALEOR_ORDER_FROM_INVOICE = "implement in T9";

export const SaleorOrderFromInvoiceError = {
  VariantMappingMissingError: BaseError.subclass(
    "SaleorOrderFromInvoice.VariantMappingMissingError",
    {
      props: {
        _internalName: "SaleorOrderFromInvoice.VariantMappingMissingError",
      },
    },
  ),
  DraftOrderCreateFailedError: BaseError.subclass(
    "SaleorOrderFromInvoice.DraftOrderCreateFailedError",
    {
      props: {
        _internalName: "SaleorOrderFromInvoice.DraftOrderCreateFailedError",
      },
    },
  ),
  TransactionCreateFailedError: BaseError.subclass(
    "SaleorOrderFromInvoice.TransactionCreateFailedError",
    {
      props: {
        _internalName: "SaleorOrderFromInvoice.TransactionCreateFailedError",
      },
    },
  ),
};

export type SaleorOrderFromInvoiceError = InstanceType<
  | typeof SaleorOrderFromInvoiceError.VariantMappingMissingError
  | typeof SaleorOrderFromInvoiceError.DraftOrderCreateFailedError
  | typeof SaleorOrderFromInvoiceError.TransactionCreateFailedError
>;

export interface MintOrderFromInvoiceArgs {
  invoice: Stripe.Invoice;
  subscription: SubscriptionRecord;
  saleorChannelSlug: string;
}

export interface MintOrderFromInvoiceResult {
  saleorOrderId: string;
  amountCents: number;
  taxCents: number;
  currency: string;
}

export interface ISaleorOrderFromInvoice {
  mintOrderFromInvoice(
    args: MintOrderFromInvoiceArgs,
  ): Promise<Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>>;
}
