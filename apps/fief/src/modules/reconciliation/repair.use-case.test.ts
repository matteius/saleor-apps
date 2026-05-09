// cspell:ignore upsert reconcile dispatcher

import { err, ok, type Result } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import type { IdentityMapRow, SaleorApiUrl } from "@/modules/identity-map/identity-map";
import {
  type UserDeleteOutcome,
  type UserDeleteUseCase,
  type UserDeleteUseCaseError,
} from "@/modules/sync/fief-to-saleor/user-delete.use-case";
import {
  type UserUpsertOutcome,
  type UserUpsertUseCase,
  type UserUpsertUseCaseError,
} from "@/modules/sync/fief-to-saleor/user-upsert.use-case";
import {
  type CustomerCreatedJobPayload,
  type CustomerCreatedOutcome,
  type CustomerCreatedUseCase,
  type CustomerCreatedUseCaseErrorInstance,
} from "@/modules/sync/saleor-to-fief/customer-created.use-case";
import {
  type CustomerDeletedJobPayload,
  type CustomerDeletedOutcome,
  type CustomerDeletedUseCase,
  type CustomerDeletedUseCaseErrorInstance,
} from "@/modules/sync/saleor-to-fief/customer-deleted.use-case";

import type { DriftReportRow } from "./drift-detector";

/*
 * T31 — RepairUseCase unit tests.
 *
 * The repair use case consumes a `DriftReportRow` stream from T30 and
 * delegates to the existing sync use cases (T23/T24/T26/T29). It MUST NEVER
 * write to repos directly — every repair flows through a sync use case so
 * loop guard, claims projection, and origin marker behavior is identical to
 * push-mode sync.
 *
 * Tests use in-memory fakes for ALL four sync use cases. The fakes count
 * invocations and capture inputs so we can assert dispatch behavior without
 * touching real Saleor / Fief / Mongo.
 */

// ---------- Test helpers ----------

const SALEOR_URL = "https://shop-1.saleor.cloud/graphql/" as unknown as SaleorApiUrl;

const FIEF_USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIEF_USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIEF_USER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FIEF_USER_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIEF_USER_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const SALEOR_USER_B = "VXNlcjoy";
const SALEOR_USER_ORPHAN = "VXNlcjpvcnBoYW4=";
const SALEOR_USER_STALE_ID_S = "VXNlcjpzdGFsZQ==";
const SALEOR_USER_STALE_ID_F = "VXNlcjpnaG9zdA==";

const makeIdentityMapRow = (overrides: {
  saleorUserId: string;
  fiefUserId: string;
  saleorApiUrl?: string;
  lastSyncSeq?: number;
}): IdentityMapRow =>
  ({
    saleorApiUrl: overrides.saleorApiUrl ?? (SALEOR_URL as unknown as string),
    saleorUserId: overrides.saleorUserId,
    fiefUserId: overrides.fiefUserId,
    lastSyncSeq: overrides.lastSyncSeq ?? 0,
    lastSyncedAt: new Date("2026-05-09T00:00:00Z"),
  }) as unknown as IdentityMapRow;

// ---------- Fake use cases ----------

interface FakeUserUpsertCall {
  fiefUserId: string;
  email: string;
}

class FakeUserUpsertUseCase {
  public calls: FakeUserUpsertCall[] = [];

  public failOnFiefUserIds = new Set<string>();

  public hangOnFiefUserIds = new Set<string>();

  /** Active in-flight count — used by the concurrency-limit test. */
  public inFlight = 0;

  public peakInFlight = 0;

  private resolvers = new Map<string, () => void>();

  /**
   * Mimics `UserUpsertUseCase.execute({ saleorApiUrl, claimMapping, payload })`.
   * The repair use case calls this entry point, so we match its signature so a
   * structural `Pick<UserUpsertUseCase, "execute">`-style typing works in
   * production wiring.
   */
  async execute(input: {
    saleorApiUrl: SaleorApiUrl;
    claimMapping: readonly unknown[];
    payload: { type: string; data: Record<string, unknown>; eventId: string };
  }): Promise<Result<UserUpsertOutcome, UserUpsertUseCaseError>> {
    const fiefUserId = String(input.payload.data["id"] ?? "");
    const email = String(input.payload.data["email"] ?? "");

    this.calls.push({ fiefUserId, email });
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);

