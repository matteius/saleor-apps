/**
 * Stripe Subscriptions API wrapper.
 *
 * Wraps `Stripe.subscriptions.*` and `Stripe.billingPortal.sessions.*` SDK
 * calls with `neverthrow` Result types, mirroring
 * `modules/stripe/stripe-payment-intents-api.ts`.
 *
 * `createSubscription` always passes the OwlBooks-required knobs:
 *  - `payment_behavior: 'default_incomplete'` so the first invoice waits for
 *    the storefront to confirm a PaymentIntent client secret
 *  - `payment_settings.save_default_payment_method: 'on_subscription'` so the
 *    confirmed payment method is reused for renewals
 *  - `automatic_tax: { enabled: true }` so Stripe Tax computes line-item tax
 *  - `expand: ['latest_invoice.payment_intent']` so the response includes the
 *    client secret without a second round trip.
 *
 * `updateSubscription` swaps the price on `items[0]` — Stripe requires the
 * existing subscription-item id to do an in-place price replacement, so we
 * `retrieve` first then `update`.
 *
 * `cancelSubscription({immediate: true})` calls `subscriptions.cancel`;
 * the default (no flag) sets `cancel_at_period_end: true` so the customer
 * keeps access until the end of the paid period.
 */
import { type Result, ResultAsync } from "neverthrow";
import type Stripe from "stripe";

import { mapStripeErrorToApiError, type StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

export interface CreateSubscriptionArgs {
  customerId: string;
  priceId: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface UpdateSubscriptionArgs {
  subscriptionId: string;
  newPriceId: string;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
  idempotencyKey?: string;
}

export interface CancelSubscriptionArgs {
  subscriptionId: string;
  immediate?: boolean;
  idempotencyKey?: string;
}

export interface RetrieveSubscriptionArgs {
  subscriptionId: string;
}

export interface CreateBillingPortalSessionArgs {
  customerId: string;
  returnUrl: string;
}

export interface IStripeSubscriptionsApi {
  createSubscription(
    args: CreateSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>>;
  updateSubscription(
    args: UpdateSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>>;
  cancelSubscription(
    args: CancelSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>>;
  retrieveSubscription(
    args: RetrieveSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>>;
  createBillingPortalSession(
    args: CreateBillingPortalSessionArgs,
  ): Promise<Result<Stripe.BillingPortal.Session, StripeApiError>>;
}

export class StripeSubscriptionsApi implements IStripeSubscriptionsApi {
  private stripeApiWrapper: Pick<Stripe, "subscriptions" | "billingPortal">;

  private constructor(stripeApiWrapper: Pick<Stripe, "subscriptions" | "billingPortal">) {
    this.stripeApiWrapper = stripeApiWrapper;
  }

  static createFromKey(args: { key: StripeRestrictedKey }) {
    const stripeApiWrapper = StripeClient.createFromRestrictedKey(args.key);

    return new StripeSubscriptionsApi(stripeApiWrapper.nativeClient);
  }

  static createFromClient(client: StripeClient) {
    return new StripeSubscriptionsApi(client.nativeClient);
  }

  async createSubscription(
    args: CreateSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>> {
    const params: Stripe.SubscriptionCreateParams = {
      customer: args.customerId,
      items: [{ price: args.priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      automatic_tax: { enabled: true },
      expand: ["latest_invoice.payment_intent"],
      ...(args.metadata && { metadata: args.metadata }),
    };

    return ResultAsync.fromPromise(
      this.stripeApiWrapper.subscriptions.create(params, {
        idempotencyKey: args.idempotencyKey,
      }),
      (error) => mapStripeErrorToApiError(error),
    );
  }

  async updateSubscription(
    args: UpdateSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>> {
    /*
     * Stripe replaces a price by patching the existing subscription item by
     * id (not by index). Fetch the current subscription so we can target
     * `items.data[0].id`. Round-trip cost is acceptable because plan changes
     * are user-initiated, not webhook-hot.
     */
    const existing = await ResultAsync.fromPromise(
      this.stripeApiWrapper.subscriptions.retrieve(args.subscriptionId),
      (error) => mapStripeErrorToApiError(error),
    );

    if (existing.isErr()) {
      return existing;
    }

    const firstItem = existing.value.items.data[0];

    const params: Stripe.SubscriptionUpdateParams = {
      items: [{ id: firstItem.id, price: args.newPriceId }],
      ...(args.prorationBehavior && { proration_behavior: args.prorationBehavior }),
    };

    return ResultAsync.fromPromise(
      this.stripeApiWrapper.subscriptions.update(args.subscriptionId, params, {
        idempotencyKey: args.idempotencyKey,
      }),
      (error) => mapStripeErrorToApiError(error),
    );
  }

  async cancelSubscription(
    args: CancelSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>> {
    if (args.immediate) {
      return ResultAsync.fromPromise(
        this.stripeApiWrapper.subscriptions.cancel(args.subscriptionId, undefined, {
          idempotencyKey: args.idempotencyKey,
        }),
        (error) => mapStripeErrorToApiError(error),
      );
    }

    return ResultAsync.fromPromise(
      this.stripeApiWrapper.subscriptions.update(
        args.subscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey: args.idempotencyKey },
      ),
      (error) => mapStripeErrorToApiError(error),
    );
  }

  async retrieveSubscription(
    args: RetrieveSubscriptionArgs,
  ): Promise<Result<Stripe.Subscription, StripeApiError>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.subscriptions.retrieve(args.subscriptionId),
      (error) => mapStripeErrorToApiError(error),
    );
  }

  async createBillingPortalSession(
    args: CreateBillingPortalSessionArgs,
  ): Promise<Result<Stripe.BillingPortal.Session, StripeApiError>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.billingPortal.sessions.create({
        customer: args.customerId,
        return_url: args.returnUrl,
      }),
      (error) => mapStripeErrorToApiError(error),
    );
  }
}
