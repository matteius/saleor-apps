/*
 * @vitest-environment node
 *
 * T38 — reconciliation tRPC sub-router tests.
 *
 * Surface under test (sub-router mounted at `appRouter.reconciliation`):
 *   - runs.listForConnection({ connectionId, limit?, before? }) -> paginated history
 *   - runs.triggerOnDemand({ connectionId })                    -> calls runner.runForConnection
 *   - flags.getForInstall()                                     -> active reconciliation-recommended flags
 *
 * Mocking surface mirrors T34's tests: `verifyJWT` + APL.get are mocked at the
 * SDK boundary, so JWT verification and APL backends never actually run. The
 * runner / repos are stubbed out via the build factory so neither Mongo nor
 * Fief HTTP get touched.
 */
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";
import {
  createProviderConnectionId,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type TrpcContextAppRouter } from "@/modules/trpc/context-app-router";

import {
  type RaiseReconciliationFlagInput,
  type ReconciliationFlagError,
  type ReconciliationFlagReason,
  type ReconciliationFlagRow,
} from "./reconciliation-flag";
import { type ReconciliationFlagRepo } from "./reconciliation-flag-repo";
import {
  type ClaimResult,
  type CompleteInput,
  type ListRecentInput,
  type ReconciliationRunHistoryRepo,
  ReconciliationRunHistoryRepoError,
  type ReconciliationRunRow,
} from "./run-history-repo";
import { type ReconciliationRunner, type RunOutcome } from "./runner";

const SALEOR_API_URL_RAW = "https://shop-recon.saleor.cloud/graphql/";
const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(SALEOR_API_URL_RAW)._unsafeUnwrap();
const APP_ID = "app-id-test";
const APP_TOKEN = "apl-app-token";
const CONNECTION_ID: ProviderConnectionId = createProviderConnectionId(
  "11111111-1111-4111-8111-111111111111",
);

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

const buildRow = (overrides: Partial<ReconciliationRunRow> = {}): ReconciliationRunRow => ({
  id: "run-1",
  saleorApiUrl: SALEOR_API_URL,
  connectionId: CONNECTION_ID,
  startedAt: new Date("2026-05-09T00:00:00Z"),
  completedAt: new Date("2026-05-09T00:00:30Z"),
  status: "ok",
  summary: { total: 5, repaired: 3, skipped: 2, failed: 0 },
  perRowErrors: [],
  ...overrides,
});

class StubRunHistoryRepo implements ReconciliationRunHistoryRepo {
  public listRecentCalls: ListRecentInput[] = [];
  public listRecentImpl: (
    input: ListRecentInput,
  ) => Promise<
    Result<ReconciliationRunRow[], InstanceType<typeof ReconciliationRunHistoryRepoError>>
  > = async (_input) => ok([]);

  async claim(_input: {
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
    startedAt: Date;
  }): Promise<Result<ClaimResult, InstanceType<typeof ReconciliationRunHistoryRepoError>>> {
    throw new Error("claim must not be called from tRPC layer");
  }

  async complete(
    _input: CompleteInput,
  ): Promise<Result<ReconciliationRunRow, InstanceType<typeof ReconciliationRunHistoryRepoError>>> {
    throw new Error("complete must not be called from tRPC layer");
  }

  async listRecent(input: ListRecentInput) {
    this.listRecentCalls.push(input);

    return this.listRecentImpl(input);
  }
}

class StubFlagRepo implements ReconciliationFlagRepo {
  public getCalls: Array<{ saleorApiUrl: SaleorApiUrl }> = [];
  public getImpl: (input: {
    saleorApiUrl: SaleorApiUrl;
  }) => Promise<Result<ReconciliationFlagRow | null, ReconciliationFlagError>> = async () =>
    ok(null);

  async raise(
    _input: RaiseReconciliationFlagInput,
  ): Promise<Result<ReconciliationFlagRow, ReconciliationFlagError>> {
    throw new Error("raise must not be called from tRPC layer");
  }

  async get(input: { saleorApiUrl: SaleorApiUrl }) {
    this.getCalls.push(input);

    return this.getImpl(input);
  }
}

