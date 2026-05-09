/**
 * RED-phase Vitest for T20 — `CreateSubscriptionHandler`.
 *
 * Covers the deps-injected handler in isolation. The dashboard tRPC router
 * (T19) and internal storefront router (T19a) wire it into their procedures
 * downstream; this file covers the procedure body only.
 *
 * Mocks:
 *   - `IStripeSubscriptionsApi.createSubscription` (T7)
 *   - `IStripeCustomerApi` (T7)
 *   - `ISaleorCustomerResolver` (T11)
 *   - `SubscriptionRepo.upsert` / `getByFiefUserId` (T8)
 *   - `PriceVariantMapRepo.get` (T10) — used to resolve `saleorChannelSlug`
 *     from the input `stripePriceId`. The OwlBooks design pins each Stripe
 *     price to exactly one Saleor channel via this mapping store.
 */
import { TRPCError } from "@trpc/server";
import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { type Client } from "urql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodSchema } from "zod";

import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";

import { type IStripeCustomerApi } from "../api/stripe-customer-api";
import {
  type CreateSubscriptionArgs,
  type IStripeSubscriptionsApi,
} from "../api/stripe-subscriptions-api";
import { SubscriptionRecord } from "../repositories/subscription-record";
import { type SubscriptionRepo, SubscriptionRepoError } from "../repositories/subscription-repo";
import {
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  type PriceVariantMapping,
  type PriceVariantMapRepo,
} from "../saleor-bridge/price-variant-map";
import {
  type ISaleorCustomerResolver,
  SaleorCustomerResolverError,
} from "../saleor-bridge/saleor-customer-resolver";
import { CreateSubscriptionHandler } from "./create-subscription";
import { subscriptionsRouter } from "./subscriptions-router";

const ACCESS_PATTERN = {
  saleorApiUrl: mockedSaleorApiUrl,
  appId: "app_test_T20",
};

const TEST_INPUT = {
  fiefUserId: "fief_user_T20",
  email: "alice@example.com",
  stripePriceId: "price_T20_basic",
};

function buildPriceVariantMapping(
  overrides: Partial<PriceVariantMapping> = {},
): PriceVariantMapping {
  return {
    stripePriceId: createStripePriceId("price_T20_basic"),
    saleorVariantId: createSaleorVariantId("variant_T20"),
    saleorChannelSlug: createSaleorChannelSlug("owlbooks"),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function buildStripeSubscription(
  overrides: Partial<{
    id: string;
    customer: string;
    clientSecret: string;
    status: Stripe.Subscription.Status;
  }> = {},
): Stripe.Subscription {
  const id = overrides.id ?? "sub_T20_new";
  const customer = overrides.customer ?? "cus_T20_new";
  const clientSecret = overrides.clientSecret ?? "pi_secret_xyz";
  const status: Stripe.Subscription.Status = overrides.status ?? "incomplete";

  return {
    id,
    object: "subscription",
    customer,
    status,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_T20",
          price: { id: "price_T20_basic" },
          // current_period_* moved onto items in Stripe API v2025+
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
        } as unknown as Stripe.SubscriptionItem,
      ],
    },
    latest_invoice: {
      id: "in_T20",
      payment_intent: {
        id: "pi_T20",
        client_secret: clientSecret,
      },
    },
  } as unknown as Stripe.Subscription;
}

interface Harness {
  handler: CreateSubscriptionHandler;
  stripeSubscriptionsApi: {
    createSubscription: ReturnType<typeof vi.fn>;
    updateSubscription: ReturnType<typeof vi.fn>;
    cancelSubscription: ReturnType<typeof vi.fn>;
    retrieveSubscription: ReturnType<typeof vi.fn>;
    createBillingPortalSession: ReturnType<typeof vi.fn>;
  };
  stripeCustomerApi: {
    createCustomer: ReturnType<typeof vi.fn>;
    updateCustomer: ReturnType<typeof vi.fn>;
    retrieveCustomer: ReturnType<typeof vi.fn>;
  };
  customerResolver: {
    resolveSaleorUser: ReturnType<typeof vi.fn>;
    resolveStripeCustomer: ReturnType<typeof vi.fn>;
  };
  subscriptionRepo: {
    upsert: ReturnType<typeof vi.fn>;
    getBySubscriptionId: ReturnType<typeof vi.fn>;
    getByCustomerId: ReturnType<typeof vi.fn>;
    getByFiefUserId: ReturnType<typeof vi.fn>;
  };
  priceVariantMapRepo: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  graphqlClient: Pick<Client, "mutation" | "query">;
}

