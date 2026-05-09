/**
 * Resolves a Saleor User and a Stripe Customer for a Fief user identity.
 *
 * - `resolveSaleorUser` looks up by email, creating a new Saleor customer if
 *   none exists.
 * - `resolveStripeCustomer` looks up by `userSubscription.stripeCustomerId`
 *   first, falling back to creating a new Stripe customer with metadata
 *   linking the Fief and Saleor user IDs.
 *
 * To be fully implemented in T11.
 */
import { type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";

export const TODO_T11_SALEOR_CUSTOMER_RESOLVER = "implement in T11";

export const SaleorCustomerResolverError = {
  SaleorUserCreateFailedError: BaseError.subclass(
    "SaleorCustomerResolver.SaleorUserCreateFailedError",
    {
      props: {
        _internalName: "SaleorCustomerResolver.SaleorUserCreateFailedError",
      },
    },
  ),
  StripeCustomerCreateFailedError: BaseError.subclass(
    "SaleorCustomerResolver.StripeCustomerCreateFailedError",
    {
      props: {
        _internalName: "SaleorCustomerResolver.StripeCustomerCreateFailedError",
      },
    },
  ),
};

export type SaleorCustomerResolverError = InstanceType<
  | typeof SaleorCustomerResolverError.SaleorUserCreateFailedError
  | typeof SaleorCustomerResolverError.StripeCustomerCreateFailedError
>;

export interface ResolveSaleorUserArgs {
  fiefUserId: string;
  email: string;
}

export interface ResolveStripeCustomerArgs {
  fiefUserId: string;
  email: string;
  saleorUserId: string;
  existingStripeCustomerId?: string;
}

export interface ISaleorCustomerResolver {
  resolveSaleorUser(
    args: ResolveSaleorUserArgs,
  ): Promise<Result<{ saleorUserId: string }, SaleorCustomerResolverError>>;

  resolveStripeCustomer(
    args: ResolveStripeCustomerArgs,
  ): Promise<Result<Stripe.Customer, SaleorCustomerResolverError>>;
}
