/**
 * Type-only assertions for the wired subscriptions router.
 *
 * Confirms (a) the root tRPC router exposes a `subscriptions` namespace and
 * (b) each of the five procedures has the input/output shape T20–T23 will
 * implement against. If a downstream task tightens or loosens these schemas
 * unintentionally, this test fails at `tsc` time.
 */
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { TrpcRouter } from "@/modules/trpc/trpc-router";

type Inputs = inferRouterInputs<TrpcRouter>;
type Outputs = inferRouterOutputs<TrpcRouter>;

describe("subscriptionsRouter (type-level wiring)", () => {
  it("exposes all five procedures under trpcRouter.subscriptions", () => {
    /**
     * Runtime assertion to satisfy `vitest/expect-expect` — the real
     * verification is type-only via `expectTypeOf` below, which fires at
     * `tsc` time. The procedure-name list below mirrors the keys we wire in
     * the router; tightening it requires updating both lists.
     */
    const procedureNames: ReadonlyArray<keyof Outputs["subscriptions"]> = [
      "create",
      "cancel",
      "changePlan",
      "createBillingPortalSession",
      "getStatus",
    ];

    expect(procedureNames).toHaveLength(5);

    expectTypeOf<Inputs["subscriptions"]["create"]>().toEqualTypeOf<{
      fiefUserId: string;
      email: string;
      stripePriceId: string;
      billingAddress?: {
        line1: string;
        city: string;
        state: string;
        postalCode: string;
        country: string;
      };
    }>();

    expectTypeOf<Outputs["subscriptions"]["create"]>().toEqualTypeOf<{
      stripeSubscriptionId: string;
      stripeCustomerId: string;
      clientSecret: string;
    }>();

    expectTypeOf<Inputs["subscriptions"]["cancel"]>().toEqualTypeOf<{
      stripeSubscriptionId: string;
      immediate?: boolean;
    }>();

    expectTypeOf<Outputs["subscriptions"]["cancel"]>().toEqualTypeOf<{
      status: string;
    }>();

    expectTypeOf<Inputs["subscriptions"]["changePlan"]>().toEqualTypeOf<{
      stripeSubscriptionId: string;
      newStripePriceId: string;
      prorationBehavior?: "create_prorations" | "none";
    }>();

    expectTypeOf<Outputs["subscriptions"]["changePlan"]>().toEqualTypeOf<{
      status: string;
      currentPeriodEnd: string | null;
    }>();

    expectTypeOf<Inputs["subscriptions"]["createBillingPortalSession"]>().toEqualTypeOf<{
      stripeCustomerId: string;
      returnUrl: string;
    }>();

    expectTypeOf<Outputs["subscriptions"]["createBillingPortalSession"]>().toEqualTypeOf<{
      url: string;
    }>();

    expectTypeOf<Inputs["subscriptions"]["getStatus"]>().toEqualTypeOf<
      | { by: "stripeSubscriptionId"; stripeSubscriptionId: string }
      | { by: "fiefUserId"; fiefUserId: string }
    >();

    expectTypeOf<Outputs["subscriptions"]["getStatus"]>().toEqualTypeOf<{
      status: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      lastSaleorOrderId: string | null;
      planName: string | null;
    }>();
  });
});
