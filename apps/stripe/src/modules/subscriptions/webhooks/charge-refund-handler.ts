/**
 * Subscription-aware extension of the `charge.refunded` handler.
 *
 * On a subscription-origin refund:
 *   - full refund → call Saleor `orderVoid` and mark `SaleorOrderImport.voidedAt`
 *   - partial refund → emit ops alert; do NOT void
 *
 * On a one-shot purchase refund (no `charge.invoice.subscription`), this
 * handler delegates back to the existing `StripeRefundHandler`.
 *
 * The class is the STUBBED INTERFACE that T12's
 * `SubscriptionWebhookUseCase` dispatches to. Method body is intentionally
 * an `Err`-returning placeholder — T17 replaces it in Wave 5.
 */
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

export const TODO_T17_CHARGE_REFUND_HANDLER = "implement in T17";

export interface ChargeRefundHandlerSuccess {
  readonly _tag: "ChargeRefundHandlerSuccess";
  readonly stripeChargeId: string;
  readonly voidedSaleorOrderId: string | null;
}

export type ChargeRefundHandlerError = InstanceType<typeof BaseError>;

export interface IChargeRefundHandler {
  handle(
    event: Stripe.ChargeRefundedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<ChargeRefundHandlerSuccess, ChargeRefundHandlerError>>;
}

export class ChargeRefundHandler implements IChargeRefundHandler {
  async handle(
    _event: Stripe.ChargeRefundedEvent,
    _ctx: SubscriptionWebhookContext,
  ): Promise<Result<ChargeRefundHandlerSuccess, ChargeRefundHandlerError>> {
    return err(new BaseError("Implemented in T17"));
  }
}
