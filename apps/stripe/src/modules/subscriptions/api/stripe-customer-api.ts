/**
 * Stripe Customer API wrapper.
 *
 * Wraps `Stripe.customers.*` SDK calls with `neverthrow` Result types.
 * Used to create and resolve Stripe customers from a Fief user identity.
 *
 * To be fully implemented in T7.
 */
import { type Result } from "neverthrow";
import type Stripe from "stripe";

export const TODO_T7_STRIPE_CUSTOMER_API = "implement in T7";

export interface CreateCustomerArgs {
  email: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface UpdateCustomerArgs {
  customerId: string;
  email?: string;
  metadata?: Record<string, string>;
}

export interface IStripeCustomerApi {
  createCustomer(args: CreateCustomerArgs): Promise<Result<Stripe.Customer, unknown>>;
  updateCustomer(args: UpdateCustomerArgs): Promise<Result<Stripe.Customer, unknown>>;
  retrieveCustomer(args: {
    customerId: string;
  }): Promise<Result<Stripe.Customer | Stripe.DeletedCustomer, unknown>>;
}
