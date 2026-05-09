/**
 * RED-phase Vitest for T21 — `CancelSubscriptionHandler`.
 *
 * Tests the deps-injected handler in isolation. The dashboard tRPC router
 * (T19) and internal storefront router (T19a) wire it into their procedures
 * downstream; this file covers the procedure body only.
 */
import { TRPCError } from "@trpc/server";
import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";

import {
  type CancelSubscriptionArgs,
  type IStripeSubscriptionsApi,
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
import { CancelSubscriptionHandler } from "./cancel-subscription";

const ACCESS_PATTERN = {
  saleorApiUrl: mockedSaleorApiUrl,
  appId: "app_test_T21",
};

const PERIOD_START = new Date("2026-04-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-05-01T00:00:00.000Z");

function buildExistingRecord(
  overrides: Partial<ConstructorParameters<typeof SubscriptionRecord>[0]> = {},
): SubscriptionRecord {
  return new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId("sub_T21_existing"),
    stripeCustomerId: createStripeCustomerId("cus_T21_existing"),
    saleorChannelSlug: createSaleorChannelSlug("default-channel"),
    saleorUserId: "saleor_user_T21",
    fiefUserId: createFiefUserId("fief_user_T21"),
    stripePriceId: createStripePriceId("price_T21_default"),
    status: "active",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });
}

function buildStripeSubscription(
  overrides: Partial<{
    id: string;
    status: Stripe.Subscription.Status;
    cancelAtPeriodEnd: boolean;
    canceledAt: number | null;
  }> = {},
): Stripe.Subscription {
  return {
    id: overrides.id ?? "sub_T21_existing",
    object: "subscription",
    status: overrides.status ?? "active",
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? true,
    canceled_at: overrides.canceledAt ?? null,
    customer: "cus_T21_existing",
  } as unknown as Stripe.Subscription;
}

interface Harness {
  handler: CancelSubscriptionHandler;
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
    cancelResult?: Awaited<ReturnType<IStripeSubscriptionsApi["cancelSubscription"]>>;
  } = {},
): Harness {
  const stripeSubscriptionsApi = {
    createSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    cancelSubscription: vi
      .fn()
      .mockResolvedValue(opts.cancelResult ?? ok(buildStripeSubscription())),
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

  const handler = new CancelSubscriptionHandler({
    stripeSubscriptionsApi: stripeSubscriptionsApi as unknown as IStripeSubscriptionsApi,
    subscriptionRepo: subscriptionRepo as unknown as SubscriptionRepo,
    accessPattern: ACCESS_PATTERN,
  });

  return { handler, stripeSubscriptionsApi, subscriptionRepo };
}

describe("CancelSubscriptionHandler.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("default (immediate omitted) calls cancelSubscription with immediate=false", async () => {
    const h = buildHarness();

    const result = await h.handler.execute({ stripeSubscriptionId: "sub_T21_existing" });

    expect(h.stripeSubscriptionsApi.cancelSubscription).toHaveBeenCalledTimes(1);

    const args = h.stripeSubscriptionsApi.cancelSubscription.mock
      .calls[0][0] as CancelSubscriptionArgs;

    expect(args.subscriptionId).toBe("sub_T21_existing");
    expect(args.immediate ?? false).toBe(false);
    expect(result.status).toBe("active");
  });

  it("immediate=false explicitly still goes through the cancelAtPeriodEnd path", async () => {
    const h = buildHarness();

    await h.handler.execute({ stripeSubscriptionId: "sub_T21_existing", immediate: false });

    const args = h.stripeSubscriptionsApi.cancelSubscription.mock
      .calls[0][0] as CancelSubscriptionArgs;

    expect(args.immediate ?? false).toBe(false);
  });

  it("immediate=true forwards immediate flag to T7 wrapper (which calls subscriptions.cancel)", async () => {
    const h = buildHarness({
      cancelResult: ok(
        buildStripeSubscription({
          status: "canceled",
          cancelAtPeriodEnd: false,
          canceledAt: 1_700_000_000,
        }),
      ),
    });

    const result = await h.handler.execute({
      stripeSubscriptionId: "sub_T21_existing",
      immediate: true,
    });

    const args = h.stripeSubscriptionsApi.cancelSubscription.mock
      .calls[0][0] as CancelSubscriptionArgs;

    expect(args.immediate).toBe(true);
    expect(result.status).toBe("canceled");
  });

  it("updates DynamoDB cache after successful default cancel (cancelAtPeriodEnd=true)", async () => {
    const h = buildHarness();

    await h.handler.execute({ stripeSubscriptionId: "sub_T21_existing" });

    expect(h.subscriptionRepo.getBySubscriptionId).toHaveBeenCalledTimes(1);
    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const written = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    expect(written.cancelAtPeriodEnd).toBe(true);
    expect(written.status).toBe("active");
  });

  it("updates DynamoDB cache to status=canceled after immediate cancel", async () => {
    const h = buildHarness({
      cancelResult: ok(
        buildStripeSubscription({
          status: "canceled",
          cancelAtPeriodEnd: false,
        }),
      ),
    });

    await h.handler.execute({
      stripeSubscriptionId: "sub_T21_existing",
      immediate: true,
    });

    const written = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    expect(written.status).toBe("canceled");
  });

  it("returns INTERNAL_SERVER_ERROR TRPCError when Stripe cancel fails", async () => {
    const h = buildHarness({
      cancelResult: err(new StripeAPIError("simulated stripe outage")),
    });

    await expect(
      h.handler.execute({ stripeSubscriptionId: "sub_T21_existing" }),
    ).rejects.toMatchObject({
      name: "TRPCError",
      code: "INTERNAL_SERVER_ERROR",
    });

    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the subscription is missing from the cache", async () => {
    const h = buildHarness({ existingRecord: null });

    await expect(
      h.handler.execute({ stripeSubscriptionId: "sub_does_not_exist" }),
    ).rejects.toMatchObject({
      name: "TRPCError",
      code: "NOT_FOUND",
    });

    expect(h.stripeSubscriptionsApi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("does NOT crash when DynamoDB cache write fails after successful Stripe cancel — webhook will reconcile", async () => {
    const h = buildHarness();

    h.subscriptionRepo.upsert.mockResolvedValue(
      err(new SubscriptionRepoError.FailedWritingSubscriptionError("ddb down")),
    );

    const result = await h.handler.execute({ stripeSubscriptionId: "sub_T21_existing" });

    expect(result.status).toBe("active");
  });

  it("propagates wrapped StripeApiError through TRPCError.cause", async () => {
    const stripeErr = new StripeAPIError("rate limited");
    const h = buildHarness({ cancelResult: err(stripeErr) });

    let caught: unknown;

    try {
      await h.handler.execute({ stripeSubscriptionId: "sub_T21_existing" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).cause).toBe(stripeErr);
  });
});