function buildHarness(
  opts: {
    saleorUserResult?: Awaited<ReturnType<ISaleorCustomerResolver["resolveSaleorUser"]>>;
    stripeCustomerResult?: Awaited<ReturnType<ISaleorCustomerResolver["resolveStripeCustomer"]>>;
    createSubResult?: Awaited<ReturnType<IStripeSubscriptionsApi["createSubscription"]>>;
    upsertResult?: Awaited<ReturnType<SubscriptionRepo["upsert"]>>;
    priceMapping?: PriceVariantMapping | null;
    existingFiefSubscription?: SubscriptionRecord | null;
  } = {},
): Harness {
  const stripeSubscriptionsApi = {
    createSubscription: vi
      .fn()
      .mockResolvedValue(opts.createSubResult ?? ok(buildStripeSubscription())),
    updateSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    retrieveSubscription: vi.fn(),
    createBillingPortalSession: vi.fn(),
  };

  const stripeCustomerApi = {
    createCustomer: vi.fn(),
    updateCustomer: vi.fn(),
    retrieveCustomer: vi.fn(),
  };

  const customerResolver = {
    resolveSaleorUser: vi
      .fn()
      .mockResolvedValue(opts.saleorUserResult ?? ok({ saleorUserId: "saleor_user_T20" })),
    resolveStripeCustomer: vi
      .fn()
      .mockResolvedValue(opts.stripeCustomerResult ?? ok({ stripeCustomerId: "cus_T20_new" })),
  };

  const subscriptionRepo = {
    upsert: vi.fn().mockResolvedValue(opts.upsertResult ?? ok(null)),
    getBySubscriptionId: vi.fn().mockResolvedValue(ok(null)),
    getByCustomerId: vi.fn().mockResolvedValue(ok(null)),
    getByFiefUserId: vi.fn().mockResolvedValue(ok(opts.existingFiefSubscription ?? null)),
  };

  const priceVariantMapRepo = {
    get: vi
      .fn()
      .mockResolvedValue(
        ok(opts.priceMapping === undefined ? buildPriceVariantMapping() : opts.priceMapping),
      ),
    set: vi.fn().mockResolvedValue(ok(null)),
    delete: vi.fn().mockResolvedValue(ok(null)),
    list: vi.fn().mockResolvedValue(ok([])),
  };

  const graphqlClient = { query: vi.fn(), mutation: vi.fn() } as unknown as Pick<
    Client,
    "mutation" | "query"
  >;

  const handler = new CreateSubscriptionHandler({
    stripeSubscriptionsApi: stripeSubscriptionsApi as unknown as IStripeSubscriptionsApi,
    stripeCustomerApi: stripeCustomerApi as unknown as IStripeCustomerApi,
    customerResolver: customerResolver as unknown as ISaleorCustomerResolver,
    subscriptionRepo: subscriptionRepo as unknown as SubscriptionRepo,
    priceVariantMapRepo: priceVariantMapRepo as unknown as PriceVariantMapRepo,
    graphqlClient,
    accessPattern: ACCESS_PATTERN,
  });

  return {
    handler,
    stripeSubscriptionsApi,
    stripeCustomerApi,
    customerResolver,
    subscriptionRepo,
    priceVariantMapRepo,
    graphqlClient,
  };
}

