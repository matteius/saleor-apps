/**
 * Handler for `invoice.{paid,payment_failed}` (and friends) events.
 *
 * - `invoice.paid` (T14): the Saleor order mint. Idempotency-checked against
 *   `lastInvoiceId` in DynamoDB cache, then against Postgres
 *   `SaleorOrderImport.stripeInvoiceId @unique` (T31).
 * - `invoice.payment_failed` (T16): update status to PAST_DUE, no Saleor
 *   call.
 *
 * To be fully implemented in T14 and T16.
 */
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

export const TODO_T14_INVOICE_HANDLER = "implement in T14";
export const TODO_T16_INVOICE_HANDLER = "implement in T16";

export interface InvoiceHandlerSuccess {
  readonly _tag: "InvoiceHandlerSuccess";
  readonly stripeInvoiceId: string;
  readonly mintedSaleorOrderId: string | null;
}

export class InvoiceHandler {
  async handleInvoicePaid(
    _event: Stripe.InvoicePaidEvent,
  ): Promise<Result<InvoiceHandlerSuccess, InstanceType<typeof BaseError>>> {
    return err(new BaseError("T14 not implemented"));
  }

  async handleInvoicePaymentFailed(
    _event: Stripe.InvoicePaymentFailedEvent,
  ): Promise<Result<InvoiceHandlerSuccess, InstanceType<typeof BaseError>>> {
    return err(new BaseError("T16 not implemented"));
  }
}
