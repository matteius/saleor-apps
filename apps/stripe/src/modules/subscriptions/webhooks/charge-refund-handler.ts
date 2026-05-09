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
 * To be fully implemented in T17.
 */
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

export const TODO_T17_CHARGE_REFUND_HANDLER = "implement in T17";

export interface ChargeRefundHandlerSuccess {
  readonly _tag: "ChargeRefundHandlerSuccess";
  readonly stripeChargeId: string;
  readonly voidedSaleorOrderId: string | null;
}

export class ChargeRefundHandler {
  async handleChargeRefunded(
    _event: Stripe.ChargeRefundedEvent,
  ): Promise<Result<ChargeRefundHandlerSuccess, InstanceType<typeof BaseError>>> {
    return err(new BaseError("T17 not implemented"));
  }
}