    try {
      if (this.hangOnFiefUserIds.has(fiefUserId)) {
        await new Promise<void>((resolve) => {
          this.resolvers.set(fiefUserId, resolve);
        });
      }

      if (this.failOnFiefUserIds.has(fiefUserId)) {
        return err(new Error(`upsert failed for ${fiefUserId}`) as UserUpsertUseCaseError);
      }

      return ok({
        kind: "written",
        saleorUserId: "stub" as unknown as UserUpsertOutcome extends { saleorUserId: infer X }
          ? X
          : never,
        wasInserted: true,
        writtenSeq: 1 as unknown as UserUpsertOutcome extends { writtenSeq: infer X } ? X : never,
      } as UserUpsertOutcome);
    } finally {
      this.inFlight -= 1;
    }
  }

  release(fiefUserId: string): void {
    const r = this.resolvers.get(fiefUserId);

    if (r) {
      this.resolvers.delete(fiefUserId);
      r();
    }
  }
}

class FakeUserDeleteUseCase {
  public calls: Array<{ fiefUserId: string }> = [];

  public failOnFiefUserIds = new Set<string>();

  async execute(input: {
    saleorApiUrl: SaleorApiUrl;
    claimMapping: readonly unknown[];
    payload: { type: string; data: Record<string, unknown>; eventId: string };
  }): Promise<Result<UserDeleteOutcome, UserDeleteUseCaseError>> {
    const fiefUserId = String(input.payload.data["id"] ?? "");

    this.calls.push({ fiefUserId });

    if (this.failOnFiefUserIds.has(fiefUserId)) {
      return err(new Error(`delete failed for ${fiefUserId}`) as UserDeleteUseCaseError);
    }

    return ok({
      kind: "deactivated",
      saleorUserId: "stub" as unknown as UserDeleteOutcome extends { saleorUserId: infer X }
        ? X
        : never,
      writtenSeq: 1 as unknown as UserDeleteOutcome extends { writtenSeq: infer X } ? X : never,
    } as UserDeleteOutcome);
  }
}

class FakeCustomerCreatedUseCase {
  public calls: CustomerCreatedJobPayload[] = [];

  async execute(
    payload: CustomerCreatedJobPayload,
  ): Promise<Result<CustomerCreatedOutcome, CustomerCreatedUseCaseErrorInstance>> {
    this.calls.push(payload);

    return ok({
      outcome: "synced",
      createdFiefUser: true,
      fiefUserId: "stub",
    } as unknown as CustomerCreatedOutcome);
  }
}

class FakeCustomerDeletedUseCase {
  public calls: CustomerDeletedJobPayload[] = [];

  async execute(
    payload: CustomerDeletedJobPayload,
  ): Promise<Result<CustomerDeletedOutcome, CustomerDeletedUseCaseErrorInstance>> {
    this.calls.push(payload);

    return ok({ outcome: "deactivated", fiefUserId: "stub" } as unknown as CustomerDeletedOutcome);
  }
}

const buildRepair = async (overrides?: {
  upsert?: FakeUserUpsertUseCase;
  del?: FakeUserDeleteUseCase;
  cCreate?: FakeCustomerCreatedUseCase;
  cDelete?: FakeCustomerDeletedUseCase;
  claimMapping?: readonly unknown[];
}) => {
  const upsert = overrides?.upsert ?? new FakeUserUpsertUseCase();
  const del = overrides?.del ?? new FakeUserDeleteUseCase();
  const cCreate = overrides?.cCreate ?? new FakeCustomerCreatedUseCase();
  const cDelete = overrides?.cDelete ?? new FakeCustomerDeletedUseCase();
  const claimMapping = overrides?.claimMapping ?? [];

  const { RepairUseCase } = await import("./repair.use-case");

  const repair = new RepairUseCase({
    userUpsertUseCase: upsert as unknown as UserUpsertUseCase,
    userDeleteUseCase: del as unknown as UserDeleteUseCase,
    customerCreatedUseCase: cCreate as unknown as CustomerCreatedUseCase,
    customerDeletedUseCase: cDelete as unknown as CustomerDeletedUseCase,
    resolveClaimMapping: () => claimMapping as never,
  });

  return { repair, upsert, del, cCreate, cDelete };
};

const driftStream = (rows: DriftReportRow[]): AsyncIterable<DriftReportRow> => ({
  [Symbol.asyncIterator]: async function* () {
    for (const row of rows) yield row;
  },
});

// ---------- Suite ----------

