/**
 * RED-phase Vitest for T25 — `UpsertMappingHandler`.
 *
 * Validates the input → Stripe-price existence check → repo upsert flow.
 * Stripe API + repo are stubbed.
 */
import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedAppToken, mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedGraphqlClient } from "@/__tests__/mocks/graphql-client";
import { mockedStripeConfig } from "@/__tests__/mocks/mock-stripe-config";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { TEST_Procedure } from "@/__tests__/trpc-testing-procedure";
import { AppRootConfig } from "@/modules/app-config/domain/app-root-config";
import { StripeInvalidRequestError } from "@/modules/stripe/stripe-api-error";
import { router } from "@/modules/trpc/trpc-server";

import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import { type IStripeSubscriptionsApiFactory } from "../api/stripe-subscriptions-api-factory";
import { PriceVariantMapError, type PriceVariantMapRepo } from "../saleor-bridge/price-variant-map";
import { UpsertMappingHandler } from "./upsert-mapping";

const buildStubSubscriptionsApi = (
  overrides?: Partial<IStripeSubscriptionsApi>,
): IStripeSubscriptionsApi => ({
  retrievePrice: vi
    .fn()
    .mockResolvedValue(ok({ id: "price_TEST_UPSERT", object: "price" } as Stripe.Price)),
  createSubscription: vi.fn().mockImplementation(() => {
    throw new Error("createSubscription should not be called from upsertMapping handler");
  }),
  updateSubscription: vi.fn().mockImplementation(() => {
    throw new Error("updateSubscription should not be called from upsertMapping handler");
  }),
  cancelSubscription: vi.fn().mockImplementation(() => {
    throw new Error("cancelSubscription should not be called from upsertMapping handler");
  }),
  retrieveSubscription: vi.fn().mockImplementation(() => {
    throw new Error("retrieveSubscription should not be called from upsertMapping handler");
  }),
  createBillingPortalSession: vi.fn().mockImplementation(() => {
    throw new Error("createBillingPortalSession should not be called from upsertMapping handler");
  }),
  ...overrides,
});

const buildStubFactory = (api: IStripeSubscriptionsApi): IStripeSubscriptionsApiFactory => ({
  createSubscriptionsApi: vi.fn().mockReturnValue(api),
  createCustomerApi: vi.fn().mockImplementation(() => {
    throw new Error("createCustomerApi should not be called from upsertMapping handler");
  }) as IStripeSubscriptionsApiFactory["createCustomerApi"],
});

const buildStubRepo = (overrides?: Partial<PriceVariantMapRepo>): PriceVariantMapRepo => ({
  set: vi.fn().mockResolvedValue(ok(null)),
  get: vi.fn().mockImplementation(() => {
    throw new Error("get should not be called from upsertMapping handler");
  }),
  delete: vi.fn().mockImplementation(() => {
    throw new Error("delete should not be called from upsertMapping handler");
  }),
  list: vi.fn().mockImplementation(() => {
    throw new Error("list should not be called from upsertMapping handler");
  }),
  ...overrides,
});

const getTestCaller = (deps?: {
  api?: IStripeSubscriptionsApi;
  repo?: PriceVariantMapRepo;
  rootConfigOverride?: ReturnType<typeof mockedAppConfigRepo.getRootConfig>;
}) => {
  const api = deps?.api ?? buildStubSubscriptionsApi();
  const factory = buildStubFactory(api);
  const repo = deps?.repo ?? buildStubRepo();

  vi.spyOn(mockedAppConfigRepo, "getRootConfig").mockResolvedValue(
    deps?.rootConfigOverride ??
      ok(new AppRootConfig({}, { [mockedStripeConfig.id]: mockedStripeConfig })),
  );

  const handler = new UpsertMappingHandler({
    stripeSubscriptionsApiFactory: factory,
    appConfigRepo: mockedAppConfigRepo,
    priceVariantMapRepo: repo,
  });

  // @ts-expect-error - context shape mismatch is intentional; populated below.
  handler.baseProcedure = TEST_Procedure;

  const testRouter = router({
    testProcedure: handler.getTrpcProcedure(),
  });

  return {
    api,
    factory,
    repo,
    caller: testRouter.createCaller({
      appId: mockedSaleorAppId,
      saleorApiUrl: mockedSaleorApiUrl,
      token: mockedAppToken,
      configRepo: mockedAppConfigRepo,
      apiClient: mockedGraphqlClient,
      appUrl: "https://localhost:3000",
    }),
  };
};

