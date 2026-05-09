/**
 * Stripe Charges API wrapper.
 *
 * Wraps `Stripe.charges.*` SDK calls with `neverthrow` Result types,
 * mirroring `stripe-customer-api.ts` (T7) and
 * `modules/stripe/stripe-payment-intents-api.ts`.
 *
 * ## Why a separate wrapper?
 *
 * The `charge.refunded` webhook payload only carries the `Charge` object —
 * the `invoice` field on the charge is just an ID string at that point. T17's
 * handler needs to know whether the refunded charge was for a subscription
 * invoice or a one-shot purchase, which requires the expanded `Invoice`
 * (with `subscription` populated). The cheapest way to discover this is a
 * single `charges.retrieve(id, {expand: ['invoice']})` call on the hot path.
 *
 * ## Return type
 *
 * `retrieveChargeWithInvoice` returns `Result<ChargeWithExpandedInvoice,
 * StripeApiError>`. After the expand, the `invoice` field is either
 * `Stripe.Invoice` or `null` (the latter when the charge has no associated
 * invoice — e.g. a manual one-off `charges.create` outside our flow).
 */
import { type Result, ResultAsync } from "neverthrow";
import type Stripe from "stripe";

import { mapStripeErrorToApiError, type StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

/**
 * The shape of `charges.retrieve(id, {expand: ['invoice']})` — `invoice` is
 * the full `Invoice` object (or null) instead of an ID string.
 *
 * We narrow the SDK's loose `string | Invoice | null` field to the post-expand
 * shape so callers don't have to defensively `typeof === "string"` check.
 */
export type ChargeWithExpandedInvoice = Omit<Stripe.Charge, "invoice"> & {
  invoice: Stripe.Invoice | null;
};

export interface RetrieveChargeWithInvoiceArgs {
  chargeId: string;
}

export interface IStripeChargesApi {
  retrieveChargeWithInvoice(
    args: RetrieveChargeWithInvoiceArgs,
  ): Promise<Result<ChargeWithExpandedInvoice, StripeApiError>>;
}

export class StripeChargesApi implements IStripeChargesApi {
  private stripeApiWrapper: Pick<Stripe, "charges">;

  private constructor(stripeApiWrapper: Pick<Stripe, "charges">) {
    this.stripeApiWrapper = stripeApiWrapper;
  }

  static createFromKey(args: { key: StripeRestrictedKey }) {
    const stripeApiWrapper = StripeClient.createFromRestrictedKey(args.key);

    return new StripeChargesApi(stripeApiWrapper.nativeClient);
  }

  static createFromClient(client: StripeClient) {
    return new StripeChargesApi(client.nativeClient);
  }

  async retrieveChargeWithInvoice(
    args: RetrieveChargeWithInvoiceArgs,
  ): Promise<Result<ChargeWithExpandedInvoice, StripeApiError>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.charges.retrieve(args.chargeId, {
        expand: ["invoice"],
      }),
      (error) => mapStripeErrorToApiError(error),
    ).map((charge) => charge as unknown as ChargeWithExpandedInvoice);
  }
}

/**
 * Factory mirroring {@link IStripeSubscriptionsApiFactory}'s pattern.
 *
 * Kept as a small, single-method factory rather than folded into the existing
 * `StripeSubscriptionsApiFactory` to keep the dependency graph clean — T17's
 * `ChargeRefundHandler` only needs a charges client, not the full
 * subscriptions/customer surface.
 */
export interface IStripeChargesApiFactory {
  createChargesApi(args: { key: StripeRestrictedKey }): IStripeChargesApi;
}

export class StripeChargesApiFactory implements IStripeChargesApiFactory {
  createChargesApi(args: { key: StripeRestrictedKey }): IStripeChargesApi {
    return StripeChargesApi.createFromKey({ key: args.key });
  }
}
