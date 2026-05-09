/**
 * Vitest unit tests for `BillingPortalTrpcHandler` (T22).
 *
 * Mirrors the test scaffolding in `new-stripe-config-trpc-handler.test.ts`
 * (substitute `TEST_Procedure` for the JWT-checking `protectedClientProcedure`
 * so we can drive the handler via `createCaller` without minting a real
 * Saleor JWT).
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
import { AppConfigRepoError } from "@/modules/app-config/repositories/app-config-repo";
import { StripeInvalidRequestError } from "@/modules/stripe/stripe-api-error";
import { router } from "@/modules/trpc/trpc-server";

import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import { type IStripeSubscriptionsApiFactory } from "../api/stripe-subscriptions-api-factory";
import { BillingPortalTrpcHandler, parseAllowlistedHosts } from "./billing-portal";

/**
 * Mock the validated env module before any other imports load it.
 * `@t3-oss/env-nextjs` builds the `env` object at module-eval time using a
 * Proxy that defers `process.env` access; once captured, `vi.stubEnv` won't
 * change what callers read. The test owns `STOREFRONT_PUBLIC_URL` via a
 * mutable holder reassigned per-suite.
 */
const envOverrides: { STOREFRONT_PUBLIC_URL?: string } = {};

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();

  return {
    env: new Proxy(actual.env, {
      get(target, prop, receiver) {
        if (prop === "STOREFRONT_PUBLIC_URL" && "STOREFRONT_PUBLIC_URL" in envOverrides) {
          return envOverrides.STOREFRONT_PUBLIC_URL;
        }

        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

const TEST_PORTAL_URL = "https://billing.stripe.com/session/test_xyz";

/**
 * Build a stub {@link IStripeSubscriptionsApi} where `createBillingPortalSession`
 * is a `vi.fn()` we can assert against, and the other (unused-in-this-test)
 * methods throw if accidentally invoked.
 */
const buildStubSubscriptionsApi = (
  overrides?: Partial<IStripeSubscriptionsApi>,
): IStripeSubscriptionsApi => ({
  createBillingPortalSession: vi
    .fn()
    .mockResolvedValue(
      ok({ id: "bps_test", url: TEST_PORTAL_URL } as Stripe.BillingPortal.Session),
    ),
  createSubscription: vi.fn().mockImplementation(() => {
    throw new Error("createSubscription should not be called from billing-portal handler");
  }),
  updateSubscription: vi.fn().mockImplementation(() => {
    throw new Error("updateSubscription should not be called from billing-portal handler");
  }),
  cancelSubscription: vi.fn().mockImplementation(() => {
    throw new Error("cancelSubscription should not be called from billing-portal handler");
  }),
  retrieveSubscription: vi.fn().mockImplementation(() => {
    throw new Error("retrieveSubscription should not be called from billing-portal handler");
  }),
  retrievePrice: vi.fn().mockImplementation(() => {
    throw new Error("retrievePrice should not be called from billing-portal handler");
  }),
  ...overrides,
});

const buildStubFactory = (api: IStripeSubscriptionsApi): IStripeSubscriptionsApiFactory => ({
  createSubscriptionsApi: vi.fn().mockReturnValue(api),
  // billing-portal handler doesn't call createCustomerApi; throw-stub so accidental future use is loud.
  createCustomerApi: vi.fn().mockImplementation(() => {
    throw new Error("createCustomerApi should not be called from billing-portal handler");
  }) as IStripeSubscriptionsApiFactory["createCustomerApi"],
});

const getTestCaller = (deps?: {
  api?: IStripeSubscriptionsApi;
  rootConfigOverride?: ReturnType<typeof mockedAppConfigRepo.getRootConfig>;
}) => {
  const api = deps?.api ?? buildStubSubscriptionsApi();
  const factory = buildStubFactory(api);

  /*
   * Default success path: root config returns a single Stripe config so the
   * handler picks it as the restricted-key source.
   */
  vi.spyOn(mockedAppConfigRepo, "getRootConfig").mockResolvedValue(
    deps?.rootConfigOverride ??
      ok(new AppRootConfig({}, { [mockedStripeConfig.id]: mockedStripeConfig })),
  );

  const handler = new BillingPortalTrpcHandler({
    stripeSubscriptionsApiFactory: factory,
    appConfigRepo: mockedAppConfigRepo,
  });

  /*
   * Swap the JWT-validating procedure for the bare test procedure so the
   * caller doesn't need a real Saleor JWT. The procedure context shape
   * differs from `protectedClientProcedure` — that's intentional, the
   * caller below populates the missing fields.
   */
  // @ts-expect-error - context shape mismatch is intentional
  handler.baseProcedure = TEST_Procedure;

  const testRouter = router({
    testProcedure: handler.getTrpcProcedure(),
  });

  return {
    api,
    factory,
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

describe("BillingPortalTrpcHandler (T22)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    /*
     * No env override by default: STOREFRONT_PUBLIC_URL falls through to the real env
     * (unset in the test runner), so all HTTPS URLs are accepted.
     */
    delete envOverrides.STOREFRONT_PUBLIC_URL;
  });

  describe("happy path", () => {
    it("calls Stripe with {customerId, returnUrl} and returns the portal URL", async () => {
      const { caller, api, factory } = getTestCaller();

      const result = await caller.testProcedure({
        stripeCustomerId: "cus_test_happy",
        returnUrl: "https://owlbooks.ai/settings/billing",
      });

      expect(result).toStrictEqual({ url: TEST_PORTAL_URL });

      expect(factory.createSubscriptionsApi).toHaveBeenCalledExactlyOnceWith({
        key: mockedStripeConfig.restrictedKey,
      });
      expect(api.createBillingPortalSession).toHaveBeenCalledExactlyOnceWith({
        customerId: "cus_test_happy",
        returnUrl: "https://owlbooks.ai/settings/billing",
      });
    });
  });

  describe("returnUrl HTTPS guard", () => {
    it("rejects non-HTTPS returnUrl with BAD_REQUEST", async () => {
      const { caller, api } = getTestCaller();

      await expect(
        caller.testProcedure({
          stripeCustomerId: "cus_test_http",
          returnUrl: "http://owlbooks.ai/settings/billing",
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[TRPCError: returnUrl must use HTTPS]`);

      expect(api.createBillingPortalSession).not.toHaveBeenCalled();
    });
  });

  describe("returnUrl host allowlist (STOREFRONT_PUBLIC_URL set)", () => {
    it("accepts HTTPS URLs whose host is in the allowlist", async () => {
      envOverrides.STOREFRONT_PUBLIC_URL = "https://owlbooks.ai,https://app.owlbooks.ai";

      const { caller } = getTestCaller();

      const result = await caller.testProcedure({
        stripeCustomerId: "cus_test_allowed",
        returnUrl: "https://owlbooks.ai/settings/billing",
      });

      expect(result.url).toBe(TEST_PORTAL_URL);
    });

    it("rejects HTTPS URLs whose host is NOT in the allowlist with BAD_REQUEST", async () => {
      envOverrides.STOREFRONT_PUBLIC_URL = "https://owlbooks.ai";

      const { caller, api } = getTestCaller();

      await expect(
        caller.testProcedure({
          stripeCustomerId: "cus_test_blocked",
          returnUrl: "https://evil.example.com/settings/billing",
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[TRPCError: returnUrl host is not permitted]`);

      expect(api.createBillingPortalSession).not.toHaveBeenCalled();
    });

    it("matches host case-insensitively", async () => {
      envOverrides.STOREFRONT_PUBLIC_URL = "https://OwlBooks.ai";

      const { caller } = getTestCaller();

      const result = await caller.testProcedure({
        stripeCustomerId: "cus_test_caseins",
        returnUrl: "https://owlbooks.ai/settings/billing",
      });

      expect(result.url).toBe(TEST_PORTAL_URL);
    });
  });

  describe("returnUrl host allowlist (STOREFRONT_PUBLIC_URL unset)", () => {
    it("accepts any HTTPS URL when STOREFRONT_PUBLIC_URL is unset", async () => {
      const { caller } = getTestCaller();

      const result = await caller.testProcedure({
        stripeCustomerId: "cus_test_unset",
        returnUrl: "https://anything.example.com/path",
      });

      expect(result.url).toBe(TEST_PORTAL_URL);
    });

    it("accepts any HTTPS URL when STOREFRONT_PUBLIC_URL is empty string", async () => {
      envOverrides.STOREFRONT_PUBLIC_URL = "";

      const { caller } = getTestCaller();

      const result = await caller.testProcedure({
        stripeCustomerId: "cus_test_empty",
        returnUrl: "https://anything.example.com/path",
      });

      expect(result.url).toBe(TEST_PORTAL_URL);
    });
  });

  describe("Stripe failure", () => {
    it("maps a Stripe API error to INTERNAL_SERVER_ERROR", async () => {
      const failingApi = buildStubSubscriptionsApi({
        createBillingPortalSession: vi.fn().mockResolvedValue(
          err(
            new StripeInvalidRequestError("no portal config", {
              cause: new Error("stripe boom"),
            }),
          ),
        ),
      });

      const { caller } = getTestCaller({ api: failingApi });

      await expect(
        caller.testProcedure({
          stripeCustomerId: "cus_test_stripe_fail",
          returnUrl: "https://owlbooks.ai/settings/billing",
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Failed to create Stripe billing portal session]`,
      );
    });
  });

  describe("missing customer ID", () => {
    it("rejects empty stripeCustomerId at the schema layer (BAD_REQUEST)", async () => {
      const { caller } = getTestCaller();

      await expect(
        caller.testProcedure({
          stripeCustomerId: "",
          returnUrl: "https://owlbooks.ai/settings/billing",
        }),
      ).rejects.toThrow(/cus_|String must contain at least 1 character/);
    });
  });

  describe("config resolution failures", () => {
    it("returns INTERNAL_SERVER_ERROR if root config fetch fails", async () => {
      const { caller } = getTestCaller({
        rootConfigOverride: err(new AppConfigRepoError.FailureFetchingConfig("dynamodb timeout")),
      });

      await expect(
        caller.testProcedure({
          stripeCustomerId: "cus_test_cfg_err",
          returnUrl: "https://owlbooks.ai/settings/billing",
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Failed to load Stripe configuration]`,
      );
    });

    it("returns INTERNAL_SERVER_ERROR if no Stripe config is installed", async () => {
      const { caller } = getTestCaller({
        rootConfigOverride: ok(new AppRootConfig({}, {})),
      });

      await expect(
        caller.testProcedure({
          stripeCustomerId: "cus_test_no_cfg",
          returnUrl: "https://owlbooks.ai/settings/billing",
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: No Stripe configuration is installed for this Saleor app]`,
      );
    });
  });
});

describe("parseAllowlistedHosts", () => {
  it("returns null for undefined input", () => {
    expect(parseAllowlistedHosts(undefined)).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(parseAllowlistedHosts("")).toBeNull();
    expect(parseAllowlistedHosts("   ")).toBeNull();
  });

  it("parses a single full URL into its host (lowercase)", () => {
    const hosts = parseAllowlistedHosts("https://OwlBooks.AI/path?q=1");

    expect(hosts).not.toBeNull();
    expect(hosts!.has("owlbooks.ai")).toBe(true);
  });

  it("parses comma-separated mix of URLs and bare hosts", () => {
    const hosts = parseAllowlistedHosts(
      "https://owlbooks.ai , app.opensensor.io ,https://Mattscoinage.com",
    );

    expect(hosts).not.toBeNull();
    expect(hosts!.has("owlbooks.ai")).toBe(true);
    expect(hosts!.has("app.opensensor.io")).toBe(true);
    expect(hosts!.has("mattscoinage.com")).toBe(true);
  });
});
