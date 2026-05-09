/**
 * RED-phase Vitest for T21 — `ChangePlanHandler`.
 *
 * Switches a subscription to a new Stripe price. The proration invoice is
 * minted by Stripe and arrives on `invoice.paid` shortly after; T14 handles
 * the corresponding Saleor order. We do NOT mint here.
 */
import { TRPCError } from "@trpc/server";
import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";

import {
  type IStripeSubscriptionsApi,
  type UpdateSubscriptionArgs,
} from "../api/stripe-subscriptions-api";
import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import { type SubscriptionRepo, SubscriptionRepoError } from "../repositories/subscription-repo";
import { ChangePlanHandler } from "./change-plan";

const ACCESS_PATTERN = {
  saleorApiUrl: mockedSaleorApiUrl,
  appId: "app_test_T21",
};

const PERIOD_END_TS = 1_714_521_600;

function buildExistingRecord(
  overrides: Partial<ConstructorParameters<typeof SubscriptionRecord>[0]> = {},
): SubscriptionRecord {
  return new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId("sub_T21_change"),
    stripeCustomerId: createStripeCustomerId("cus_T21_change"),
    saleorChannelSlug: createSaleorChannelSlug("default-channel"),
    saleorUserId: "saleor_user_T21",
    fiefUserId: createFiefUserId("fief_user_T21"),
    stripePriceId: createStripePriceId("price_starter_monthly"),
    status: "active",
    currentPeriodStart: new Date("2026-04-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-05-01T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });
}

function buildUpdatedSubscription(
  overrides: Partial<{
    id: string;
    status: Stripe.Subscription.Status;
    priceId: string;
    currentPeriodEnd: number;
  }> = {},
): Stripe.Subscription {
  return {
    id: overrides.id ?? "sub_T21_change",
    object: "subscription",
    status: overrides.status ?? "active",
    cancel_at_period_end: false,
    customer: "cus_T21_change",
    items: {
      object: "list",
      data: [
        {
          id: "si_T21_change_item",
          object: "subscription_item",
          current_period_start: 1_711_929_600,
          current_period_end: overrides.currentPeriodEnd ?? PERIOD_END_TS,
          price: {
            id: overrides.priceId ?? "price_pro_monthly",
            object: "price",
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

interface Harness {
  handler: ChangePlanHandler;
  stripeSubscriptionsApi: {
    createSubscription: ReturnType<typeof vi.fn>;
    updateSubscription: ReturnType<typeof vi.fn>;
    cancelSubscription: ReturnType<typeof vi.fn>;
    retrieveSubscription: ReturnType<typeof vi.fn>;
    createBillingPortalSession: ReturnType<typeof vi.fn>;
  };
  subscriptionRepo: {
    upsert: ReturnType<typeof vi.fn>;
    getBySubscriptionId: ReturnType<typeof vi.fn>;
    getByCustomerId: ReturnType<typeof vi.fn>;
    getByFiefUserId: ReturnType<typeof vi.fn>;
  };
}

function buildHarness(
  opts: {
    existingRecord?: SubscriptionRecord | null;
    updateResult?: Awaited<ReturnType<IStripeSubscriptionsApi["updateSubscription"]>>;
  } = {},
): Harness {
  const stripeSubscriptionsApi = {
    createSubscription: vi.fn(),
    updateSubscription: vi
      .fn()
      .mockResolvedValue(opts.updateResult ?? ok(buildUpdatedSubscription())),
    cancelSubscription: vi.fn(),
    retrieveSubscription: vi.fn(),
    createBillingPortalSession: vi.fn(),
  };

  const subscriptionRepo = {
    upsert: vi.fn().mockResolvedValue(ok(null)),
    getBySubscriptionId: vi
      .fn()
      .mockResolvedValue(
        ok("existingRecord" in opts ? opts.existingRecord : buildExistingRecord()),
      ),
    getByCustomerId: vi.fn().mockResolvedValue(ok(null)),
    getByFiefUserId: vi.fn().mockResolvedValue(ok(null)),
  };

  const handler = new ChangePlanHandler({
    stripeSubscriptionsApi: stripeSubscriptionsApi as unknown as IStripeSubscriptionsApi,
    subscriptionRepo: subscriptionRepo as unknown as SubscriptionRepo,
    accessPattern: ACCESS_PATTERN,
  });

  return { handler, stripeSubscriptionsApi, subscriptionRepo };
}

describe("ChangePlanHandler.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: calls updateSubscription with new price and default 'create_prorations'", async () => {
    const h = buildHarness();

    const result = await h.handler.execute({
      stripeSubscriptionId: "sub_T21_change",
      newStripePriceId: "price_pro_monthly",
    });

    expect(h.stripeSubscriptionsApi.updateSubscription).toHaveBeenCalledTimes(1);

    const args = h.stripeSubscriptionsApi.updateSubscription.mock
      .calls[0][0] as UpdateSubscriptionArgs;

    expect(args.subscriptionId).toBe("sub_T21_change");
    expect(args.newPriceId).toBe("price_pro_monthly");
    expect(args.prorationBehavior).toBe("create_prorations");

    expect(result.status).toBe("active");
    expect(result.currentPeriodEnd).toBe(new Date(PERIOD_END_TS * 1000).toISOString());
  });

  it("respects explicit prorationBehavior='none'", async () => {
    const h = buildHarness();

    await h.handler.execute({
      stripeSubscriptionId: "sub_T21_change",
      newStripePriceId: "price_pro_monthly",
      prorationBehavior: "none",
    });

    const args = h.stripeSubscriptionsApi.updateSubscription.mock
      .calls[0][0] as UpdateSubscriptionArgs;

    expect(args.prorationBehavior).toBe("none");
  });

  it("updates DynamoDB cache with new stripePriceId on success", async () => {
    const h = buildHarness();

    await h.handler.execute({
      stripeSubscriptionId: "sub_T21_change",
      newStripePriceId: "price_pro_monthly",
    });

    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const written = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    expect(written.stripePriceId).toBe("price_pro_monthly");
    expect(written.stripeSubscriptionId).toBe("sub_T21_change");
  });

  it("returns INTERNAL_SERVER_ERROR TRPCError when Stripe update fails", async () => {
    const h = buildHarness({
      updateResult: err(new StripeAPIError("price not found")),
    });

    await expect(
      h.handler.execute({
        stripeSubscriptionId: "sub_T21_change",
        newStripePriceId: "price_does_not_exist",
      }),
    ).rejects.toMatchObject({
      name: "TRPCError",
      code: "INTERNAL_SERVER_ERROR",
    });

    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the subscription is missing from the cache", async () => {
    const h = buildHarness({ existingRecord: null });

    await expect(
      h.handler.execute({
        stripeSubscriptionId: "sub_missing",
        newStripePriceId: "price_pro_monthly",
      }),
    ).rejects.toMatchObject({
      name: "TRPCError",
      code: "NOT_FOUND",
    });

    expect(h.stripeSubscriptionsApi.updateSubscription).not.toHaveBeenCalled();
  });

  it("returns currentPeriodEnd=null when Stripe response carries no items[0]", async () => {
    const noItemsSub = {
      id: "sub_T21_change",
      object: "subscription",
      status: "active",
      cancel_at_period_end: false,
      customer: "cus_T21_change",
      items: { object: "list", data: [] },
    } as unknown as Stripe.Subscription;

    const h = buildHarness({ updateResult: ok(noItemsSub) });

    const result = await h.handler.execute({
      stripeSubscriptionId: "sub_T21_change",
      newStripePriceId: "price_pro_monthly",
    });

    expect(result.currentPeriodEnd).toBeNull();
  });

  it("does NOT crash when DDB cache write fails — Stripe webhook will reconcile", async () => {
    const h = buildHarness();

    h.subscriptionRepo.upsert.mockResolvedValue(
      err(new SubscriptionRepoError.FailedWritingSubscriptionError("ddb down")),
    );

    const result = await h.handler.execute({
      stripeSubscriptionId: "sub_T21_change",
      newStripePriceId: "price_pro_monthly",
    });

    expect(result.status).toBe("active");
  });

  it("wraps Stripe error as TRPCError.cause", async () => {
    const stripeErr = new StripeAPIError("invalid_request_error");
    const h = buildHarness({ updateResult: err(stripeErr) });

    let caught: unknown;

    try {
      await h.handler.execute({
        stripeSubscriptionId: "sub_T21_change",
        newStripePriceId: "price_pro_monthly",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).cause).toBe(stripeErr);
  });
});
