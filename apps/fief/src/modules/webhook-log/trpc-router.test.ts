/*
 * @vitest-environment node
 *
 * T37 — `webhookLog` tRPC router tests.
 *
 * Two procedures, both behind `protectedClientProcedure`:
 *   - `webhookLog.list({ connectionId?, direction?, status?, limit?, before? })`
 *     returns the most recent rows for the install (sorted by createdAt desc).
 *   - `webhookLog.getPayload({ id })` returns the redacted payload JSON for a
 *     single row (the dashboard uses this to lazily render the "view payload"
 *     panel rather than fetching every payload up-front).
 *
 * Auth seam matches `dlq/replay.use-case.test.ts` and the channel-config
 * router test — module-scoped `verifyJWTMock`/`aplGetMock` so vitest hoists
 * the `vi.mock(...)` calls correctly.
 */
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type TrpcContextAppRouter } from "@/modules/trpc/context-app-router";

import {
  createWebhookEventId,
  createWebhookLogConnectionId,
  createWebhookLogId,
  type WebhookLog,
  type WebhookLogId,
} from "./webhook-log";
import {
  type RecordAttemptResult,
  type RecordWebhookLogInput,
  type WebhookLogFilters,
  type WebhookLogRepo,
  WebhookLogRepoError,
} from "./webhook-log-repo";

const SALEOR_API_URL_RAW = "https://shop-health.saleor.cloud/graphql/";
const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(SALEOR_API_URL_RAW)._unsafeUnwrap();
const APP_ID = "app-id-test";
const APP_TOKEN = "apl-app-token";

