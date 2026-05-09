/* @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * T32 — `POST /api/cron/reconcile` route tests.
 *
 * Behaviour under test:
 *   1. Bad shared secret → 401, no work dispatched.
 *   2. Missing shared secret → 401, no work dispatched.
 *   3. Valid shared secret → 200 with a per-connection summary; runner is
 *      invoked once per connection across every install in the APL.
 *   4. Multi-install + multi-connection: per-install runner invocations are
 *      sequential (assert order via spy capture).
 */

const { runForInstallMock, runForConnectionMock, ReconciliationRunnerMock } = vi.hoisted(() => {
  const runForInstall = vi.fn();
  const runForConnection = vi.fn();
  const ctor = vi.fn().mockImplementation(() => ({
    runForInstall,
    runForConnection,
  }));

  return {
    runForInstallMock: runForInstall,
    runForConnectionMock: runForConnection,
    ReconciliationRunnerMock: ctor,
  };
});

const { aplGetAllMock } = vi.hoisted(() => ({ aplGetAllMock: vi.fn() }));

vi.mock("@/modules/reconciliation/runner", () => ({
  ReconciliationRunner: ReconciliationRunnerMock,
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      getAll: aplGetAllMock,
    },
  },
  apl: {
    getAll: aplGetAllMock,
  },
}));

vi.mock("./deps", () => ({
  buildReconciliationRunnerDeps: vi.fn(() => ({
    driftDetector: { detect: vi.fn() },
    repairUseCase: { repair: vi.fn() },
    runHistoryRepo: {
      claim: vi.fn(),
      complete: vi.fn(),
      listRecent: vi.fn(),
    },
    listConnections: vi.fn(async () => []),
  })),
}));

vi.mock("@/lib/env", () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_PLUGIN_HMAC_SECRET: "test-plugin-hmac-secret",
    CRON_SECRET: "test-cron-secret",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
  },
}));

const ROUTE_URL = "https://app.test/api/cron/reconcile";

const buildRequest = (input: { secret?: string }) => {
  const headers = new Headers();

  if (input.secret !== undefined) {
    headers.set("x-cron-secret", input.secret);
  }

  const req = new Request(ROUTE_URL, {
    method: "POST",
    headers,
  });

  Object.defineProperty(req, "nextUrl", {
    value: new URL(ROUTE_URL),
  });

  return req;
};

beforeEach(() => {
  runForInstallMock.mockReset();
  runForConnectionMock.mockReset();
  ReconciliationRunnerMock.mockReset();
  ReconciliationRunnerMock.mockImplementation(() => ({
    runForInstall: runForInstallMock,
    runForConnection: runForConnectionMock,
  }));
  aplGetAllMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /api/cron/reconcile", () => {
  it("returns 401 when X-Cron-Secret header is missing", async () => {
    const route = await import("./route");

    const response = await route.POST(buildRequest({}) as never);

    expect(response.status).toBe(401);
    expect(runForInstallMock).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Cron-Secret header does not match env.CRON_SECRET", async () => {
    const route = await import("./route");

    const response = await route.POST(buildRequest({ secret: "wrong" }) as never);

    expect(response.status).toBe(401);
    expect(runForInstallMock).not.toHaveBeenCalled();
  });

  it("returns 200 when X-Cron-Secret matches and dispatches per-install reconciliation", async () => {
    aplGetAllMock.mockResolvedValueOnce([
      { saleorApiUrl: "https://shop1.example.com/graphql/", token: "t1", appId: "app-1" },
    ]);
    runForInstallMock.mockResolvedValueOnce([{ kind: "ok", connectionId: "conn-a" }]);

    const route = await import("./route");

    const response = await route.POST(buildRequest({ secret: "test-cron-secret" }) as never);

    expect(response.status).toBe(200);
    expect(runForInstallMock).toHaveBeenCalledTimes(1);
    expect(runForInstallMock).toHaveBeenCalledWith(
      expect.objectContaining({ saleorApiUrl: "https://shop1.example.com/graphql/" }),
    );
  });

  it("calls runForInstall sequentially across multiple installs in APL order", async () => {
    aplGetAllMock.mockResolvedValueOnce([
      { saleorApiUrl: "https://shop1.example.com/graphql/", token: "t1", appId: "app-1" },
      { saleorApiUrl: "https://shop2.example.com/graphql/", token: "t2", appId: "app-2" },
      { saleorApiUrl: "https://shop3.example.com/graphql/", token: "t3", appId: "app-3" },
    ]);

    /*
     * Capture the order in which runForInstall is called AND prove that the
     * call N+1 awaits N. We do that by resolving each call to runForInstall
     * with a microtask chain and asserting only one is in-flight at a time.
     */
    const callOrder: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;

    runForInstallMock.mockImplementation(async (input: { saleorApiUrl: string }) => {
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      callOrder.push(input.saleorApiUrl);
      // Yield a couple of microtasks; if calls were parallel they'd overlap.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;

      return [];
    });

    const route = await import("./route");

    const response = await route.POST(buildRequest({ secret: "test-cron-secret" }) as never);

    expect(response.status).toBe(200);
    expect(callOrder).toStrictEqual([
      "https://shop1.example.com/graphql/",
      "https://shop2.example.com/graphql/",
      "https://shop3.example.com/graphql/",
    ]);
    expect(peakInFlight).toBe(1);
  });

  it("returns 200 even when an install's runForInstall throws — error is captured per-install", async () => {
    aplGetAllMock.mockResolvedValueOnce([
      { saleorApiUrl: "https://shop1.example.com/graphql/", token: "t1", appId: "app-1" },
      { saleorApiUrl: "https://shop2.example.com/graphql/", token: "t2", appId: "app-2" },
    ]);

    runForInstallMock
      .mockImplementationOnce(async () => {
        throw new Error("install-1 boom");
      })
      .mockImplementationOnce(async () => []);

    const route = await import("./route");

    const response = await route.POST(buildRequest({ secret: "test-cron-secret" }) as never);

    expect(response.status).toBe(200);
    expect(runForInstallMock).toHaveBeenCalledTimes(2);
  });
});
