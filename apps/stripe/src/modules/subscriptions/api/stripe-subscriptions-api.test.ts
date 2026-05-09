import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import {
  StripeAuthenticationError,
  StripeInvalidRequestError,
} from "@/modules/stripe/stripe-api-error";
import { StripeClient } from "@/modules/stripe/stripe-client";

import { StripeSubscriptionsApi } from "./stripe-subscriptions-api";

describe("StripeSubscriptionsApi", () => {
  describe("createSubscription", () => {
    it("Calls Stripe SDK subscriptions.create with default_incomplete + automatic_tax + expand + idempotencyKey", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "create").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST" },
      );

      await instance.createSubscription({
        customerId: "cus_TEST",
        priceId: "price_TEST",
        idempotencyKey: "sub-IK",
        metadata: { fiefUserId: "fief-abc" },
      });

      expect(clientWrapper.nativeClient.subscriptions.create).toHaveBeenCalledExactlyOnceWith(
        {
          customer: "cus_TEST",
          items: [{ price: "price_TEST" }],
          payment_behavior: "default_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          automatic_tax: { enabled: true },
          expand: ["latest_invoice.payment_intent"],
          metadata: { fiefUserId: "fief-abc" },
        },
        { idempotencyKey: "sub-IK" },
      );
    });

    it("Omits metadata when not provided", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "create").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST" },
      );

      await instance.createSubscription({
        customerId: "cus_TEST",
        priceId: "price_TEST",
      });

      const callArgs = vi.mocked(clientWrapper.nativeClient.subscriptions.create).mock.calls[0];

      expect(callArgs[0]).not.toHaveProperty("metadata");
    });

    it("Returns Err on Stripe SDK error", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "create").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "no such price",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.createSubscription({
        customerId: "cus_TEST",
        priceId: "price_BAD",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });
  });

  describe("updateSubscription", () => {
    it("Replaces items[0].price when newPriceId is provided", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "retrieve").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST", items: { data: [{ id: "si_existing" }] } },
      );
      vi.spyOn(clientWrapper.nativeClient.subscriptions, "update").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST" },
      );

      await instance.updateSubscription({
        subscriptionId: "sub_TEST",
        newPriceId: "price_NEW",
        prorationBehavior: "create_prorations",
        idempotencyKey: "upd-IK",
      });

      expect(clientWrapper.nativeClient.subscriptions.update).toHaveBeenCalledExactlyOnceWith(
        "sub_TEST",
        {
          items: [{ id: "si_existing", price: "price_NEW" }],
          proration_behavior: "create_prorations",
        },
        { idempotencyKey: "upd-IK" },
      );
    });

    it("Returns Err on Stripe SDK error during update", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "retrieve").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST", items: { data: [{ id: "si_existing" }] } },
      );
      vi.spyOn(clientWrapper.nativeClient.subscriptions, "update").mockRejectedValue(
        new Stripe.errors.StripeAuthenticationError({
          message: "bad key",
          type: "authentication_error",
        }),
      );

      const result = await instance.updateSubscription({
        subscriptionId: "sub_TEST",
        newPriceId: "price_NEW",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeAuthenticationError);
    });
  });

  describe("cancelSubscription", () => {
    it("Calls subscriptions.cancel when immediate=true", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "cancel").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST", status: "canceled" },
      );

      await instance.cancelSubscription({
        subscriptionId: "sub_TEST",
        immediate: true,
        idempotencyKey: "cancel-IK",
      });

      expect(clientWrapper.nativeClient.subscriptions.cancel).toHaveBeenCalledExactlyOnceWith(
        "sub_TEST",
        undefined,
        { idempotencyKey: "cancel-IK" },
      );
    });

    it("Calls subscriptions.update with cancel_at_period_end when immediate is falsy", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "update").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST" },
      );

      await instance.cancelSubscription({
        subscriptionId: "sub_TEST",
        idempotencyKey: "cancel-IK",
      });

      expect(clientWrapper.nativeClient.subscriptions.update).toHaveBeenCalledExactlyOnceWith(
        "sub_TEST",
        { cancel_at_period_end: true },
        { idempotencyKey: "cancel-IK" },
      );
    });

    it("Returns Err on Stripe SDK error", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "cancel").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "already canceled",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.cancelSubscription({
        subscriptionId: "sub_TEST",
        immediate: true,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });
  });

  describe("retrieveSubscription", () => {
    it("Calls Stripe SDK subscriptions.retrieve with id", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "retrieve").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "sub_TEST" },
      );

      await instance.retrieveSubscription({ subscriptionId: "sub_TEST" });

      expect(clientWrapper.nativeClient.subscriptions.retrieve).toHaveBeenCalledExactlyOnceWith(
        "sub_TEST",
      );
    });

    it("Returns Err on Stripe SDK error", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.subscriptions, "retrieve").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "no such sub",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.retrieveSubscription({ subscriptionId: "sub_BAD" });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });
  });

  describe("createBillingPortalSession", () => {
    it("Calls Stripe SDK billingPortal.sessions.create with customer + return_url", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.billingPortal.sessions, "create").mockResolvedValue(
        // @ts-expect-error - test stub
        { id: "bps_TEST", url: "https://billing.stripe.com/session/test" },
      );

      await instance.createBillingPortalSession({
        customerId: "cus_TEST",
        returnUrl: "https://owlbooks.ai/settings/billing",
      });

      expect(
        clientWrapper.nativeClient.billingPortal.sessions.create,
      ).toHaveBeenCalledExactlyOnceWith({
        customer: "cus_TEST",
        return_url: "https://owlbooks.ai/settings/billing",
      });
    });

    it("Returns Err on Stripe SDK error", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripeSubscriptionsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.billingPortal.sessions, "create").mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          message: "no portal config",
          type: "invalid_request_error",
        }),
      );

      const result = await instance.createBillingPortalSession({
        customerId: "cus_TEST",
        returnUrl: "https://owlbooks.ai/settings/billing",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeInvalidRequestError);
    });
  });

  describe("createFromKey", () => {
    it("creates instance of StripeSubscriptionsApi", () => {
      const api = StripeSubscriptionsApi.createFromKey({ key: mockedStripeRestrictedKey });

      expect(api).toBeInstanceOf(StripeSubscriptionsApi);
    });
  });
});
