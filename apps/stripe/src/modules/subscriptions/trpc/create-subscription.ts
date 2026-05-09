/**
 * tRPC handler for `subscriptions.create`.
 *
 * Input: { fiefUserId, email, stripePriceId, billingAddress? }.
 * Resolves Stripe customer + Saleor user, calls
 * `stripe.subscriptions.create` with `payment_behavior='default_incomplete'`,
 * writes the DynamoDB cache record, fans out to OwlBooks via the T28
 * webhook bridge.
 * Returns `{ subscriptionId, clientSecret, customerId }`.
 *
 * To be fully implemented in T20.
 */

export const TODO_T20_CREATE_SUBSCRIPTION = "implement in T20";

export interface CreateSubscriptionInput {
  fiefUserId: string;
  email: string;
  stripePriceId: string;
  billingAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
}

export interface CreateSubscriptionOutput {
  subscriptionId: string;
  clientSecret: string;
  customerId: string;
}
