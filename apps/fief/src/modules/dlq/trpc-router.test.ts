/*
 * @vitest-environment node
 *
 * T37 — `dlq` tRPC router tests for the new `list` procedure.
 *
 * The existing `dlq.replay` mutation has its own test suite under
 * `replay.use-case.test.ts` (T51); this file covers the `list` procedure
 * added by T37 so the dashboard can read DLQ entries scoped to the
 * current install.
 *
 *   - `dlq.list({ connectionId?, limit?, before? })`
 *
 * Auth seam mirrors the other sub-router tests in this monorepo.
 */
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type TrpcContextAppRouter } from "@/modules/trpc/context-app-router";

import { type DlqEntry, type DlqEntryId } from "./dlq";
import { type DlqFilters, type DlqNotFoundError, type DlqRepo, DlqRepoError } from "./dlq-repo";
import { type DlqReplayResult, type DlqReplayUseCase } from "./replay.use-case";

const SALEOR_API_URL_RAW = "https://shop-dlq-list.saleor.cloud/graphql/";
const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(SALEOR_API_URL_RAW)._unsafeUnwrap();
const APP_ID = "app-id-test";
const APP_TOKEN = "apl-app-token";

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

const buildEntry = (overrides?: Partial<DlqEntry>): DlqEntry =>
  ({
    id: "dlq-1" as unknown as DlqEntryId,
    saleorApiUrl: SALEOR_API_URL,
    connectionId: "11111111-1111-4111-8111-111111111111" as DlqEntry["connectionId"],
    direction: "fief_to_saleor",
    eventId: "evt-1" as DlqEntry["eventId"],
    eventType: "user.created",
    status: "dead",
    attempts: 6,
    payloadRedacted: { id: "fief-user-1" },
    createdAt: new Date("2026-05-01T00:00:00Z"),
    movedToDlqAt: new Date("2026-05-01T00:05:00Z"),
    ...(overrides ?? {}),
  }) as DlqEntry;

class FakeDlqRepo implements DlqRepo {
  public rows: DlqEntry[] = [];
  public lastListFilters: DlqFilters | null = null;
  public errorOnList: InstanceType<typeof DlqRepoError> | null = null;

  async add(): Promise<Result<void, InstanceType<typeof DlqRepoError>>> {
    throw new Error("add not used in router list tests");
  }
  async list(filters: DlqFilters): Promise<Result<DlqEntry[], InstanceType<typeof DlqRepoError>>> {
    this.lastListFilters = filters;
    if (this.errorOnList) return err(this.errorOnList);

    return ok(this.rows);
  }
  async getById(): Promise<Result<DlqEntry | null, InstanceType<typeof DlqRepoError>>> {
    throw new Error("getById not used in router list tests");
  }
  async delete(): Promise<
    Result<void, InstanceType<typeof DlqRepoError | typeof DlqNotFoundError>>
  > {
    throw new Error("delete not used in router list tests");
  }
}

const stubReplayUseCase = (): Pick<DlqReplayUseCase, "replay"> => ({
  replay: async () => ok({ replayed: true, direction: "fief_to_saleor" } as DlqReplayResult),
});

afterEach(() => {
  verifyJWTMock.mockReset();
  aplGetMock.mockReset();
});

describe("dlq.list tRPC procedure (T37)", () => {
  it("rejects unauthenticated callers via protectedClientProcedure", async () => {
    aplGetMock.mockResolvedValueOnce(undefined);

    const { buildDlqRouter } = await import("./trpc-router");
    const repo = new FakeDlqRepo();
    const router = buildDlqRouter({ useCase: stubReplayUseCase(), repo });
    const caller = router.createCaller(buildCtx({ token: "irrelevant" }));

    await expect(caller.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(verifyJWTMock).not.toHaveBeenCalled();
  });

  it("returns rows scoped to the current saleorApiUrl", async () => {
    wireAuth();

    const { buildDlqRouter } = await import("./trpc-router");
    const repo = new FakeDlqRepo();

    repo.rows = [buildEntry()];

    const router = buildDlqRouter({ useCase: stubReplayUseCase(), repo });
    const caller = router.createCaller(buildCtx());

    const result = await caller.list({});

    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.id).toBe("dlq-1");
    expect(repo.lastListFilters?.saleorApiUrl).toBe(SALEOR_API_URL);
  });

  it("filters by connectionId in the router (post-fetch)", async () => {
    wireAuth();

    const matchingId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";

    const { buildDlqRouter } = await import("./trpc-router");
    const repo = new FakeDlqRepo();

    repo.rows = [
      buildEntry({
        id: "dlq-a" as unknown as DlqEntryId,
        connectionId: matchingId as DlqEntry["connectionId"],
      }),
      buildEntry({
        id: "dlq-b" as unknown as DlqEntryId,
        connectionId: otherId as DlqEntry["connectionId"],
      }),
    ];

    const router = buildDlqRouter({ useCase: stubReplayUseCase(), repo });
    const caller = router.createCaller(buildCtx());

    const result = await caller.list({ connectionId: matchingId });

    expect(result.rows.map((r) => r.id)).toStrictEqual(["dlq-a"]);
  });

  it("filters by `before` cursor against movedToDlqAt", async () => {
    wireAuth();

    const { buildDlqRouter } = await import("./trpc-router");
    const repo = new FakeDlqRepo();

    repo.rows = [
      buildEntry({
        id: "dlq-new" as unknown as DlqEntryId,
        movedToDlqAt: new Date("2026-05-01T12:00:00Z"),
      }),
      buildEntry({
        id: "dlq-old" as unknown as DlqEntryId,
        movedToDlqAt: new Date("2026-04-01T12:00:00Z"),
      }),
    ];

    const router = buildDlqRouter({ useCase: stubReplayUseCase(), repo });
    const caller = router.createCaller(buildCtx());

    const result = await caller.list({ before: "2026-04-15T00:00:00.000Z" });

    expect(result.rows.map((r) => r.id)).toStrictEqual(["dlq-old"]);
  });

  it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
    wireAuth();

    const { buildDlqRouter } = await import("./trpc-router");
    const repo = new FakeDlqRepo();

    repo.errorOnList = new DlqRepoError("mongo down");

    const router = buildDlqRouter({ useCase: stubReplayUseCase(), repo });
    const caller = router.createCaller(buildCtx());

    await expect(caller.list({})).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
