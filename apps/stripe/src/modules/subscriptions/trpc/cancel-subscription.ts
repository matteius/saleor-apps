/**
 * tRPC handler for `subscriptions.cancel`.
 *
 * Input: { stripeSubscriptionId, immediate? }. Default behavior sets
 * `cancel_at_period_end=true`; `immediate=true` calls
 * `stripe.subscriptions.cancel`. Updates DynamoDB cache and notifies
 * OwlBooks via the webhook bridge.
 *
 * To be fully implemented in T21.
 */

export const TODO_T21_CANCEL_SUBSCRIPTION = "implement in T21";

export interface CancelSubscriptionInput {
  stripeSubscriptionId: string;
  immediate?: boolean;
}

export interface CancelSubscriptionOutput {
  stripeSubscriptionId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}
