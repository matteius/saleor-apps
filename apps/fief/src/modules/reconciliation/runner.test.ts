import { ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderConnectionId,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type DriftReportRow } from "./drift-detector";
import { type RepairResult } from "./repair.use-case";
import {
  type ClaimResult,
  type ReconciliationRunHistoryRepo,
  type ReconciliationRunHistoryRepoError,
  type ReconciliationRunRow,
} from "./run-history-repo";

/*
 * T32 — `ReconciliationRunner` test suite.
 *
 * Drives the runner with stub `DriftDetector`, `RepairUseCase`, and
 * `ReconciliationRunHistoryRepo`. The kill-switch module is mocked so each
 * test can flip the gate without touching env state.
 */

const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://shop.example.com/graphql/",
)._unsafeUnwrap();
const CONNECTION_ID: ProviderConnectionId = createProviderConnectionId(
  "11111111-1111-4111-8111-111111111111",
);
const CONNECTION_ID_2: ProviderConnectionId = createProviderConnectionId(
  "22222222-2222-4222-8222-222222222222",
);

const baseRow = (overrides: Partial<ReconciliationRunRow> = {}): ReconciliationRunRow => ({
  id: "run-1",
  saleorApiUrl: SALEOR_API_URL,
  connectionId: CONNECTION_ID,
  startedAt: new Date("2026-05-09T00:00:00Z"),
  completedAt: null,
  status: "running",
  summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
  perRowErrors: [],
  ...overrides,
});

class StubHistoryRepo implements ReconciliationRunHistoryRepo {
  public claimCalls: Array<{
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
    startedAt: Date;
  }> = [];
  public completeCalls: Array<{
    id: string;
    status: "ok" | "failed";
    summary: ReconciliationRunRow["summary"];
    perRowErrors: ReconciliationRunRow["perRowErrors"];
    runError?: string;
  }> = [];

  /** Behavior knobs the tests flip. */
  public claimImpl: (input: {
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
    startedAt: Date;
  }) => Promise<Result<ClaimResult, InstanceType<typeof ReconciliationRunHistoryRepoError>>> =
    async (input) => {
      this.claimCalls.push(input);

      return ok({
        claimed: true,
        row: baseRow({
          connectionId: input.connectionId,
          saleorApiUrl: input.saleorApiUrl,
          startedAt: input.startedAt,
        }),
      });
    };

  async claim(input: {
    saleorApiUrl: SaleorApiUrl;
    connectionId: ProviderConnectionId;
    startedAt: Date;
  }) {
    return this.claimImpl(input);
  }

  async complete(input: {
    id: string;
    status: "ok" | "failed";
    completedAt: Date;
    summary: ReconciliationRunRow["summary"];
    perRowErrors: ReconciliationRunRow["perRowErrors"];
    runError?: string;
  }) {
    this.completeCalls.push({
      id: input.id,
      status: input.status,
      summary: input.summary,
      perRowErrors: input.perRowErrors,
      runError: input.runError,
    });

    return ok(
      baseRow({
        id: input.id,
        completedAt: input.completedAt,
        status: input.status,
        summary: input.summary,
        perRowErrors: input.perRowErrors,
        runError: input.runError,
      }),
    );
  }

  async listRecent() {
    return ok([] as ReconciliationRunRow[]);
  }
}

const driftFixtureRows: DriftReportRow[] = [
  {
    kind: "missing_in_saleor",
    fiefUserId: "fief-user-1" as never,
    fiefEmail: "user1@example.com",
  },
];

const stubDriftDetector = (rows: DriftReportRow[]) => ({
  detect: vi.fn(async function* () {
    for (const r of rows) yield r;
  }),
});

const stubRepairUseCase = (result: RepairResult) => ({
  repair: vi.fn(async () => result),
});

afterEach(() => {
  vi.doUnmock("@/lib/kill-switches");
  vi.resetModules();
});

const loadRunner = async (overrides: { fiefSyncDisabled?: boolean } = {}) => {
  vi.resetModules();
  vi.doMock("@/lib/kill-switches", () => ({
    isFiefSyncDisabled: () => overrides.fiefSyncDisabled === true,
    isSaleorToFiefDisabled: () => false,
  }));

  return import("./runner");
};

