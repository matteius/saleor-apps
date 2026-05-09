/**
 * RED-phase Vitest for T25 — `ListMappingsHandler`.
 *
 * Mirrors the test scaffolding of `billing-portal.test.ts` (T22) /
 * `get-status.test.ts` (T23): swap the JWT-checking
 * `protectedClientProcedure` for `TEST_Procedure` so the caller doesn't need
 * to mint a real Saleor JWT, and inject a stub `PriceVariantMapRepo` so
 * DynamoDB never gets touched.
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
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  PriceVariantMapError,
  type PriceVariantMapping,
  type PriceVariantMapRepo,
} from "../saleor-bridge/price-variant-map";
import { ListMappingsHandler } from "./list-mappings";

const FIXED_CREATED = new Date("2026-01-01T00:00:00.000Z");
const FIXED_MODIFIED = new Date("2026-01-15T00:00:00.000Z");

const buildMapping = (overrides: Partial<PriceVariantMapping> = {}): PriceVariantMapping => ({
  stripePriceId: createStripePriceId("price_TEST_LIST"),
  saleorVariantId: createSaleorVariantId("variant_TEST_LIST"),
  saleorChannelSlug: createSaleorChannelSlug("default-channel"),
  createdAt: FIXED_CREATED,
  updatedAt: FIXED_MODIFIED,
  ...overrides,
});

const buildStubRepo = (overrides?: Partial<PriceVariantMapRepo>): PriceVariantMapRepo => ({
  set: vi.fn().mockImplementation(() => {
    throw new Error("set should not be called from listMappings handler");
  }),
  get: vi.fn().mockImplementation(() => {
    throw new Error("get should not be called from listMappings handler");
  }),
  delete: vi.fn().mockImplementation(() => {
    throw new Error("delete should not be called from listMappings handler");
  }),
  list: vi.fn().mockResolvedValue(ok([])),
  ...overrides,
});

const getTestCaller = (deps?: { repo?: PriceVariantMapRepo }) => {
  const repo = deps?.repo ?? buildStubRepo();

  const handler = new ListMappingsHandler({ priceVariantMapRepo: repo });

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

describe("ListMappingsHandler (T25)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("happy path", () => {
    it("returns the list of mappings serialized as plain objects", async () => {
      const m1 = buildMapping();
      const m2 = buildMapping({
        stripePriceId: createStripePriceId("price_OTHER"),
        saleorVariantId: createSaleorVariantId("variant_OTHER"),
        saleorChannelSlug: createSaleorChannelSlug("us-channel"),
      });
      const repo = buildStubRepo({
        list: vi.fn().mockResolvedValue(ok([m1, m2])),
      });
      const { caller } = getTestCaller({ repo });

      const result = await caller.testProcedure();

      expect(result).toStrictEqual({
        mappings: [
          {
            stripePriceId: "price_TEST_LIST",
            saleorVariantId: "variant_TEST_LIST",
            saleorChannelSlug: "default-channel",
            createdAt: FIXED_CREATED.toISOString(),
            updatedAt: FIXED_MODIFIED.toISOString(),
          },
          {
            stripePriceId: "price_OTHER",
            saleorVariantId: "variant_OTHER",
            saleorChannelSlug: "us-channel",
            createdAt: FIXED_CREATED.toISOString(),
            updatedAt: FIXED_MODIFIED.toISOString(),
          },
        ],
      });

      expect(repo.list).toHaveBeenCalledExactlyOnceWith({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
      });
    });

    it("returns an empty mappings array when repo returns []", async () => {
      const repo = buildStubRepo({
        list: vi.fn().mockResolvedValue(ok([])),
      });
      const { caller } = getTestCaller({ repo });

      const result = await caller.testProcedure();

      expect(result).toStrictEqual({ mappings: [] });
    });
  });

  describe("repo error", () => {
    it("maps a repo failure to INTERNAL_SERVER_ERROR (no cause leak)", async () => {
      const repo = buildStubRepo({
        list: vi
          .fn()
          .mockResolvedValue(err(new PriceVariantMapError.PersistenceFailedError("ddb timeout"))),
      });
      const { caller } = getTestCaller({ repo });

      await expect(caller.testProcedure()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[TRPCError: Failed to list price-variant mappings]`,
      );
    });
  });
});
