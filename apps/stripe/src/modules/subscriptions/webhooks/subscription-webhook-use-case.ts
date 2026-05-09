/**
 * Subscription webhook use-case skeleton.
 *
 * Mirrors the shape of `src/app/api/webhooks/stripe/use-case.ts`
 * (`StripeWebhookUseCase`). Dispatches by `event.type` (subscription events
 * have many event types per object, unlike PaymentIntent which dispatches
 * via `event.data.object.object`).
 *
 * Constructor accepts dependency-injected handlers, repos, APIs, and APL.
 * `execute(event)` returns a `Result` whose error type lands fully in T18.
 *
 * To be fully implemented in T12.
 */
import { type APL } from "@saleor/app-sdk/APL";
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";

import { type IStripeSubscriptionsApiFactory } from "../api/stripe-subscriptions-api-factory";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import { type IPriceVariantMapRepo } from "../saleor-bridge/price-variant-map";
import { type ISaleorCustomerResolver } from "../saleor-bridge/saleor-customer-resolver";
import { type ISaleorOrderFromInvoice } from "../saleor-bridge/saleor-order-from-invoice";

export const TODO_T12_SUBSCRIPTION_WEBHOOK_USE_CASE = "implement in T12";

export interface SubscriptionWebhookUseCaseDeps {
  appConfigRepo: AppConfigRepo;
  apl: APL;
  subscriptionRepo: SubscriptionRepo;
  priceVariantMap: IPriceVariantMapRepo;
  saleorOrderFromInvoice: ISaleorOrderFromInvoice;
  saleorCustomerResolver: ISaleorCustomerResolver;
  stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
}

export interface SubscriptionWebhookUseCaseSuccess {
  readonly _tag: "SubscriptionWebhookUseCaseSuccess";
  readonly handledEventType: Stripe.Event["type"];
}

export class SubscriptionWebhookUseCase {
  private deps: SubscriptionWebhookUseCaseDeps;

  constructor(deps: SubscriptionWebhookUseCaseDeps) {
    this.deps = deps;
  }

  // Reference deps so the skeleton compiles strictly even before T12 wires them.
  private getDeps(): SubscriptionWebhookUseCaseDeps {
    return this.deps;
  }

  async execute(
    _event: Stripe.Event,
  ): Promise<Result<SubscriptionWebhookUseCaseSuccess, InstanceType<typeof BaseError>>> {
    void this.getDeps();

    return err(new BaseError("T12 not implemented"));
  }
}
