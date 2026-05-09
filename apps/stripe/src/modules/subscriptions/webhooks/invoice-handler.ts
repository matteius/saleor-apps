/**
 * Handler for `invoice.{paid,payment_failed}` events.
 *
 * - `invoice.paid` (T14): the Saleor order mint. Idempotency-checked against
 *   `lastInvoiceId` in DynamoDB cache, then against Postgres
 *   `SaleorOrderImport.stripeInvoiceId @unique` (T31).
 * - `invoice.payment_failed` (T16): update status to PAST_DUE, no Saleor
 *   call.
 *
 * The class is the STUBBED INTERFACE that T12's
 * `SubscriptionWebhookUseCase` dispatches to. Method bodies are intentionally
 * `Err`-returning placeholders — T14 and T16 replace them in Wave 5.
 */
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

export const TODO_T14_INVOICE_HANDLER = "implement in T14";
export const TODO_T16_INVOICE_HANDLER = "implement in T16";

export interface InvoiceHandlerSuccess {
  readonly _tag: "InvoiceHandlerSuccess";
  readonly stripeInvoiceId: string;
  readonly mintedSaleorOrderId: string | null;
}

export type InvoiceHandlerError = InstanceType<typeof BaseError>;

export interface IInvoiceHandler {
  handlePaid(
    event: Stripe.InvoicePaidEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>>;

  handleFailed(
    event: Stripe.InvoicePaymentFailedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>>;
}

export class InvoiceHandler implements IInvoiceHandler {
  async handlePaid(
    _event: Stripe.InvoicePaidEvent,
    _ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>> {
    return err(new BaseError("Implemented in T14"));
  }

  async handleFailed(
    _event: Stripe.InvoicePaymentFailedEvent,
    _ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>> {
    return err(new BaseError("Implemented in T16"));
  }
}
