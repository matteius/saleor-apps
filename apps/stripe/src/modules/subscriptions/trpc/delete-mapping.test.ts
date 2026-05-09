/**
 * RED-phase Vitest for T25 — `DeleteMappingHandler`.
 */
import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedAppToken, mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedGraphqlClient } from "@/__tests__/mocks/graphql-client";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { TEST_Procedure } from "@/__tests__/trpc-testing-procedure";
import { router } from "@/modules/trpc/trpc-server";

import { PriceVariantMapError, type PriceVariantMapRepo } from "../saleor-bridge/price-variant-map";
import { DeleteMappingHandler } from "./delete-mapping";

const buildStubRepo = (overrides?: Partial<PriceVariantMapRepo>): PriceVariantMapRepo => ({
  set: vi.fn().mockImplementation(() => {
    throw new Error("set should not be called from deleteMapping handler");
  }),
  get: vi.fn().mockImplementation(() => {
    throw new Error("get should not be called from deleteMapping handler");
  }),
  delete: vi.fn().mockResolvedValue(ok(null)),
  list: vi.fn().mockImplementation(() => {
    throw new Error("list should not be called from deleteMapping handler");
  }),
  ...overrides,
});

const getTestCaller = (deps?: { repo?: PriceVariantMapRepo }) => {
  const repo = deps?.repo ?? buildStubRepo();

  const handler = new DeleteMappingHandler({ priceVariantMapRepo: repo });

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

describe("DeleteMappingHandler (T25)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("happy path", () => {
    it("calls the repo with the branded stripePriceId", async () => {
      const { caller, repo } = getTestCaller();

      const result = await caller.testProcedure({ stripePriceId: "price_TEST_DELETE" });

      expect(result).toStrictEqual({ ok: true });
      expect(repo.delete).toHaveBeenCalledExactlyOnceWith(
        { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId },
        "price_TEST_DELETE",
      );
    });
  });

  describe("input validation", () => {
    it("rejects empty stripePriceId", async () => {
      const { caller, repo } = getTestCaller();

      await expect(caller.testProcedure({ stripePriceId: "" })).rejects.toThrow();

      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("rejects stripePriceId not starting with price_", async () => {
      const { caller, repo } = getTestCaller();

      await expect(caller.testProcedure({ stripePriceId: "not-a-price-id" })).rejects.toThrow();

      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  describe("repo failure", () => {
    it("maps a persistence failure to INTERNAL_SERVER_ERROR", async () => {
      const repo = buildStubRepo({
        delete: vi
          .fn()
          .mockResolvedValue(err(new PriceVariantMapError.PersistenceFailedError("ddb timeout"))),
      });
      const { caller } = getTestCaller({ repo });

      await expect(
        caller.testProcedure({ stripePriceId: "price_TEST_DELETE" }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Failed to delete price-variant mapping]`,
      );
    });
  });
});
