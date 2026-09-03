import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

import { selectSubscriptionStripeConfig } from "./subscription-stripe-config-selector";

const configurations = [{ id: "config-one" }, { id: "config-two" }];

describe("selectSubscriptionStripeConfig", () => {
  it("selects the explicitly configured Stripe configuration", () => {
    expect(selectSubscriptionStripeConfig(configurations, "config-two")).toBe(configurations[1]);
  });

  it("fails closed when the configured Stripe configuration is missing", () => {
    expect(() => selectSubscriptionStripeConfig(configurations, "missing")).toThrow(TRPCError);
  });

  it("allows an unambiguous single installed configuration", () => {
    expect(selectSubscriptionStripeConfig([configurations[0]!])).toBe(configurations[0]);
  });

  it("rejects ambiguous configuration order", () => {
    expect(() => selectSubscriptionStripeConfig(configurations)).toThrow(
      "Multiple Stripe configurations are installed",
    );
  });
});