describe("RepairUseCase", () => {
  it("dispatches each drift kind through the correct sync use case", async () => {
    const { repair, upsert, del, cCreate, cDelete } = await buildRepair();

    const rows: DriftReportRow[] = [
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_A as never, fiefEmail: "a@example.com" },
      {
        kind: "field_divergence",
        fiefUserId: FIEF_USER_B as never,
        saleorUserId: SALEOR_USER_B as never,
        diffs: [
          { field: "email", fiefValue: "b-fief@example.com", saleorValue: "b-saleor@example.com" },
        ],
      },
      {
        kind: "stale_mapping",
        identityMapRow: makeIdentityMapRow({
          saleorUserId: SALEOR_USER_STALE_ID_F,
          fiefUserId: FIEF_USER_C,
        }),
        missingSide: "fief",
      },
      {
        kind: "stale_mapping",
        identityMapRow: makeIdentityMapRow({
          saleorUserId: SALEOR_USER_STALE_ID_S,
          fiefUserId: FIEF_USER_D,
        }),
        missingSide: "saleor",
      },
      {
        kind: "orphaned_in_saleor",
        saleorUserId: SALEOR_USER_ORPHAN as never,
        saleorEmail: "orphan@example.com",
        identityMapRow: null,
      },
    ];

    const result = await repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
    });

    /* missing_in_saleor + field_divergence → upsert ×2 */
    expect(upsert.calls.map((c) => c.fiefUserId).sort()).toStrictEqual(
      [FIEF_USER_A, FIEF_USER_B].sort(),
    );

    /* stale_mapping(fief) → delete ×1 */
    expect(del.calls).toStrictEqual([{ fiefUserId: FIEF_USER_C }]);

    /* customer-* use cases unused by repair (Fief is source of truth) */
    expect(cCreate.calls).toStrictEqual([]);
    expect(cDelete.calls).toStrictEqual([]);

    /*
     * orphaned_in_saleor without identityMapRow + stale_mapping(saleor)
     * → both skipped with warn (no actionable sync use case path).
     */
    expect(result.summary.total).toBe(5);
    expect(result.summary.repaired).toBe(3);
    expect(result.summary.skipped).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.perRowErrors).toStrictEqual([]);
  });

  it("re-running over an empty drift report after first repair is a no-op (idempotent)", async () => {
    const { repair, upsert, del } = await buildRepair();

    const rows: DriftReportRow[] = [
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_A as never, fiefEmail: "a@example.com" },
    ];

    await repair.repair({ saleorApiUrl: SALEOR_URL, drift: driftStream(rows) });

    /* simulate a re-run: drift is now empty */
    const second = await repair.repair({ saleorApiUrl: SALEOR_URL, drift: driftStream([]) });

    expect(second.summary).toStrictEqual({ total: 0, repaired: 0, skipped: 0, failed: 0 });
    expect(second.perRowErrors).toStrictEqual([]);
    /* no extra calls during second run */
    expect(upsert.calls).toHaveLength(1);
    expect(del.calls).toHaveLength(0);
  });

  it("dryRun does NOT invoke any sync use case", async () => {
    const { repair, upsert, del, cCreate, cDelete } = await buildRepair();

    const rows: DriftReportRow[] = [
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_A as never, fiefEmail: "a@example.com" },
      {
        kind: "stale_mapping",
        identityMapRow: makeIdentityMapRow({
          saleorUserId: SALEOR_USER_STALE_ID_F,
          fiefUserId: FIEF_USER_B,
        }),
        missingSide: "fief",
      },
    ];

    const result = await repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
      options: { dryRun: true },
    });

    expect(upsert.calls).toStrictEqual([]);
    expect(del.calls).toStrictEqual([]);
    expect(cCreate.calls).toStrictEqual([]);
    expect(cDelete.calls).toStrictEqual([]);
    /* dry-run reports the would-be repairs as repaired in the summary */
    expect(result.summary.total).toBe(2);
    expect(result.summary.repaired).toBe(2);
    expect(result.summary.failed).toBe(0);
  });

  it("with stopOnError=false (default), one failing row does not abort the run", async () => {
    const upsert = new FakeUserUpsertUseCase();

    upsert.failOnFiefUserIds.add(FIEF_USER_B);

    const { repair, del } = await buildRepair({ upsert });

    const rows: DriftReportRow[] = [
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_A as never, fiefEmail: "a@example.com" },
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_B as never, fiefEmail: "b@example.com" },
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_C as never, fiefEmail: "c@example.com" },
    ];

    const result = await repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
    });

    /* All three were attempted */
    expect(upsert.calls).toHaveLength(3);
    expect(del.calls).toHaveLength(0);
    expect(result.summary.total).toBe(3);
    expect(result.summary.repaired).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.perRowErrors).toHaveLength(1);
    expect(result.perRowErrors[0]?.row.kind).toBe("missing_in_saleor");
    expect(result.perRowErrors[0]?.error).toMatch(/upsert failed for/);
  });

  it("with stopOnError=true, aborts after the first failure", async () => {
    const upsert = new FakeUserUpsertUseCase();

    upsert.failOnFiefUserIds.add(FIEF_USER_A);

    const { repair } = await buildRepair({ upsert });

    const rows: DriftReportRow[] = [
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_A as never, fiefEmail: "a@example.com" },
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_B as never, fiefEmail: "b@example.com" },
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_C as never, fiefEmail: "c@example.com" },
    ];

    const result = await repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
      options: { stopOnError: true, concurrency: 1 },
    });

    /* Only the first row was attempted (concurrency=1 + stopOnError) */
    expect(upsert.calls.map((c) => c.fiefUserId)).toStrictEqual([FIEF_USER_A]);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.repaired).toBe(0);
    /* Two rows abandoned — counted toward total but neither repaired nor failed */
    expect(result.summary.total).toBeGreaterThanOrEqual(1);
  });

  it("honors the concurrency limit (peak in-flight ≤ N)", async () => {
    const upsert = new FakeUserUpsertUseCase();

    /* All five rows hang until released → measure peak concurrency. */
    const ids = [FIEF_USER_A, FIEF_USER_B, FIEF_USER_C, FIEF_USER_D, FIEF_USER_E];

    for (const id of ids) upsert.hangOnFiefUserIds.add(id);

    const { repair } = await buildRepair({ upsert });

    const rows: DriftReportRow[] = ids.map((id) => ({
      kind: "missing_in_saleor",
      fiefUserId: id as never,
      fiefEmail: `${id}@example.com`,
    }));

    const runP = repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
      options: { concurrency: 2 },
    });

    /* Yield enough microtasks for the dispatcher to fill its concurrency budget. */
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }

    expect(upsert.peakInFlight).toBeLessThanOrEqual(2);
    expect(upsert.peakInFlight).toBeGreaterThanOrEqual(1);

    /*
     * Drain by repeatedly releasing whatever resolvers exist (calls already
     * dispatched & hanging) and yielding microtasks so the dispatcher can
     * pull the next row. Loop until all rows have completed. This naturally
     * preserves concurrency because each release frees exactly one slot,
     * which lets the for-await advance by exactly one iteration.
     */
    while (upsert.calls.length < ids.length || upsert.inFlight > 0) {
      for (const id of ids) upsert.release(id);

      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }

    const result = await runP;

    expect(result.summary.total).toBe(5);
    expect(result.summary.repaired).toBe(5);
    expect(upsert.calls).toHaveLength(5);
  });

  it("logs and skips orphaned_in_saleor when no identityMapRow is present", async () => {
    const { repair, upsert, del } = await buildRepair();

    const rows: DriftReportRow[] = [
      {
        kind: "orphaned_in_saleor",
        saleorUserId: SALEOR_USER_ORPHAN as never,
        saleorEmail: "orphan@example.com",
        identityMapRow: null,
      },
    ];

    const result = await repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
    });

    expect(upsert.calls).toStrictEqual([]);
    expect(del.calls).toStrictEqual([]);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.repaired).toBe(0);
  });

  it("dispatches orphaned_in_saleor through UserDeleteUseCase when an identityMapRow IS present", async () => {
    const { repair, upsert, del } = await buildRepair();

    const rows: DriftReportRow[] = [
      {
        kind: "orphaned_in_saleor",
        saleorUserId: SALEOR_USER_ORPHAN as never,
        saleorEmail: "orphan@example.com",
        identityMapRow: makeIdentityMapRow({
          saleorUserId: SALEOR_USER_ORPHAN,
          fiefUserId: FIEF_USER_E,
        }),
      },
    ];

    const result = await repair.repair({
      saleorApiUrl: SALEOR_URL,
      drift: driftStream(rows),
    });

    expect(upsert.calls).toStrictEqual([]);
    expect(del.calls).toStrictEqual([{ fiefUserId: FIEF_USER_E }]);
    expect(result.summary.repaired).toBe(1);
  });

  it("emits the dispatched payload with branded saleorApiUrl and the resolved claimMapping", async () => {
    const upsert = new FakeUserUpsertUseCase();
    const executeSpy = vi.spyOn(upsert, "execute");

    const { repair } = await buildRepair({
      upsert,
      claimMapping: [
        { fiefField: "first_name", saleorMetadataKey: "first_name", visibility: "public" },
      ],
    });

    const rows: DriftReportRow[] = [
      { kind: "missing_in_saleor", fiefUserId: FIEF_USER_A as never, fiefEmail: "a@example.com" },
    ];

    await repair.repair({ saleorApiUrl: SALEOR_URL, drift: driftStream(rows) });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0]?.[0];

    expect(call?.saleorApiUrl).toBe(SALEOR_URL);
    expect(call?.claimMapping).toHaveLength(1);
    expect(call?.payload.data["id"]).toBe(FIEF_USER_A);
    expect(call?.payload.data["email"]).toBe("a@example.com");
  });
});
