/*
 * @vitest-environment node
 *
 * T34 — channel-configuration tRPC router tests.
 *
 * The router exposes two procedures:
 *   - `channelConfig.get` — returns the persisted ChannelConfiguration for
 *     the install (or null if none has been written yet).
 *   - `channelConfig.upsert` — full-replace of the configuration document.
 *
 * Like the connections sub-router, both are mounted behind
 * `protectedClientProcedure` so the dashboard JWT + APL auth runs first; we
 * mock that boundary the same way `protected-client-procedure.test.ts` (T33)
 * does. The repo is replaced with a test double so Mongo never gets touched.
 */
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type TrpcContextAppRouter } from "@/modules/trpc/context-app-router";

import {
  type ChannelConfiguration,
  channelConfigurationSchema,
  createChannelSlug,
  createConnectionId,
  DISABLED_CHANNEL,
} from "./channel-configuration";
import {
  ChannelConfigurationRepoError,
  type ChannelConfigurationRepoErrorInstance,
  type IChannelConfigurationRepo,
} from "./channel-configuration-repo";

const SALEOR_API_URL_RAW = "https://shop-cfg.saleor.cloud/graphql/";
const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(SALEOR_API_URL_RAW)._unsafeUnwrap();
const APP_ID = "app-id-test";
const APP_TOKEN = "apl-app-token";

/*
 * Mocks for the protected-client-procedure auth chain. Match the seam used
 * in `protected-client-procedure.test.ts` so tests stay isolated from JWT
 * verification + APL backends.
 */
const verifyJWTMock = vi.fn();
const aplGetMock = vi.fn();

vi.mock("@saleor/app-sdk/auth", () => ({
  verifyJWT: (...args: unknown[]) => verifyJWTMock(...args),
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      get: (...args: unknown[]) => aplGetMock(...args),
    },
  },
}));

const buildCtx = (overrides: Partial<TrpcContextAppRouter> = {}): TrpcContextAppRouter => ({
  saleorApiUrl: SALEOR_API_URL_RAW,
  token: "frontend-jwt-irrelevant-because-mocked",
  appId: undefined,
  appUrl: null,
  logger: createLogger("test"),
  ...overrides,
});

const wireAuth = () => {
  aplGetMock.mockResolvedValue({
    saleorApiUrl: SALEOR_API_URL_RAW,
    appId: APP_ID,
    token: APP_TOKEN,
  });
  verifyJWTMock.mockResolvedValue(undefined);
};

class FakeChannelConfigurationRepo implements IChannelConfigurationRepo {
  public configsByUrl = new Map<string, ChannelConfiguration | null>();
  public errorOnGet: ChannelConfigurationRepoErrorInstance | null = null;
  public errorOnUpsert: ChannelConfigurationRepoErrorInstance | null = null;
  public lastUpsert: ChannelConfiguration | null = null;

  async get(
    url: SaleorApiUrl,
  ): Promise<Result<ChannelConfiguration | null, ChannelConfigurationRepoErrorInstance>> {
    if (this.errorOnGet) return err(this.errorOnGet);

    return ok(this.configsByUrl.get(url) ?? null);
  }

  async upsert(
    config: ChannelConfiguration,
  ): Promise<Result<void, ChannelConfigurationRepoErrorInstance>> {
    if (this.errorOnUpsert) return err(this.errorOnUpsert);
    this.lastUpsert = config;
    this.configsByUrl.set(config.saleorApiUrl, config);

    return ok(undefined);
  }
}

afterEach(() => {
  verifyJWTMock.mockReset();
  aplGetMock.mockReset();
});

describe("channelConfig tRPC router (T34)", () => {
  describe("auth", () => {
    it("rejects unauthenticated callers via protectedClientProcedure", async () => {
      // No APL row -> UNAUTHORIZED before the procedure body runs.
      aplGetMock.mockResolvedValueOnce(undefined);

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();
      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx({ token: "irrelevant" }));

      await expect(caller.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(verifyJWTMock).not.toHaveBeenCalled();
    });
  });

  describe("get", () => {
    it("returns null when no config exists", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();
      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.get();

      expect(result).toBeNull();
    });

    it("returns the persisted ChannelConfiguration when present", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();
      const config: ChannelConfiguration = channelConfigurationSchema.parse({
        saleorApiUrl: SALEOR_API_URL_RAW,
        defaultConnectionId: "conn-default",
        overrides: [
          { channelSlug: "us", connectionId: "conn-us" },
          { channelSlug: "eu-disabled", connectionId: DISABLED_CHANNEL },
        ],
      });

      repo.configsByUrl.set(SALEOR_API_URL, config);

      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.get();

      expect(result).toStrictEqual(config);
    });

    it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();

      repo.errorOnGet = new ChannelConfigurationRepoError("mongo unavailable");

      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(caller.get()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
    });
  });

  describe("upsert", () => {
    it("full-replace persists the supplied config and returns it", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();
      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.upsert({
        defaultConnectionId: "conn-default",
        overrides: [
          { channelSlug: "us", connectionId: "conn-us" },
          { channelSlug: "eu", connectionId: DISABLED_CHANNEL },
        ],
      });

      expect(repo.lastUpsert).not.toBeNull();
      expect(repo.lastUpsert?.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(repo.lastUpsert?.defaultConnectionId).toStrictEqual(
        createConnectionId("conn-default"),
      );
      expect(repo.lastUpsert?.overrides).toStrictEqual([
        { channelSlug: createChannelSlug("us"), connectionId: createConnectionId("conn-us") },
        { channelSlug: createChannelSlug("eu"), connectionId: DISABLED_CHANNEL },
      ]);

      // Returned config matches what was persisted (round-trip).
      expect(result.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(result.defaultConnectionId).toStrictEqual(createConnectionId("conn-default"));
    });

    it("accepts a null defaultConnectionId (clears the default)", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();
      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.upsert({
        defaultConnectionId: null,
        overrides: [],
      });

      expect(repo.lastUpsert?.defaultConnectionId).toBeNull();
      expect(repo.lastUpsert?.overrides).toStrictEqual([]);
      expect(result.defaultConnectionId).toBeNull();
    });

    it("rejects malformed input via Zod (BAD_REQUEST)", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();
      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(
        caller.upsert({
          // @ts-expect-error - intentional bad shape
          defaultConnectionId: 42,
          overrides: [],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(repo.lastUpsert).toBeNull();
    });

    it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const { buildChannelConfigRouter } = await import("./trpc-router");
      const repo = new FakeChannelConfigurationRepo();

      repo.errorOnUpsert = new ChannelConfigurationRepoError("mongo unavailable");

      const router = buildChannelConfigRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(
        caller.upsert({
          defaultConnectionId: "conn-default",
          overrides: [],
        }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    });
  });
});
