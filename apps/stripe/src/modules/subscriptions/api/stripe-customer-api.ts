/**
 * Stripe Customer API wrapper.
 *
 * Wraps `Stripe.customers.*` SDK calls with `neverthrow` Result types,
 * mapping Stripe SDK errors to typed `StripeApiError` subclasses via
 * `mapStripeErrorToApiError` (matches the pattern from
 * `modules/stripe/stripe-payment-intents-api.ts`).
 *
 * Used to create and resolve Stripe customers from a Fief user identity.
 * `createCustomer` writes `fiefUserId` and `saleorUserId` into Stripe metadata
 * so webhooks can reverse-resolve the OwlBooks user without an extra DB hit.
 */
import { type Result, ResultAsync } from "neverthrow";
import type Stripe from "stripe";

import { mapStripeErrorToApiError, type StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

export interface CustomerAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postal_code: string;
  country: string;
}

export interface CreateCustomerArgs {
  email: string;
  fiefUserId: string;
  saleorUserId: string;
  address?: CustomerAddress;
  /** Additional metadata merged on top of `fiefUserId` + `saleorUserId`. */
  extraMetadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface UpdateCustomerArgs {
  customerId: string;
  patch: Stripe.CustomerUpdateParams;
  idempotencyKey?: string;
}

export interface RetrieveCustomerArgs {
  customerId: string;
}

export interface IStripeCustomerApi {
  createCustomer(args: CreateCustomerArgs): Promise<Result<Stripe.Customer, StripeApiError>>;
  updateCustomer(args: UpdateCustomerArgs): Promise<Result<Stripe.Customer, StripeApiError>>;
  retrieveCustomer(
    args: RetrieveCustomerArgs,
  ): Promise<Result<Stripe.Customer | Stripe.DeletedCustomer, StripeApiError>>;
}

export class StripeCustomerApi implements IStripeCustomerApi {
  private stripeApiWrapper: Pick<Stripe, "customers">;

  private constructor(stripeApiWrapper: Pick<Stripe, "customers">) {
    this.stripeApiWrapper = stripeApiWrapper;
  }

  static createFromKey(args: { key: StripeRestrictedKey }) {
    const stripeApiWrapper = StripeClient.createFromRestrictedKey(args.key);

    return new StripeCustomerApi(stripeApiWrapper.nativeClient);
  }

  static createFromClient(client: StripeClient) {
    return new StripeCustomerApi(client.nativeClient);
  }

  async createCustomer(args: CreateCustomerArgs): Promise<Result<Stripe.Customer, StripeApiError>> {
    const params: Stripe.CustomerCreateParams = {
      email: args.email,
      metadata: {
        fiefUserId: args.fiefUserId,
        saleorUserId: args.saleorUserId,
        ...args.extraMetadata,
      },
      ...(args.address && { address: args.address }),
    };

    return ResultAsync.fromPromise(
      this.stripeApiWrapper.customers.create(params, {
        idempotencyKey: args.idempotencyKey,
      }),
      (error) => mapStripeErrorToApiError(error),
    );
  }

  async updateCustomer(args: UpdateCustomerArgs): Promise<Result<Stripe.Customer, StripeApiError>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.customers.update(args.customerId, args.patch, {
        idempotencyKey: args.idempotencyKey,
      }),
      (error) => mapStripeErrorToApiError(error),
    );
  }

  async retrieveCustomer(
    args: RetrieveCustomerArgs,
  ): Promise<Result<Stripe.Customer | Stripe.DeletedCustomer, StripeApiError>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.customers.retrieve(args.customerId),
      (error) => mapStripeErrorToApiError(error),
    );
  }
}
