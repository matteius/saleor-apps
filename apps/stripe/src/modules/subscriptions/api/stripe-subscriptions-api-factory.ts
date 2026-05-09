/**
 * Factory for `IStripeSubscriptionsApi` and `IStripeCustomerApi` instances.
 *
 * Mirrors `stripe-payment-intents-api-factory.ts`: produces API wrappers
 * scoped to a Stripe restricted key for a single Saleor installation. Both
 * APIs are produced from the same factory because callers (T20–T23) typically
 * need them together (resolve customer → create subscription).
 */
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

import { type IStripeCustomerApi, StripeCustomerApi } from "./stripe-customer-api";
import { type IStripeSubscriptionsApi, StripeSubscriptionsApi } from "./stripe-subscriptions-api";

export interface IStripeSubscriptionsApiFactory {
  createSubscriptionsApi(args: { key: StripeRestrictedKey }): IStripeSubscriptionsApi;
  createCustomerApi(args: { key: StripeRestrictedKey }): IStripeCustomerApi;
}

export class StripeSubscriptionsApiFactory implements IStripeSubscriptionsApiFactory {
  createSubscriptionsApi(args: { key: StripeRestrictedKey }): IStripeSubscriptionsApi {
    return StripeSubscriptionsApi.createFromKey({ key: args.key });
  }

  createCustomerApi(args: { key: StripeRestrictedKey }): IStripeCustomerApi {
    return StripeCustomerApi.createFromKey({ key: args.key });
  }
}
