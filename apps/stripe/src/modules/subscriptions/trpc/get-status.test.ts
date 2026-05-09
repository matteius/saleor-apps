/**
 * Vitest unit tests for `GetStatusTrpcHandler` (T23).
 *
 * Mirrors the test scaffolding of `billing-portal.test.ts` (T22) — substitute
 * the JWT-checking `protectedClientProcedure` for `TEST_Procedure` so the
 * caller doesn't need to mint a real Saleor JWT, and inject a stub
 * `SubscriptionRepo` so DynamoDB never gets touched.
 */
import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedAppToken, mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedGraphqlClient } from "@/__tests__/mocks/graphql-client";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { TEST_Procedure } from "@/__tests__/trpc-testing-procedure";
import { router } from "@/modules/trpc/trpc-server";

import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import { type SubscriptionRepo, SubscriptionRepoError } from "../repositories/subscription-repo";
import { GetStatusTrpcHandler } from "./get-status";

const FIXED_PERIOD_START = new Date("2026-01-01T00:00:00.000Z");
const FIXED_PERIOD_END = new Date("2026-02-01T00:00:00.000Z");
const FIXED_CREATED = new Date("2026-01-01T00:00:00.000Z");
const FIXED_MODIFIED = new Date("2026-01-15T00:00:00.000Z");

const stripeSubscriptionId = createStripeSubscriptionId("sub_TEST_GET_STATUS");
const stripeCustomerId = createStripeCustomerId("cus_TEST_GET_STATUS");
const stripePriceId = createStripePriceId("price_TEST_GET_STATUS");
const fiefUserId = createFiefUserId("fief-user-TEST");
const saleorChannelSlug = createSaleorChannelSlug("owlbooks");

const buildRecord = (
  overrides: Partial<ConstructorParameters<typeof SubscriptionRecord>[0]> = {},
): SubscriptionRecord =>
  new SubscriptionRecord({
    stripeSubscriptionId,
    stripeCustomerId,
    saleorChannelSlug,
    saleorUserId: "saleor-user-TEST",
    fiefUserId,
    saleorEntityId: null,
    stripePriceId,
    status: "active",
    currentPeriodStart: FIXED_PERIOD_START,
    currentPeriodEnd: FIXED_PERIOD_END,
    cancelAtPeriodEnd: false,
    lastInvoiceId: "in_TEST",
    lastSaleorOrderId: "order-TEST",
    planName: "OwlBooks Pro Monthly",
    createdAt: FIXED_CREATED,
    updatedAt: FIXED_MODIFIED,
    ...overrides,
  });

/**
 * Build a stub {@link SubscriptionRepo} where each lookup method is a
 * `vi.fn()` we can assert against, and the unused-in-this-suite methods
 * throw if accidentally invoked.
 */
const buildStubRepo = (overrides?: Partial<SubscriptionRepo>): SubscriptionRepo => ({
  getBySubscriptionId: vi.fn().mockResolvedValue(ok(null)),
  getByFiefUserId: vi.fn().mockResolvedValue(ok(null)),
  getByCustomerId: vi.fn().mockImplementation(() => {
    throw new Error("getByCustomerId should not be called from getStatus handler");
  }),
  upsert: vi.fn().mockImplementation(() => {
    throw new Error("upsert should not be called from getStatus handler");
  }),
  markInvoiceProcessed: vi.fn().mockImplementation(() => {
    throw new Error("markInvoiceProcessed should not be called from getStatus handler");
  }),
  ...overrides,
});

