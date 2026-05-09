/**
 * Factory for `IStripeSubscriptionsApi` and `IStripeCustomerApi` instances.
 *
 * Mirrors `stripe-payment-intents-api-factory.ts` — produces an API wrapper
 * scoped to a Stripe restricted key for a single Saleor installation.
 *
 * To be fully implemented in T7.
 */
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

import { type IStripeCustomerApi } from "./stripe-customer-api";
import { type IStripeSubscriptionsApi } from "./stripe-subscriptions-api";

export const TODO_T7_STRIPE_SUBSCRIPTIONS_API_FACTORY = "implement in T7";

export interface IStripeSubscriptionsApiFactory {
  createSubscriptionsApi(args: { key: StripeRestrictedKey }): IStripeSubscriptionsApi;
  createCustomerApi(args: { key: StripeRestrictedKey }): IStripeCustomerApi;
}