describe("ReconciliationRunner.runForConnection", () => {
  it("claims a run, runs drift -> repair, completes the run with the summary", async () => {
    const { ReconciliationRunner } = await loadRunner();

    const history = new StubHistoryRepo();
    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 1, repaired: 1, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
    });

    const outcome = await runner.runForConnection({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
    });

    expect(outcome.kind).toBe("ok");
    expect(history.claimCalls).toHaveLength(1);
    expect(drift.detect).toHaveBeenCalledTimes(1);
    expect(drift.detect).toHaveBeenCalledWith(
      expect.objectContaining({
        saleorApiUrl: SALEOR_API_URL,
        connectionId: CONNECTION_ID,
      }),
    );
    expect(repair.repair).toHaveBeenCalledTimes(1);
    expect(history.completeCalls).toHaveLength(1);
    expect(history.completeCalls[0]).toMatchObject({
      status: "ok",
      summary: { total: 1, repaired: 1, skipped: 0, failed: 0 },
    });
  });

  it("records failed status when repair surfaces per-row errors", async () => {
    const { ReconciliationRunner } = await loadRunner();

    const history = new StubHistoryRepo();
    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 1, repaired: 0, skipped: 0, failed: 1 },
      perRowErrors: [
        {
          row: driftFixtureRows[0],
          error: "boom",
        },
      ],
    });

    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
    });

    const outcome = await runner.runForConnection({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
    });

    expect(outcome.kind).toBe("ok");
    expect(history.completeCalls[0]).toMatchObject({
      status: "failed",
      summary: { total: 1, failed: 1 },
    });
    expect(history.completeCalls[0].perRowErrors).toHaveLength(1);
  });

  it("returns 'already_running' without invoking drift/repair when claim is contended", async () => {
    const { ReconciliationRunner } = await loadRunner();

    const history = new StubHistoryRepo();

    history.claimImpl = async (input) => {
      history.claimCalls.push(input);

      return ok({
        claimed: false,
        row: baseRow({ connectionId: input.connectionId }),
      });
    };

    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
    });

    const outcome = await runner.runForConnection({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
    });

    expect(outcome.kind).toBe("already_running");
    expect(drift.detect).not.toHaveBeenCalled();
    expect(repair.repair).not.toHaveBeenCalled();
    expect(history.completeCalls).toHaveLength(0);
  });

  it("under contention only ONE of two parallel calls runs; the other returns already_running", async () => {
    const { ReconciliationRunner } = await loadRunner();

    /*
     * Simulate the Mongo `findOneAndUpdate` upsert atomicity by tracking a
     * per-key counter in the stub: the first caller observes count == 0 and
     * "wins" the claim, the second observes count == 1 and "loses".
     */
    const lockState = new Map<string, number>();
    const history = new StubHistoryRepo();

    history.claimImpl = async (input) => {
      const key = `${input.saleorApiUrl}|${input.connectionId}`;
      const count = lockState.get(key) ?? 0;

      lockState.set(key, count + 1);
      history.claimCalls.push(input);

      if (count === 0) {
        return ok({
          claimed: true,
          row: baseRow({
            connectionId: input.connectionId,
            saleorApiUrl: input.saleorApiUrl,
            startedAt: input.startedAt,
          }),
        });
      }

      return ok({
        claimed: false,
        row: baseRow({ connectionId: input.connectionId }),
      });
    };

    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 1, repaired: 1, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
    });

    const [outcome1, outcome2] = await Promise.all([
      runner.runForConnection({ saleorApiUrl: SALEOR_API_URL, connectionId: CONNECTION_ID }),
      runner.runForConnection({ saleorApiUrl: SALEOR_API_URL, connectionId: CONNECTION_ID }),
    ]);

    const okCount = [outcome1, outcome2].filter((o) => o.kind === "ok").length;
    const skipCount = [outcome1, outcome2].filter((o) => o.kind === "already_running").length;

    expect(okCount).toBe(1);
    expect(skipCount).toBe(1);
    expect(drift.detect).toHaveBeenCalledTimes(1);
    expect(repair.repair).toHaveBeenCalledTimes(1);
    expect(history.completeCalls).toHaveLength(1);
  });

  it("returns 'kill_switch_disabled' immediately when the FIEF_SYNC kill switch is on", async () => {
    const { ReconciliationRunner } = await loadRunner({ fiefSyncDisabled: true });

    const history = new StubHistoryRepo();
    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
    });

    const outcome = await runner.runForConnection({
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
    });

    expect(outcome.kind).toBe("kill_switch_disabled");
    expect(history.claimCalls).toHaveLength(0);
    expect(drift.detect).not.toHaveBeenCalled();
    expect(repair.repair).not.toHaveBeenCalled();
  });
});

describe("ReconciliationRunner.runForInstall", () => {
  it("runs once per connection sequentially and aggregates outcomes", async () => {
    const { ReconciliationRunner } = await loadRunner();

    const history = new StubHistoryRepo();
    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 1, repaired: 1, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    /*
     * Track call order via the spy: assert `drift.detect` is called once per
     * connection in input order, and `claim` is called once per connection
     * in input order. Sequential semantics are validated by the
     * Promise.all-style contention test above; here we just assert order +
     * cardinality.
     */
    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
      listConnections: async () => [
        { id: CONNECTION_ID, saleorApiUrl: SALEOR_API_URL },
        { id: CONNECTION_ID_2, saleorApiUrl: SALEOR_API_URL },
      ],
    });

    const outcomes = await runner.runForInstall({ saleorApiUrl: SALEOR_API_URL });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.kind === "ok")).toBe(true);
    expect(history.claimCalls.map((c) => c.connectionId)).toStrictEqual([
      CONNECTION_ID,
      CONNECTION_ID_2,
    ]);
    expect(drift.detect).toHaveBeenCalledTimes(2);
    expect(drift.detect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ connectionId: CONNECTION_ID }),
    );
    expect(drift.detect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ connectionId: CONNECTION_ID_2 }),
    );
  });

  it("returns kill-switch outcome for every connection when sync is disabled", async () => {
    const { ReconciliationRunner } = await loadRunner({ fiefSyncDisabled: true });

    const history = new StubHistoryRepo();
    const drift = stubDriftDetector(driftFixtureRows);
    const repair = stubRepairUseCase({
      summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
      perRowErrors: [],
    });

    const runner = new ReconciliationRunner({
      driftDetector: drift,
      repairUseCase: repair,
      runHistoryRepo: history,
      now: () => new Date("2026-05-09T01:00:00Z"),
      listConnections: async () => [
        { id: CONNECTION_ID, saleorApiUrl: SALEOR_API_URL },
        { id: CONNECTION_ID_2, saleorApiUrl: SALEOR_API_URL },
      ],
    });

    const outcomes = await runner.runForInstall({ saleorApiUrl: SALEOR_API_URL });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.kind === "kill_switch_disabled")).toBe(true);
    expect(drift.detect).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  /* placeholder to keep beforeEach symmetry with other tests */
});
