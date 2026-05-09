import type { Stripe } from "stripe";

export const supportedStripeEvents: Array<Stripe.WebhookEndpointCreateParams.EnabledEvent> = [
  "payment_intent.amount_capturable_updated",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.succeeded",
  "payment_intent.canceled",

  "charge.refund.updated",

  /*
   * T18a: subscription billing events
   * Required by SubscriptionWebhookUseCase (T18) so the dispatcher actually
   * receives subscription/invoice lifecycle webhooks. Without these in
   * enabled_events on webhookEndpoints.create, Stripe never delivers them
   * to the app — even though the dispatcher arms exist in use-case.ts.
   */
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
];
