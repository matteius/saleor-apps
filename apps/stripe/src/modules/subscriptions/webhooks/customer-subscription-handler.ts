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
 * To be fully implemented in T13 and T15.
 */
import { err, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

export const TODO_T13_CUSTOMER_SUBSCRIPTION_HANDLER = "implement in T13";
export const TODO_T15_CUSTOMER_SUBSCRIPTION_HANDLER = "implement in T15";

export interface CustomerSubscriptionHandlerSuccess {
  readonly _tag: "CustomerSubscriptionHandlerSuccess";
  readonly stripeSubscriptionId: string;
}

export class CustomerSubscriptionHandler {
  async handleCreated(
    _event: Stripe.CustomerSubscriptionCreatedEvent,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, InstanceType<typeof BaseError>>> {
    return err(new BaseError("T13 not implemented"));
  }

  async handleUpdated(
    _event: Stripe.CustomerSubscriptionUpdatedEvent,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, InstanceType<typeof BaseError>>> {
    return err(new BaseError("T15 not implemented"));
  }

  async handleDeleted(
    _event: Stripe.CustomerSubscriptionDeletedEvent,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, InstanceType<typeof BaseError>>> {
    return err(new BaseError("T15 not implemented"));
  }
}