const getTestCaller = (deps?: { repo?: SubscriptionRepo }) => {
  const repo = deps?.repo ?? buildStubRepo();

  const handler = new GetStatusTrpcHandler({
    subscriptionRepo: repo,
  });

  /*
   * Swap the JWT-validating procedure for the bare test procedure so the
   * caller doesn't need a real Saleor JWT.
   */
  // @ts-expect-error - context shape mismatch is intentional; populated below.
  handler.baseProcedure = TEST_Procedure;

  const testRouter = router({
    testProcedure: handler.getTrpcProcedure(),
  });

  return {
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

describe("GetStatusTrpcHandler (T23)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("happy path — by stripeSubscriptionId", () => {
    it("returns the full status payload from the repo", async () => {
      const record = buildRecord();
      const repo = buildStubRepo({
        getBySubscriptionId: vi.fn().mockResolvedValue(ok(record)),
      });
      const { caller } = getTestCaller({ repo });

      const result = await caller.testProcedure({
        by: "stripeSubscriptionId",
        stripeSubscriptionId,
      });

      expect(result).toStrictEqual({
        status: "active",
        currentPeriodEnd: FIXED_PERIOD_END.toISOString(),
        cancelAtPeriodEnd: false,
        lastSaleorOrderId: "order-TEST",
        planName: "OwlBooks Pro Monthly",
      });

      expect(repo.getBySubscriptionId).toHaveBeenCalledExactlyOnceWith(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        stripeSubscriptionId,
      );
      expect(repo.getByFiefUserId).not.toHaveBeenCalled();
    });
  });

  describe("happy path — by fiefUserId", () => {
    it("returns the full status payload from the repo", async () => {
      const record = buildRecord({
        cancelAtPeriodEnd: true,
        lastSaleorOrderId: null,
      });
      const repo = buildStubRepo({
        getByFiefUserId: vi.fn().mockResolvedValue(ok(record)),
      });
      const { caller } = getTestCaller({ repo });

      const result = await caller.testProcedure({
        by: "fiefUserId",
        fiefUserId,
      });

      expect(result).toStrictEqual({
        status: "active",
        currentPeriodEnd: FIXED_PERIOD_END.toISOString(),
        cancelAtPeriodEnd: true,
        lastSaleorOrderId: null,
        planName: "OwlBooks Pro Monthly",
      });

      expect(repo.getByFiefUserId).toHaveBeenCalledExactlyOnceWith(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        fiefUserId,
      );
      expect(repo.getBySubscriptionId).not.toHaveBeenCalled();
    });
  });

  describe("cache miss", () => {
    it("returns NOT_FOUND when the repo returns ok(null)", async () => {
      const repo = buildStubRepo({
        getBySubscriptionId: vi.fn().mockResolvedValue(ok(null)),
      });
      const { caller } = getTestCaller({ repo });

      await expect(
        caller.testProcedure({
          by: "stripeSubscriptionId",
          stripeSubscriptionId,
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: No subscription record found for the given lookup key]`,
      );
    });

    it("returns NOT_FOUND when fiefUserId lookup returns ok(null)", async () => {
      const repo = buildStubRepo({
        getByFiefUserId: vi.fn().mockResolvedValue(ok(null)),
      });
      const { caller } = getTestCaller({ repo });

      await expect(
        caller.testProcedure({
          by: "fiefUserId",
          fiefUserId,
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: No subscription record found for the given lookup key]`,
      );
    });
  });

  describe("planName fallback", () => {
    it("falls back to stripePriceId when planName is null on the record", async () => {
      const record = buildRecord({ planName: null });
      const repo = buildStubRepo({
        getBySubscriptionId: vi.fn().mockResolvedValue(ok(record)),
      });
      const { caller } = getTestCaller({ repo });

      const result = await caller.testProcedure({
        by: "stripeSubscriptionId",
        stripeSubscriptionId,
      });

      expect(result.planName).toBe(stripePriceId);
    });

    it("falls back to stripePriceId when planName is undefined on the record", async () => {
      const record = buildRecord({ planName: undefined });
      const repo = buildStubRepo({
        getBySubscriptionId: vi.fn().mockResolvedValue(ok(record)),
      });
      const { caller } = getTestCaller({ repo });

      const result = await caller.testProcedure({
        by: "stripeSubscriptionId",
        stripeSubscriptionId,
      });

      expect(result.planName).toBe(stripePriceId);
    });
  });

  describe("repo error", () => {
    it("maps a repo failure to INTERNAL_SERVER_ERROR (logs but doesn't leak cause to client)", async () => {
      const repo = buildStubRepo({
        getBySubscriptionId: vi
          .fn()
          .mockResolvedValue(
            err(new SubscriptionRepoError.FailedFetchingSubscriptionError("ddb timeout")),
          ),
      });
      const { caller } = getTestCaller({ repo });

      await expect(
        caller.testProcedure({
          by: "stripeSubscriptionId",
          stripeSubscriptionId,
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Failed to read subscription cache]`,
      );
    });
  });

  describe("input validation (Zod discriminated union)", () => {
    it("rejects unknown discriminator value", async () => {
      const { caller } = getTestCaller();

      await expect(
        caller.testProcedure(
          // @ts-expect-error - testing runtime guard for an invalid discriminator
          { by: "wat", value: "x" },
        ),
      ).rejects.toThrow();
    });

    it("rejects stripeSubscriptionId that doesn't start with sub_", async () => {
      const { caller } = getTestCaller();

      await expect(
        caller.testProcedure({
          by: "stripeSubscriptionId",
          stripeSubscriptionId: "not-a-sub-id",
        }),
      ).rejects.toThrow();
    });
  });
});
