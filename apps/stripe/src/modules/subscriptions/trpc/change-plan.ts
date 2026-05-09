/**
 * tRPC handler for `subscriptions.changePlan`.
 *
 * Input: { stripeSubscriptionId, newPriceId, prorationBehavior? }. Calls
 * `stripe.subscriptions.update({ items: [{ id, price: newPriceId }],
 * proration_behavior: 'create_prorations' })`.
 *
 * To be fully implemented in T21.
 */
import type Stripe from "stripe";

export const TODO_T21_CHANGE_PLAN = "implement in T21";

export interface ChangePlanInput {
  stripeSubscriptionId: string;
  newPriceId: string;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
}

export interface ChangePlanOutput {
  stripeSubscriptionId: string;
  newPriceId: string;
  prorationInvoiceId: string | null;
}