interface StubRunnerImpl {
  runForConnection?: (input: {
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
  }) => Promise<RunOutcome>;
}

const buildStubRunner = (
  impl: StubRunnerImpl = {},
): Pick<ReconciliationRunner, "runForConnection"> => ({
  runForConnection:
    impl.runForConnection ??
    (async ({ connectionId }) => ({
      kind: "ok",
      connectionId,
      runId: "run-fresh",
      summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
      perRowErrors: [],
      finalStatus: "ok",
    })),
});

const buildRouter = async (
  deps: {
    runHistoryRepo?: ReconciliationRunHistoryRepo;
    flagRepo?: ReconciliationFlagRepo;
    runner?: Pick<ReconciliationRunner, "runForConnection">;
  } = {},
) => {
  const { buildReconciliationRouter } = await import("./trpc-router");

  const runHistoryRepo = deps.runHistoryRepo ?? new StubRunHistoryRepo();
  const flagRepo = deps.flagRepo ?? new StubFlagRepo();
  const runner = deps.runner ?? buildStubRunner();

  return buildReconciliationRouter({ runHistoryRepo, flagRepo, runner });
};

afterEach(() => {
  verifyJWTMock.mockReset();
  aplGetMock.mockReset();
});

describe("reconciliation tRPC router (T38)", () => {
  describe("auth", () => {
    it("rejects unauthenticated callers via protectedClientProcedure", async () => {
      // No APL row -> UNAUTHORIZED before the procedure body runs.
      aplGetMock.mockResolvedValueOnce(undefined);

      const router = await buildRouter();
      const caller = router.createCaller(buildCtx({ token: "irrelevant" }));

      await expect(
        caller.runs.listForConnection({ connectionId: CONNECTION_ID }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(verifyJWTMock).not.toHaveBeenCalled();
    });
  });

  describe("runs.listForConnection", () => {
    it("returns paginated rows from the repo", async () => {
      wireAuth();

      const repo = new StubRunHistoryRepo();
      const rows: ReconciliationRunRow[] = [
        buildRow({ id: "row-1", status: "ok" }),
        buildRow({ id: "row-2", status: "failed", runError: "drift threw" }),
      ];

      repo.listRecentImpl = async () => ok(rows);

      const router = await buildRouter({ runHistoryRepo: repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.runs.listForConnection({
        connectionId: CONNECTION_ID,
        limit: 25,
      });

      expect(repo.listRecentCalls).toHaveLength(1);
      expect(repo.listRecentCalls[0]).toMatchObject({
        saleorApiUrl: SALEOR_API_URL,
        connectionId: CONNECTION_ID,
        limit: 25,
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: "row-1", status: "ok" });
      expect(result[1]).toMatchObject({ id: "row-2", status: "failed", runError: "drift threw" });
    });

    it("defaults limit when none supplied", async () => {
      wireAuth();

      const repo = new StubRunHistoryRepo();

      repo.listRecentImpl = async () => ok([]);

      const router = await buildRouter({ runHistoryRepo: repo });
      const caller = router.createCaller(buildCtx());

      await caller.runs.listForConnection({ connectionId: CONNECTION_ID });

      expect(repo.listRecentCalls[0]?.limit).toBeDefined();
    });

    it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const repo = new StubRunHistoryRepo();

      repo.listRecentImpl = async () =>
        err(new ReconciliationRunHistoryRepoError("mongo unavailable"));

      const router = await buildRouter({ runHistoryRepo: repo });
      const caller = router.createCaller(buildCtx());

      await expect(
        caller.runs.listForConnection({ connectionId: CONNECTION_ID }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    });

    it("rejects malformed connectionId via Zod", async () => {
      wireAuth();

      const router = await buildRouter();
      const caller = router.createCaller(buildCtx());

      await expect(
        caller.runs.listForConnection({ connectionId: "not-a-uuid" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("runs.triggerOnDemand", () => {
    it("delegates to runner.runForConnection and returns the started run row", async () => {
      wireAuth();

      const runForConnection = vi.fn(async ({ connectionId }) => ({
        kind: "ok" as const,
        connectionId,
        runId: "run-fresh",
        summary: { total: 1, repaired: 1, skipped: 0, failed: 0 },
        perRowErrors: [],
        finalStatus: "ok" as const,
      }));

      const router = await buildRouter({
        runner: buildStubRunner({ runForConnection }),
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.runs.triggerOnDemand({ connectionId: CONNECTION_ID });

      expect(runForConnection).toHaveBeenCalledTimes(1);
      expect(runForConnection.mock.calls[0][0]).toMatchObject({
        saleorApiUrl: SALEOR_API_URL,
        connectionId: CONNECTION_ID,
      });
      expect(result.outcome).toBe("ok");

      if (result.outcome === "ok") {
        expect(result.runId).toBe("run-fresh");
      }
    });

    it("surfaces the already_running outcome with the active run id", async () => {
      wireAuth();

      const runForConnection = vi.fn(async ({ connectionId }) => ({
        kind: "already_running" as const,
        connectionId,
        activeRunId: "run-in-flight",
      }));

      const router = await buildRouter({
        runner: buildStubRunner({ runForConnection }),
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.runs.triggerOnDemand({ connectionId: CONNECTION_ID });

      expect(result.outcome).toBe("already_running");

      if (result.outcome === "already_running") {
        expect(result.activeRunId).toBe("run-in-flight");
      }
    });

    it("surfaces the kill_switch_disabled outcome", async () => {
      wireAuth();

      const runForConnection = vi.fn(async ({ connectionId }) => ({
        kind: "kill_switch_disabled" as const,
        connectionId,
      }));

      const router = await buildRouter({
        runner: buildStubRunner({ runForConnection }),
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.runs.triggerOnDemand({ connectionId: CONNECTION_ID });

      expect(result.outcome).toBe("kill_switch_disabled");
    });

    it("maps runner error outcome to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const runForConnection = vi.fn(async ({ connectionId }) => ({
        kind: "error" as const,
        connectionId,
        error: "claim failed",
      }));

      const router = await buildRouter({
        runner: buildStubRunner({ runForConnection }),
      });
      const caller = router.createCaller(buildCtx());

      await expect(
        caller.runs.triggerOnDemand({ connectionId: CONNECTION_ID }),
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
    });
  });

  describe("flags.getForInstall", () => {
    it("returns the active flag row when one exists", async () => {
      wireAuth();

      const flagRepo = new StubFlagRepo();

      flagRepo.getImpl = async () =>
        ok({
          saleorApiUrl: SALEOR_API_URL,
          reason: "user_field.updated:abc" as ReconciliationFlagReason,
          raisedByEventId: "evt-1",
          raisedAt: new Date("2026-05-09T00:00:00Z"),
          clearedAt: null,
        });

      const router = await buildRouter({ flagRepo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.flags.getForInstall();

      expect(flagRepo.getCalls).toHaveLength(1);
      expect(result).toMatchObject({
        reason: "user_field.updated:abc",
        raisedByEventId: "evt-1",
        clearedAt: null,
      });
    });

    it("returns null when no flag is raised", async () => {
      wireAuth();

      const flagRepo = new StubFlagRepo();

      flagRepo.getImpl = async () => ok(null);

      const router = await buildRouter({ flagRepo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.flags.getForInstall();

      expect(result).toBeNull();
    });

    it("filters out cleared flags (clearedAt is set)", async () => {
      wireAuth();

      const flagRepo = new StubFlagRepo();

      flagRepo.getImpl = async () =>
        ok({
          saleorApiUrl: SALEOR_API_URL,
          reason: "stale" as ReconciliationFlagReason,
          raisedByEventId: null,
          raisedAt: new Date("2026-05-09T00:00:00Z"),
          clearedAt: new Date("2026-05-09T00:01:00Z"),
        });

      const router = await buildRouter({ flagRepo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.flags.getForInstall();

      // A cleared flag should not be considered "active" for the banner.
      expect(result).toBeNull();
    });
  });
});
