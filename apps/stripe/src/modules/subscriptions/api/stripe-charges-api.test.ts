/**
 * Tests for StripeChargesApi (T17).
 *
 * Mirrors `stripe-customer-api.test.ts` (T7) — uses the real `StripeClient`
 * factory but spies on `nativeClient.charges.retrieve` so no network call is
 * made. The wrapper must always pass `{expand: ['invoice']}` per T17's
 * requirements.
 */
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import {
  StripeAuthenticationError,
  StripeInvalidRequestError,
} from "@/modules/stripe/stripe-api-error";
import { StripeClient } from "@/modules/stripe/stripe-client";

import { StripeChargesApi, StripeChargesApiFactory } from "./stripe-charges-api";

describe("StripeChargesApi", () => {
  describe("retrieveChargeWithInvoice", () => {
    it("Calls Stripe SDK charges.retrieve with id + expand: ['invoice']", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeChargesApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.charges, "retrieve").mockResolvedValue({
        id: "ch_TEST",
        invoice: { id: "in_TEST", subscription: "sub_TEST" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await instance.retrieveChargeWithInvoice({ chargeId: "ch_TEST" });

      expect(clientWrapper.nativeClient.charges.retrieve).toHaveBeenCalledExactlyOnceWith(
        "ch_TEST",
        { expand: ["invoice"] },
      );
    });

    it("Returns Ok with the charge whose invoice has been expanded to a full Invoice object", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeChargesApi.createFromClient(clientWrapper);

      const expandedInvoice = {
        id: "in_subscription",
        subscription: "sub_abc",
      };

      vi.spyOn(clientWrapper.nativeClient.charges, "retrieve").mockResolvedValue({
        id: "ch_with_invoice",
        amount_captured: 2000,
        amount_refunded: 2000,
        invoice: expandedInvoice,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const result = await instance.retrieveChargeWithInvoice({ chargeId: "ch_with_invoice" });

      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();

      expect(value.id).toBe("ch_with_invoice");
      expect(value.invoice).not.toBeNull();
      expect(value.invoice?.id).toBe("in_subscription");
    });

    it("Returns Ok with invoice=null when the charge has no associated invoice (one-off charge)", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeChargesApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.charges, "retrieve").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "ch_oneoff", amount_captured: 500, amount_refunded: 500, invoice: null },
      );

      const result = await instance.retrieveChargeWithInvoice({ chargeId: "ch_oneoff" });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().invoice).toBeNull();
    });

    it("Returns Err with mapped Stripe API error when SDK throws (unknown charge)", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeChargesApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.charges, "retrieve").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "no such charge",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.retrieveChargeWithInvoice({ chargeId: "ch_nope" });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });

    it("Returns Err on auth failure", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeChargesApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.charges, "retrieve").mockRejectedValue(
        new Stripe.errors.StripeAuthenticationError({
          message: "bad key",
          type: "authentication_error",
        }),
      );

      const result = await instance.retrieveChargeWithInvoice({ chargeId: "ch_auth" });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeAuthenticationError);
    });
  });

  describe("createFromKey", () => {
    it("creates instance of StripeChargesApi", () => {
      const api = StripeChargesApi.createFromKey({ key: mockedStripeRestrictedKey });

      expect(api).toBeInstanceOf(StripeChargesApi);
    });
  });
});

describe("StripeChargesApiFactory", () => {
  it("createChargesApi returns a StripeChargesApi instance for the given key", () => {
    const factory = new StripeChargesApiFactory();
    const api = factory.createChargesApi({ key: mockedStripeRestrictedKey });

    expect(api).toBeInstanceOf(StripeChargesApi);
  });
});
