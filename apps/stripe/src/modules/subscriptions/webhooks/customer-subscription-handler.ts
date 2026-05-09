/**
 * Handler for `customer.subscription.{created,updated,deleted}` events.
 *
 * - `customer.subscription.created` (T13): upsert DynamoDB cache, notify
 *   OwlBooks, do NOT mint a Saleor order (waits for `invoice.paid`).
 * - `customer.subscription.updated` (T15): update status / period dates /
 *   price / `cancel_at_period_end`.
 * - `customer.subscription.deleted` (T15): set status to CANCELLED,
 *   set `paidThrough = currentPeriodEnd`.
 *
 * The class is the STUBBED INTERFACE that T12's
 * `SubscriptionWebhookUseCase` dispatches to. Method bodies are intentionally
 * `Err`-returning placeholders — T13 and T15 replace them in Wave 5.
 */
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

export const TODO_T13_CUSTOMER_SUBSCRIPTION_HANDLER = "implement in T13";
export const TODO_T15_CUSTOMER_SUBSCRIPTION_HANDLER = "implement in T15";

export interface CustomerSubscriptionHandlerSuccess {
  readonly _tag: "CustomerSubscriptionHandlerSuccess";
  readonly stripeSubscriptionId: string;
}

export type CustomerSubscriptionHandlerError = InstanceType<typeof BaseError>;

export interface ICustomerSubscriptionHandler {
  handleCreated(
    event: Stripe.CustomerSubscriptionCreatedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>>;

  handleUpdated(
    event: Stripe.CustomerSubscriptionUpdatedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>>;

  handleDeleted(
    event: Stripe.CustomerSubscriptionDeletedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>>;
}

export class CustomerSubscriptionHandler implements ICustomerSubscriptionHandler {
  async handleCreated(
    _event: Stripe.CustomerSubscriptionCreatedEvent,
    _ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    return err(new BaseError("Implemented in T13"));
  }

  async handleUpdated(
    _event: Stripe.CustomerSubscriptionUpdatedEvent,
    _ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    return err(new BaseError("Implemented in T15"));
  }

  async handleDeleted(
    _event: Stripe.CustomerSubscriptionDeletedEvent,
    _ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    return err(new BaseError("Implemented in T15"));
  }
}
