import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { StripeCardError, StripeInvalidRequestError } from "@/modules/stripe/stripe-api-error";
import { StripeClient } from "@/modules/stripe/stripe-client";

import { StripeCustomerApi } from "./stripe-customer-api";

describe("StripeCustomerApi", () => {
  describe("createCustomer", () => {
    it("Calls Stripe SDK customers.create with email + Fief/Saleor metadata + address + idempotencyKey", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "create").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "cus_TEST" },
      );

      await instance.createCustomer({
        email: "user@example.com",
        fiefUserId: "fief-abc",
        saleorUserId: "U2VydXNlcjox",
        address: {
          line1: "1 Main St",
          city: "Springfield",
          state: "IL",
          postal_code: "62704",
          country: "US",
        },
        idempotencyKey: "create-cus-IK",
      });

      expect(clientWrapper.nativeClient.customers.create).toHaveBeenCalledExactlyOnceWith(
        {
          email: "user@example.com",
          metadata: {
            fiefUserId: "fief-abc",
            saleorUserId: "U2VydXNlcjox",
          },
          address: {
            line1: "1 Main St",
            city: "Springfield",
            state: "IL",
            postal_code: "62704",
            country: "US",
          },
        },
        { idempotencyKey: "create-cus-IK" },
      );
    });

    it("Omits address when not supplied", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "create").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "cus_TEST" },
      );

      await instance.createCustomer({
        email: "user@example.com",
        fiefUserId: "fief-abc",
        saleorUserId: "U2VydXNlcjox",
        idempotencyKey: "IK",
      });

      const callArgs = vi.mocked(clientWrapper.nativeClient.customers.create).mock.calls[0];

      expect(callArgs[0]).not.toHaveProperty("address");
    });

    it("Returns Err with mapped Stripe API error when SDK throws", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "create").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "bad email",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.createCustomer({
        email: "user@example.com",
        fiefUserId: "fief-abc",
        saleorUserId: "U2VydXNlcjox",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });
  });

  describe("updateCustomer", () => {
    it("Calls Stripe SDK customers.update with patch and idempotencyKey", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "update").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "cus_TEST" },
      );

      await instance.updateCustomer({
        customerId: "cus_TEST",
        patch: {
          email: "new@example.com",
          metadata: { saleorUserId: "U2VydXNlcjoy" },
        },
        idempotencyKey: "update-IK",
      });

      expect(clientWrapper.nativeClient.customers.update).toHaveBeenCalledExactlyOnceWith(
        "cus_TEST",
        {
          email: "new@example.com",
          metadata: { saleorUserId: "U2VydXNlcjoy" },
        },
        { idempotencyKey: "update-IK" },
      );
    });

    it("Returns Err on Stripe SDK error", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "update").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "no such customer",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.updateCustomer({
        customerId: "cus_TEST",
        patch: { email: "x@y.z" },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });
  });

  describe("retrieveCustomer", () => {
    it("Calls Stripe SDK customers.retrieve with id", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "retrieve").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "cus_TEST" },
      );

      await instance.retrieveCustomer({ customerId: "cus_TEST" });

      expect(clientWrapper.nativeClient.customers.retrieve).toHaveBeenCalledExactlyOnceWith(
        "cus_TEST",
      );
    });

    it("Returns Err on Stripe SDK error", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeCustomerApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.customers, "retrieve").mockRejectedValue(
        new Stripe.errors.StripeCardError({
          message: "card",
          type: "card_error",
          code: "card_declined",
        }),
      );

      const result = await instance.retrieveCustomer({ customerId: "cus_TEST" });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeCardError);
    });
  });

  describe("createFromKey", () => {
    it("creates instance of StripeCustomerApi", () => {
      const api = StripeCustomerApi.createFromKey({ key: mockedStripeRestrictedKey });

      expect(api).toBeInstanceOf(StripeCustomerApi);
    });
  });
});
