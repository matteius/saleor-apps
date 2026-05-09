/**
 * tRPC handler for `subscriptions.createBillingPortalSession`.
 *
 * Input: { stripeCustomerId, returnUrl }. Calls
 * `stripe.billingPortal.sessions.create` and returns the portal URL for
 * card updates / cancellation / plan changes / invoice history.
 *
 * To be fully implemented in T22.
 */

export const TODO_T22_BILLING_PORTAL = "implement in T22";

export interface CreateBillingPortalSessionInput {
  stripeCustomerId: string;
  returnUrl: string;
}

export interface CreateBillingPortalSessionOutput {
  url: string;
}