const VALID_INPUT = {
  stripePriceId: "price_TEST_UPSERT",
  saleorVariantId: "variant_TEST_UPSERT",
  saleorChannelSlug: "default-channel",
};

describe("UpsertMappingHandler (T25)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("happy path", () => {
    it("validates the price with Stripe and persists the mapping via the repo", async () => {
      const { caller, api, repo } = getTestCaller();

      const result = await caller.testProcedure(VALID_INPUT);

      expect(result).toStrictEqual({ ok: true });

      expect(api.retrievePrice).toHaveBeenCalledExactlyOnceWith({
        priceId: "price_TEST_UPSERT",
      });

      expect(repo.set).toHaveBeenCalledExactlyOnceWith(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        expect.objectContaining({
          stripePriceId: "price_TEST_UPSERT",
          saleorVariantId: "variant_TEST_UPSERT",
          saleorChannelSlug: "default-channel",
        }),
      );
    });
  });

  describe("Stripe price validation", () => {
    it("rejects when Stripe says the price is unknown (NOT_FOUND, no repo write)", async () => {
      const failingApi = buildStubSubscriptionsApi({
        retrievePrice: vi.fn().mockResolvedValue(
          err(
            new StripeInvalidRequestError("No such price: price_BOGUS", {
              cause: new Error("stripe 404"),
            }),
          ),
        ),
      });
      const { caller, repo } = getTestCaller({ api: failingApi });

      await expect(
        caller.testProcedure({ ...VALID_INPUT, stripePriceId: "price_BOGUS" }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Stripe price "price_BOGUS" does not exist or is not accessible]`,
      );

      expect(repo.set).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it("rejects empty stripePriceId at the schema layer (BAD_REQUEST)", async () => {
      const { caller, api, repo } = getTestCaller();

      await expect(caller.testProcedure({ ...VALID_INPUT, stripePriceId: "" })).rejects.toThrow(
        /price_|String must contain at least 1 character/,
      );

      expect(api.retrievePrice).not.toHaveBeenCalled();
      expect(repo.set).not.toHaveBeenCalled();
    });

    it("rejects stripePriceId not starting with price_", async () => {
      const { caller, api, repo } = getTestCaller();

      await expect(
        caller.testProcedure({ ...VALID_INPUT, stripePriceId: "not-a-price-id" }),
      ).rejects.toThrow();

      expect(api.retrievePrice).not.toHaveBeenCalled();
      expect(repo.set).not.toHaveBeenCalled();
    });

    it("rejects empty saleorVariantId at the schema layer", async () => {
      const { caller, api, repo } = getTestCaller();

      await expect(caller.testProcedure({ ...VALID_INPUT, saleorVariantId: "" })).rejects.toThrow();

      expect(api.retrievePrice).not.toHaveBeenCalled();
      expect(repo.set).not.toHaveBeenCalled();
    });

    it("rejects empty saleorChannelSlug at the schema layer", async () => {
      const { caller, api, repo } = getTestCaller();

      await expect(
        caller.testProcedure({ ...VALID_INPUT, saleorChannelSlug: "" }),
      ).rejects.toThrow();

      expect(api.retrievePrice).not.toHaveBeenCalled();
      expect(repo.set).not.toHaveBeenCalled();
    });
  });

  describe("repo failure", () => {
    it("maps a persistence failure to INTERNAL_SERVER_ERROR after Stripe validation succeeded", async () => {
      const repo = buildStubRepo({
        set: vi
          .fn()
          .mockResolvedValue(err(new PriceVariantMapError.PersistenceFailedError("ddb timeout"))),
      });
      const { caller, api } = getTestCaller({ repo });

      await expect(caller.testProcedure(VALID_INPUT)).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Failed to persist price-variant mapping]`,
      );

      expect(api.retrievePrice).toHaveBeenCalledExactlyOnceWith({
        priceId: "price_TEST_UPSERT",
      });
    });
  });

  describe("config resolution failures", () => {
    it("returns INTERNAL_SERVER_ERROR if no Stripe config is installed", async () => {
      const { caller } = getTestCaller({
        rootConfigOverride: ok(new AppRootConfig({}, {})),
      });

      await expect(caller.testProcedure(VALID_INPUT)).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: No Stripe configuration is installed for this Saleor app]`,
      );
    });
  });
});
