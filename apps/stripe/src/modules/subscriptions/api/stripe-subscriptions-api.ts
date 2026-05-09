/**
 * Stripe Subscriptions API wrapper.
 *
 * Wraps `Stripe.subscriptions.*` SDK calls with `neverthrow` Result types,
 * matching the pattern from `modules/stripe/stripe-payment-intents-api.ts`.
 *
 * To be fully implemented in T7.
 */
import { type Result } from "neverthrow";
import type Stripe from "stripe";

export const TODO_T7_STRIPE_SUBSCRIPTIONS_API = "implement in T7";

export interface CreateSubscriptionArgs {
  customerId: string;
  priceId: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface UpdateSubscriptionArgs {
  subscriptionId: string;
  newPriceId?: string;
  cancelAtPeriodEnd?: boolean;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
  idempotencyKey?: string;
}

export interface CancelSubscriptionArgs {
  subscriptionId: string;
  immediate?: boolean;
  idempotencyKey?: string;
}

export interface CreateBillingPortalSessionArgs {
  customerId: string;
  returnUrl: string;
}

export interface IStripeSubscriptionsApi {
  createSubscription(args: CreateSubscriptionArgs): Promise<Result<Stripe.Subscription, unknown>>;
  updateSubscription(args: UpdateSubscriptionArgs): Promise<Result<Stripe.Subscription, unknown>>;
  cancelSubscription(args: CancelSubscriptionArgs): Promise<Result<Stripe.Subscription, unknown>>;
  retrieveSubscription(args: {
    subscriptionId: string;
  }): Promise<Result<Stripe.Subscription, unknown>>;
  createBillingPortalSession(
    args: CreateBillingPortalSessionArgs,
  ): Promise<Result<Stripe.BillingPortal.Session, unknown>>;
}
