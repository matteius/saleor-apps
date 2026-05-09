import { describe, expect, it } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";

import { StripeCustomerApi } from "./stripe-customer-api";
import { StripeSubscriptionsApi } from "./stripe-subscriptions-api";
import { StripeSubscriptionsApiFactory } from "./stripe-subscriptions-api-factory";

describe("StripeSubscriptionsApiFactory", () => {
  it("createSubscriptionsApi returns a StripeSubscriptionsApi instance", () => {
    const factory = new StripeSubscriptionsApiFactory();

    const api = factory.createSubscriptionsApi({ key: mockedStripeRestrictedKey });

    expect(api).toBeInstanceOf(StripeSubscriptionsApi);
  });

  it("createCustomerApi returns a StripeCustomerApi instance", () => {
    const factory = new StripeSubscriptionsApiFactory();

    const api = factory.createCustomerApi({ key: mockedStripeRestrictedKey });

    expect(api).toBeInstanceOf(StripeCustomerApi);
  });
});