describe("CreateSubscriptionHandler.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: resolves Saleor user, resolves/creates Stripe customer, creates subscription, upserts cache, returns shape", async () => {
    const h = buildHarness();

    const result = await h.handler.execute(TEST_INPUT);

    /* Saleor user resolved with the input identity */
    expect(h.customerResolver.resolveSaleorUser).toHaveBeenCalledTimes(1);
    expect(h.customerResolver.resolveSaleorUser).toHaveBeenCalledWith(
      expect.objectContaining({
        fiefUserId: TEST_INPUT.fiefUserId,
        email: TEST_INPUT.email,
        graphqlClient: h.graphqlClient,
      }),
    );

    /* Stripe customer resolved/created using the resolved Saleor user id */
    expect(h.customerResolver.resolveStripeCustomer).toHaveBeenCalledTimes(1);
    expect(h.customerResolver.resolveStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        fiefUserId: TEST_INPUT.fiefUserId,
        email: TEST_INPUT.email,
        saleorUserId: "saleor_user_T20",
        stripeCustomerApi: h.stripeCustomerApi,
      }),
    );

    /* Subscription created against the resolved customer + the input price */
    expect(h.stripeSubscriptionsApi.createSubscription).toHaveBeenCalledTimes(1);

    const subArgs = h.stripeSubscriptionsApi.createSubscription.mock
      .calls[0][0] as CreateSubscriptionArgs;

    expect(subArgs.customerId).toBe("cus_T20_new");
    expect(subArgs.priceId).toBe("price_T20_basic");

    /* Cache row upserted (status pulled from Stripe response) */
    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const written = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    expect(written.stripeSubscriptionId).toBe("sub_T20_new");
    expect(written.stripeCustomerId).toBe("cus_T20_new");
    expect(written.fiefUserId).toBe(TEST_INPUT.fiefUserId);
    expect(written.saleorUserId).toBe("saleor_user_T20");
    expect(written.saleorChannelSlug).toBe("owlbooks");
    expect(written.stripePriceId).toBe("price_T20_basic");
    expect(written.status).toBe("incomplete");

    /* Output shape matches the router schema */
    expect(result).toStrictEqual({
      stripeSubscriptionId: "sub_T20_new",
      stripeCustomerId: "cus_T20_new",
      clientSecret: "pi_secret_xyz",
    });
  });

  it("reuses an existing Stripe customer when one is recorded against the Fief user", async () => {
    const existing = new SubscriptionRecord({
      stripeSubscriptionId: "sub_old" as never,
      stripeCustomerId: "cus_existing_for_fief" as never,
      saleorChannelSlug: createSaleorChannelSlug("owlbooks"),
      saleorUserId: "saleor_user_T20",
      fiefUserId: TEST_INPUT.fiefUserId as never,
      stripePriceId: "price_old" as never,
      status: "canceled",
      currentPeriodStart: new Date(0),
      currentPeriodEnd: new Date(0),
      cancelAtPeriodEnd: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const h = buildHarness({ existingFiefSubscription: existing });

    await h.handler.execute(TEST_INPUT);

    /* The resolver receives the existing Stripe customer id so it can reuse it */
    expect(h.customerResolver.resolveStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        existingStripeCustomerId: "cus_existing_for_fief",
      }),
    );
  });

  it("forwards `signup-${fiefUserId}-${stripePriceId}` as the Stripe idempotency key", async () => {
    const h = buildHarness();

    await h.handler.execute(TEST_INPUT);

    const subArgs = h.stripeSubscriptionsApi.createSubscription.mock
      .calls[0][0] as CreateSubscriptionArgs;

    expect(subArgs.idempotencyKey).toBe(
      `signup-${TEST_INPUT.fiefUserId}-${TEST_INPUT.stripePriceId}`,
    );
  });

  it("passes fiefUserId, saleorUserId, saleorChannelSlug as Stripe metadata for webhook routing", async () => {
    const h = buildHarness();

    await h.handler.execute(TEST_INPUT);

    const subArgs = h.stripeSubscriptionsApi.createSubscription.mock
      .calls[0][0] as CreateSubscriptionArgs;

    expect(subArgs.metadata).toStrictEqual(
      expect.objectContaining({
        fiefUserId: TEST_INPUT.fiefUserId,
        saleorUserId: "saleor_user_T20",
        saleorChannelSlug: "owlbooks",
      }),
    );
  });

  it("INTERNAL_SERVER_ERROR with wrapped cause when Saleor user resolution fails", async () => {
    const resolverError = new SaleorCustomerResolverError.SaleorUserResolverError("saleor down");
    const h = buildHarness({ saleorUserResult: err(resolverError) });

    let caught: unknown;

    try {
      await h.handler.execute(TEST_INPUT);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((caught as TRPCError).cause).toBe(resolverError);

    expect(h.stripeSubscriptionsApi.createSubscription).not.toHaveBeenCalled();
    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
  });

  it("INTERNAL_SERVER_ERROR with wrapped cause when Stripe customer resolution fails", async () => {
    const resolverError = new SaleorCustomerResolverError.StripeCustomerResolverError(
      "stripe customer create failed",
    );
    const h = buildHarness({ stripeCustomerResult: err(resolverError) });

    let caught: unknown;

    try {
      await h.handler.execute(TEST_INPUT);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((caught as TRPCError).cause).toBe(resolverError);

    expect(h.stripeSubscriptionsApi.createSubscription).not.toHaveBeenCalled();
  });

  it("INTERNAL_SERVER_ERROR with wrapped cause when Stripe.subscriptions.create fails", async () => {
    const stripeErr = new StripeAPIError("rate limited");
    const h = buildHarness({ createSubResult: err(stripeErr) });

    let caught: unknown;

    try {
      await h.handler.execute(TEST_INPUT);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((caught as TRPCError).cause).toBe(stripeErr);

    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
  });

  it("FAILED_PRECONDITION when no priceVariantMapping exists for the stripePriceId", async () => {
    /*
     * Without a price→variant mapping we cannot determine which Saleor channel
     * to scope the subscription to — so we cannot mint orders downstream and
     * cannot route the customer.subscription.* webhook (T15 requires
     * saleorChannelSlug in metadata). Bail BEFORE calling Stripe.
     */
    const h = buildHarness({ priceMapping: null });

    let caught: unknown;

    try {
      await h.handler.execute(TEST_INPUT);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect(["PRECONDITION_FAILED", "BAD_REQUEST"]).toContain((caught as TRPCError).code);

    expect(h.stripeSubscriptionsApi.createSubscription).not.toHaveBeenCalled();
  });

  it("still returns success when the DynamoDB cache upsert fails — the Stripe sub exists and the webhook will reconcile", async () => {
    const h = buildHarness({
      upsertResult: err(new SubscriptionRepoError.FailedWritingSubscriptionError("ddb down")),
    });

    const result = await h.handler.execute(TEST_INPUT);

    expect(result.stripeSubscriptionId).toBe("sub_T20_new");
    expect(result.clientSecret).toBe("pi_secret_xyz");
  });

  it("INTERNAL_SERVER_ERROR when Stripe response is missing latest_invoice.payment_intent.client_secret", async () => {
    /*
     * `payment_behavior: default_incomplete` MUST yield a payment_intent with
     * a client_secret on cycle 1; missing one means Stripe returned a
     * misconfigured result and the storefront cannot confirm. Surface a 500
     * rather than handing the storefront an empty secret.
     */
    const malformed = buildStripeSubscription();

    (malformed as unknown as { latest_invoice: { payment_intent: null } }).latest_invoice = {
      payment_intent: null,
    };

    const h = buildHarness({ createSubResult: ok(malformed) });

    let caught: unknown;

    try {
      await h.handler.execute(TEST_INPUT);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("subscriptionsRouter.create input schema (T20 strict mode)", () => {
  /**
   * `subscriptionsRouter.create._def.inputs[0]` is the Zod schema attached
   * by `.input(createInputSchema)`. We reach in to assert that strict mode
   * rejects the keys the OwlBooks design forbids — promoCode / couponId /
   * discount apply to the AI-credit `PromoCode` model only, not v1
   * subscriptions. Putting the assertion here (next to the procedure body)
   * keeps the contract co-located with the body that depends on it.
   */
  const createInputSchema = subscriptionsRouter.create._def.inputs[0] as ZodSchema;

  it("accepts the documented input shape", () => {
    expect(
      createInputSchema.safeParse({
        fiefUserId: "fief_T20",
        email: "alice@example.com",
        stripePriceId: "price_T20_basic",
      }).success,
    ).toBe(true);
  });

  it("rejects an extra `promoCode` key with a Zod error naming the offending key", () => {
    const result = createInputSchema.safeParse({
      fiefUserId: "fief_T20",
      email: "alice@example.com",
      stripePriceId: "price_T20_basic",
      promoCode: "WELCOME50",
    });

    expect(result.success).toBe(false);

    const flat = JSON.stringify(result);

    expect(flat).toContain("promoCode");
  });

  it("rejects `couponId`", () => {
    const result = createInputSchema.safeParse({
      fiefUserId: "fief_T20",
      email: "alice@example.com",
      stripePriceId: "price_T20_basic",
      couponId: "coupon_xyz",
    });

    expect(result.success).toBe(false);
  });

  it("rejects `discount`", () => {
    const result = createInputSchema.safeParse({
      fiefUserId: "fief_T20",
      email: "alice@example.com",
      stripePriceId: "price_T20_basic",
      discount: { type: "percent", value: 10 },
    });

    expect(result.success).toBe(false);
  });
});