/*
 * Auth chain mocks — same seam as `protected-client-procedure.test.ts` and
 * other sub-router tests in this module so JWT verification + APL
 * backends stay out of the picture.
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

const buildLog = (overrides?: Partial<WebhookLog>): WebhookLog => ({
  id: createWebhookLogId("log-1")._unsafeUnwrap(),
  saleorApiUrl: SALEOR_API_URL,
  connectionId: createWebhookLogConnectionId(
    "11111111-1111-4111-8111-111111111111",
  )._unsafeUnwrap(),
  direction: "fief_to_saleor",
  eventId: createWebhookEventId("evt-1")._unsafeUnwrap(),
  eventType: "user.created",
  status: "ok",
  attempts: 1,
  payloadRedacted: { id: "fief-user-1", email: "u@example.com" },
  ttl: new Date("2026-06-01T00:00:00Z"),
  createdAt: new Date("2026-05-01T00:00:00Z"),
  ...(overrides ?? {}),
});

class FakeWebhookLogRepo implements WebhookLogRepo {
  public rows: WebhookLog[] = [];
  public lastListFilters: WebhookLogFilters | null = null;
  public errorOnList: InstanceType<typeof WebhookLogRepoError> | null = null;
  public errorOnGetById: InstanceType<typeof WebhookLogRepoError> | null = null;

  async record(
    _input: RecordWebhookLogInput,
  ): Promise<Result<WebhookLog, InstanceType<typeof WebhookLogRepoError>>> {
    throw new Error("record not used in router tests");
  }
  async dedupCheck(): Promise<Result<boolean, InstanceType<typeof WebhookLogRepoError>>> {
    throw new Error("dedupCheck not used in router tests");
  }
  async recordAttempt(): Promise<
    Result<RecordAttemptResult, InstanceType<typeof WebhookLogRepoError>>
  > {
    throw new Error("recordAttempt not used in router tests");
  }
  async moveToDlq(): Promise<Result<WebhookLogId, InstanceType<typeof WebhookLogRepoError>>> {
    throw new Error("moveToDlq not used in router tests");
  }

  async list(
    filters: WebhookLogFilters,
  ): Promise<Result<WebhookLog[], InstanceType<typeof WebhookLogRepoError>>> {
    this.lastListFilters = filters;
    if (this.errorOnList) return err(this.errorOnList);

    return ok(this.rows);
  }

  async getById(
    id: WebhookLogId,
  ): Promise<Result<WebhookLog | null, InstanceType<typeof WebhookLogRepoError>>> {
    if (this.errorOnGetById) return err(this.errorOnGetById);
    const row = this.rows.find((r) => r.id === id) ?? null;

    return ok(row);
  }
}

afterEach(() => {
  verifyJWTMock.mockReset();
  aplGetMock.mockReset();
});

describe("webhookLog tRPC router (T37)", () => {
  describe("auth", () => {
    it("rejects unauthenticated callers via protectedClientProcedure", async () => {
      aplGetMock.mockResolvedValueOnce(undefined);

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();
      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx({ token: "irrelevant" }));

      await expect(caller.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(verifyJWTMock).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("forwards saleorApiUrl from context to the repo and returns rows", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.rows = [buildLog()];

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.list({});

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.id).toBe("log-1");
      expect(repo.lastListFilters?.saleorApiUrl).toBe(SALEOR_API_URL);
    });

    it("filters by direction at the repo level", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();
      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await caller.list({ direction: "saleor_to_fief" });

      expect(repo.lastListFilters?.direction).toBe("saleor_to_fief");
    });

    it("filters by status at the repo level", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();
      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await caller.list({ status: "dead" });

      expect(repo.lastListFilters?.status).toBe("dead");
    });

    it("filters out rows that don't match a supplied connectionId", async () => {
      wireAuth();

      const matchingId = "11111111-1111-4111-8111-111111111111";
      const otherId = "22222222-2222-4222-8222-222222222222";

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.rows = [
        buildLog({
          id: createWebhookLogId("log-a")._unsafeUnwrap(),
          connectionId: createWebhookLogConnectionId(matchingId)._unsafeUnwrap(),
        }),
        buildLog({
          id: createWebhookLogId("log-b")._unsafeUnwrap(),
          connectionId: createWebhookLogConnectionId(otherId)._unsafeUnwrap(),
        }),
      ];

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.list({ connectionId: matchingId });

      expect(result.rows.map((r) => r.id)).toStrictEqual(["log-a"]);
    });

    it("filters out rows older than the supplied `before` cursor", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.rows = [
        buildLog({
          id: createWebhookLogId("log-new")._unsafeUnwrap(),
          createdAt: new Date("2026-05-01T12:00:00Z"),
        }),
        buildLog({
          id: createWebhookLogId("log-old")._unsafeUnwrap(),
          createdAt: new Date("2026-04-01T12:00:00Z"),
        }),
      ];

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.list({ before: "2026-04-15T00:00:00.000Z" });

      expect(result.rows.map((r) => r.id)).toStrictEqual(["log-old"]);
    });

    it("redacts the payload field from the list response (use getPayload to fetch)", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.rows = [
        buildLog({
          payloadRedacted: { secret: "never-show-this-on-list" },
        }),
      ];

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.list({});

      // Row shape excludes the bulky payload — `getPayload` is the explicit fetch.
      expect("payloadRedacted" in (result.rows[0] ?? {})).toBe(false);
      expect(JSON.stringify(result.rows[0])).not.toContain("never-show-this-on-list");
    });

    it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.errorOnList = new WebhookLogRepoError("mongo down");

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(caller.list({})).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    });
  });

  describe("getPayload", () => {
    it("returns the redacted payload JSON for the requested row", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.rows = [
        buildLog({
          id: createWebhookLogId("log-payload")._unsafeUnwrap(),
          payloadRedacted: { hello: "world" },
        }),
      ];

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.getPayload({ id: "log-payload" });

      expect(result.payloadRedacted).toStrictEqual({ hello: "world" });
    });

    it("returns NOT_FOUND when the row is missing", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();
      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(caller.getPayload({ id: "missing" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("returns NOT_FOUND when the row belongs to a different tenant", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();
      const otherTenantUrl = createSaleorApiUrl(
        "https://other-tenant.saleor.cloud/graphql/",
      )._unsafeUnwrap();

      repo.rows = [
        buildLog({
          id: createWebhookLogId("log-other-tenant")._unsafeUnwrap(),
          saleorApiUrl: otherTenantUrl,
        }),
      ];

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(caller.getPayload({ id: "log-other-tenant" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const { buildWebhookLogRouter } = await import("./trpc-router");
      const repo = new FakeWebhookLogRepo();

      repo.errorOnGetById = new WebhookLogRepoError("mongo down");

      const router = buildWebhookLogRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(caller.getPayload({ id: "log-1" })).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
    });
  });
});
