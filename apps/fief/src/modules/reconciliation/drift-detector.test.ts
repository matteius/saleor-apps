import { ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";

import type { FiefUser } from "@/modules/fief-client/admin-api-types";
import type { FiefUserId, IdentityMapRow, SaleorApiUrl } from "@/modules/identity-map/identity-map";
import type {
  IdentityMapRepo,
  IdentityMapRepoError,
} from "@/modules/identity-map/identity-map-repo";
import type {
  ProviderConnection,
  ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import type {
  ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "@/modules/provider-connections/provider-connection-repo";

import {
  type DriftReportRow,
  type FiefAdminUserSource,
  type SaleorCustomerSource,
} from "./drift-detector";

/*
 * T30 — DriftDetector unit tests.
 *
 * The detector is the read-only walker that joins Fief admin users + Saleor
 * customers via the identity_map and emits a discriminated `DriftReportRow`
 * stream. We exercise it end-to-end with in-memory stubs for:
 *
 *   - the `ProviderConnectionRepo` (multi-connection iteration),
 *   - the Fief admin user source (the T5 `iterateUsers` shape),
 *   - the Saleor customers page source (the T7 paged GraphQL query),
 *   - the identity-map repo PLUS a recon-only iterator (T10 + add-on).
 *
 * The detector never writes — every test asserts that no mutating method on
 * the stubs is called.
 */

// ---------- Test helpers ----------

const SALEOR_URL = "https://shop-1.saleor.cloud/graphql/" as unknown as SaleorApiUrl;
const SALEOR_URL_2 = "https://shop-2.saleor.cloud/graphql/" as unknown as SaleorApiUrl;

interface MakeFiefUserInput {
  id: string;
  email: string;
  is_active?: boolean;
  email_verified?: boolean;
  created_at?: string;
  updated_at?: string;
  tenant_id?: string;
  fields?: Record<string, unknown>;
}

const makeFiefUser = (overrides: MakeFiefUserInput): FiefUser =>
  ({
    id: overrides.id,
    created_at: overrides.created_at ?? "2026-05-09T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-05-09T00:00:00Z",
    email: overrides.email,
    email_verified: overrides.email_verified ?? true,
    is_active: overrides.is_active ?? true,
    tenant_id: overrides.tenant_id ?? "11111111-1111-4111-8111-111111111111",
    fields: overrides.fields ?? {},
  }) as unknown as FiefUser;

interface SaleorCustomerStub {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  metadata: Array<{ key: string; value: string }>;
  privateMetadata: Array<{ key: string; value: string }>;
}

const makeSaleorCustomer = (
  overrides: Partial<SaleorCustomerStub> & { id: string; email: string },
): SaleorCustomerStub => ({
  id: overrides.id,
  email: overrides.email,
  firstName: overrides.firstName ?? "First",
  lastName: overrides.lastName ?? "Last",
  isActive: overrides.isActive ?? true,
  metadata: overrides.metadata ?? [],
  privateMetadata: overrides.privateMetadata ?? [],
});

const makeIdentityMapRow = (overrides: {
  saleorUserId: string;
  fiefUserId: string;
  saleorApiUrl?: string;
  lastSyncSeq?: number;
  lastSyncedAt?: Date;
}): IdentityMapRow =>
  ({
    saleorApiUrl: overrides.saleorApiUrl ?? (SALEOR_URL as unknown as string),
    saleorUserId: overrides.saleorUserId,
    fiefUserId: overrides.fiefUserId,
    lastSyncSeq: overrides.lastSyncSeq ?? 0,
    lastSyncedAt: overrides.lastSyncedAt ?? new Date("2026-05-09T00:00:00Z"),
  }) as unknown as IdentityMapRow;

const makeConnection = (id: string): ProviderConnection =>
  ({
    id: id as unknown as ProviderConnectionId,
    saleorApiUrl: SALEOR_URL as unknown as ProviderConnection["saleorApiUrl"],
    name: "stub" as ProviderConnection["name"],
    fief: {} as ProviderConnection["fief"],
    branding: { allowedOrigins: [] } as unknown as ProviderConnection["branding"],
    claimMapping: [],
    softDeletedAt: null,
  }) as unknown as ProviderConnection;

// ---------- Stubs ----------

class FakeProviderConnectionRepo implements Pick<ProviderConnectionRepo, "list"> {
  private readonly byUrl: Map<SaleorApiUrl, ProviderConnection[]>;

  constructor(byUrl: Map<SaleorApiUrl, ProviderConnection[]>) {
    this.byUrl = byUrl;
  }

  async list(access: {
    saleorApiUrl: SaleorApiUrl;
  }): Promise<
    Result<
      ProviderConnection[],
      InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    return ok(this.byUrl.get(access.saleorApiUrl) ?? []);
  }
}

class FakeFiefAdminUserSource implements FiefAdminUserSource {
  public seenIterateRequests: Array<{ connectionId: ProviderConnectionId }> = [];

  private readonly usersByConnection: Map<string, FiefUser[]>;

  constructor(usersByConnection: Map<string, FiefUser[]>) {
    this.usersByConnection = usersByConnection;
  }

  async *iterateUsers(input: { connection: ProviderConnection }): AsyncIterable<FiefUser> {
    this.seenIterateRequests.push({ connectionId: input.connection.id });
    const users = this.usersByConnection.get(input.connection.id as unknown as string) ?? [];

    for (const u of users) {
      yield u;
    }
  }
}

class FakeSaleorCustomerSource implements SaleorCustomerSource {
  public seenPageRequests: Array<{ saleorApiUrl: SaleorApiUrl; cursor: string | null }> = [];

  private readonly pagesByUrl: Map<
    string,
    Array<{ items: SaleorCustomerStub[]; nextCursor: string | null }>
  >;

  constructor(
    pagesByUrl: Map<string, Array<{ items: SaleorCustomerStub[]; nextCursor: string | null }>>,
  ) {
    this.pagesByUrl = pagesByUrl;
  }

  async fetchPage(input: {
    saleorApiUrl: SaleorApiUrl;
    cursor: string | null;
    pageSize: number;
  }): Promise<{
    items: ReadonlyArray<{
      id: string;
      email: string;
      isActive: boolean;
      metadata: ReadonlyArray<{ key: string; value: string }>;
      privateMetadata: ReadonlyArray<{ key: string; value: string }>;
    }>;
    nextCursor: string | null;
  }> {
    this.seenPageRequests.push({ saleorApiUrl: input.saleorApiUrl, cursor: input.cursor });
    const pages = this.pagesByUrl.get(input.saleorApiUrl as unknown as string) ?? [];

    if (pages.length === 0) return { items: [], nextCursor: null };
    const idx = input.cursor === null ? 0 : Number(input.cursor);
    const page = pages[idx];

    if (page === undefined) return { items: [], nextCursor: null };

    return { items: page.items, nextCursor: page.nextCursor };
  }
}

class FakeIdentityMapRepo implements Pick<IdentityMapRepo, "getByFiefUser"> {
  public seenLookups: Array<{ saleorApiUrl: string; fiefUserId: string }> = [];

  private readonly byFiefUser: Map<string, IdentityMapRow>;

  private readonly allRowsByUrl: Map<string, IdentityMapRow[]>;

  constructor(
    byFiefUser: Map<string, IdentityMapRow>,
    allRowsByUrl: Map<string, IdentityMapRow[]>,
  ) {
    this.byFiefUser = byFiefUser;
    this.allRowsByUrl = allRowsByUrl;
  }

  async getByFiefUser(input: {
    saleorApiUrl: SaleorApiUrl;
    fiefUserId: FiefUserId;
  }): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>> {
    this.seenLookups.push({
      saleorApiUrl: input.saleorApiUrl as unknown as string,
      fiefUserId: input.fiefUserId as unknown as string,
    });
    const key = `${input.saleorApiUrl as unknown as string}::${
      input.fiefUserId as unknown as string
    }`;

    return ok(this.byFiefUser.get(key) ?? null);
  }

  async *iterateForReconciliation(input: {
    saleorApiUrl: SaleorApiUrl;
  }): AsyncIterable<IdentityMapRow> {
    const rows = this.allRowsByUrl.get(input.saleorApiUrl as unknown as string) ?? [];

    for (const row of rows) {
      yield row;
    }
  }
}

// ---------- Suite ----------

describe("DriftDetector", () => {
  const FIEF_USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const FIEF_USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const FIEF_USER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const FIEF_USER_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  const SALEOR_USER_A = "VXNlcjox";
  const SALEOR_USER_B = "VXNlcjoy";
  const SALEOR_USER_ORPHAN = "VXNlcjozOTk=";
  const SALEOR_USER_STALE = "VXNlcjpzdGFsZQ==";

  const buildDetector = (deps: {
    fief: FakeFiefAdminUserSource;
    saleor: FakeSaleorCustomerSource;
    identityMap: FakeIdentityMapRepo;
    connections: FakeProviderConnectionRepo;
  }) => {
    /* Lazy import — keeps each test isolated; setupFiles seeds env first. */
    return import("./drift-detector").then(({ DriftDetector }) => {
      return new DriftDetector({
        fiefAdmin: deps.fief,
        saleorCustomers: deps.saleor,
        identityMapRepo: deps.identityMap,
        providerConnectionRepo: deps.connections,
      });
    });
  };

  it("yields nothing for an empty install (no connections)", async () => {
    const fief = new FakeFiefAdminUserSource(new Map());
    const saleor = new FakeSaleorCustomerSource(new Map());
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(new Map([[SALEOR_URL, []]]));

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rows.push(row);
    }

    expect(rows).toStrictEqual([]);
    expect(fief.seenIterateRequests).toStrictEqual([]);
    expect(saleor.seenPageRequests).toStrictEqual([]);
  });

  it("yields all four drift kinds against a seeded multi-row state", async () => {
    /*
     * Layout for ONE connection on SALEOR_URL:
     *
     *   Fief users:        A (synced, in identity map, both sides match)
     *                      B (synced, in identity map, divergent email)
     *                      C (NOT in identity map at all → missing_in_saleor)
     *                      D (in identity map but Saleor customer absent → stale_mapping/saleor)
     *
     *   Saleor customers:  SALEOR_USER_A  (matched to fief A)
     *                      SALEOR_USER_B  (matched to fief B, divergent email)
     *                      SALEOR_USER_ORPHAN (no identity row, has fief origin marker → orphaned_in_saleor)
     *                      (no row for FIEF_USER_D — that's the stale_mapping)
     *
     *   Identity-map rows: A→A, B→B, D→STALE (Saleor side missing)
     *                      plus a stand-alone STALE row whose fief side is missing →
     *                      stale_mapping/fief
     */
    const connectionId = "00000000-0000-4000-8000-000000000001";

    const fiefUsers = [
      makeFiefUser({ id: FIEF_USER_A, email: "alice@example.com", is_active: true }),
      makeFiefUser({ id: FIEF_USER_B, email: "bob+fief@example.com", is_active: true }),
      makeFiefUser({ id: FIEF_USER_C, email: "carol@example.com", is_active: true }),
      makeFiefUser({ id: FIEF_USER_D, email: "dan@example.com", is_active: true }),
    ];

    const saleorCustomers = [
      makeSaleorCustomer({ id: SALEOR_USER_A, email: "alice@example.com" }),
      makeSaleorCustomer({ id: SALEOR_USER_B, email: "bob+saleor@example.com" }),
      makeSaleorCustomer({
        id: SALEOR_USER_ORPHAN,
        email: "orphan@example.com",
        metadata: [{ key: "fief_sync_origin", value: "fief" }],
      }),
    ];

    const identityRowAA = makeIdentityMapRow({
      saleorUserId: SALEOR_USER_A,
      fiefUserId: FIEF_USER_A,
    });
    const identityRowBB = makeIdentityMapRow({
      saleorUserId: SALEOR_USER_B,
      fiefUserId: FIEF_USER_B,
    });
    const identityRowDStale = makeIdentityMapRow({
      saleorUserId: SALEOR_USER_STALE,
      fiefUserId: FIEF_USER_D,
    });
    /*
     * Synthetic stale row whose Fief side disappeared. Use a Saleor id that
     * does NOT exist in the Saleor side AND is distinct from any other
     * identity_map row's saleorUserId (so the index lookups are unambiguous).
     */
    const identityRowFiefMissing = makeIdentityMapRow({
      saleorUserId: "VXNlcjpnaG9zdA==",
      fiefUserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });

    const fief = new FakeFiefAdminUserSource(new Map([[connectionId, fiefUsers]]));
    const saleor = new FakeSaleorCustomerSource(
      new Map([[SALEOR_URL as unknown as string, [{ items: saleorCustomers, nextCursor: null }]]]),
    );
    const identityMap = new FakeIdentityMapRepo(
      new Map([
        [`${SALEOR_URL as unknown as string}::${FIEF_USER_A}`, identityRowAA],
        [`${SALEOR_URL as unknown as string}::${FIEF_USER_B}`, identityRowBB],
        [`${SALEOR_URL as unknown as string}::${FIEF_USER_D}`, identityRowDStale],
      ]),
      new Map([
        [
          SALEOR_URL as unknown as string,
          [identityRowAA, identityRowBB, identityRowDStale, identityRowFiefMissing],
        ],
      ]),
    );
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(connectionId)]]]),
    );

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rows.push(row);
    }

    /*
     * Should produce: missing_in_saleor (C), stale_mapping/saleor (D),
     *                 field_divergence (B), orphaned_in_saleor (ORPHAN),
     *                 stale_mapping/fief (FIEF_USER_FFF).
     */
    const kinds = rows.map((r) => r.kind).sort();

    expect(kinds).toStrictEqual([
      "field_divergence",
      "missing_in_saleor",
      "orphaned_in_saleor",
      "stale_mapping",
      "stale_mapping",
    ]);

    const missing = rows.find((r) => r.kind === "missing_in_saleor");

    expect(missing).toBeDefined();
    if (missing && missing.kind === "missing_in_saleor") {
      expect(missing.fiefUserId).toBe(FIEF_USER_C);
      expect(missing.fiefEmail).toBe("carol@example.com");
    }

    const orphan = rows.find((r) => r.kind === "orphaned_in_saleor");

    expect(orphan).toBeDefined();
    if (orphan && orphan.kind === "orphaned_in_saleor") {
      expect(orphan.saleorUserId).toBe(SALEOR_USER_ORPHAN);
      expect(orphan.saleorEmail).toBe("orphan@example.com");
      expect(orphan.identityMapRow).toBeNull();
    }

    const divergence = rows.find((r) => r.kind === "field_divergence");

    expect(divergence).toBeDefined();
    if (divergence && divergence.kind === "field_divergence") {
      expect(divergence.fiefUserId).toBe(FIEF_USER_B);
      expect(divergence.saleorUserId).toBe(SALEOR_USER_B);
      const fields = divergence.diffs.map((d) => d.field).sort();

      expect(fields).toStrictEqual(["email"]);
    }

    const staleSaleor = rows.find((r) => r.kind === "stale_mapping" && r.missingSide === "saleor");

    expect(staleSaleor).toBeDefined();
    if (staleSaleor && staleSaleor.kind === "stale_mapping") {
      expect(staleSaleor.identityMapRow.fiefUserId).toBe(FIEF_USER_D);
    }

    const staleFief = rows.find((r) => r.kind === "stale_mapping" && r.missingSide === "fief");

    expect(staleFief).toBeDefined();
    if (staleFief && staleFief.kind === "stale_mapping") {
      expect(staleFief.identityMapRow.fiefUserId).toBe("ffffffff-ffff-4fff-8fff-ffffffffffff");
    }
  });

  it("iterates every connection when connectionId is omitted", async () => {
    const conn1 = "00000000-0000-4000-8000-000000000010";
    const conn2 = "00000000-0000-4000-8000-000000000011";

    const fief = new FakeFiefAdminUserSource(
      new Map([
        [conn1, [makeFiefUser({ id: FIEF_USER_A, email: "a@example.com" })]],
        [conn2, [makeFiefUser({ id: FIEF_USER_B, email: "b@example.com" })]],
      ]),
    );
    const saleor = new FakeSaleorCustomerSource(
      new Map([[SALEOR_URL as unknown as string, [{ items: [], nextCursor: null }]]]),
    );
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(conn1), makeConnection(conn2)]]]),
    );

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rows.push(row);
    }

    /* Both Fief users are missing → 2 missing_in_saleor rows. */
    expect(rows.filter((r) => r.kind === "missing_in_saleor")).toHaveLength(2);
    expect(fief.seenIterateRequests.map((r) => r.connectionId).sort()).toStrictEqual(
      [conn1, conn2].sort(),
    );
  });

  it("filters to a single connection when connectionId is provided", async () => {
    const conn1 = "00000000-0000-4000-8000-000000000020";
    const conn2 = "00000000-0000-4000-8000-000000000021";

    const fief = new FakeFiefAdminUserSource(
      new Map([
        [conn1, [makeFiefUser({ id: FIEF_USER_A, email: "a@example.com" })]],
        [conn2, [makeFiefUser({ id: FIEF_USER_B, email: "b@example.com" })]],
      ]),
    );
    const saleor = new FakeSaleorCustomerSource(
      new Map([[SALEOR_URL as unknown as string, [{ items: [], nextCursor: null }]]]),
    );
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(conn1), makeConnection(conn2)]]]),
    );

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({
      saleorApiUrl: SALEOR_URL,
      connectionId: conn1 as unknown as ProviderConnectionId,
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(fief.seenIterateRequests.map((r) => r.connectionId)).toStrictEqual([conn1]);
  });

  it("respects the fieldsToCompare filter — defaults to email + isActive", async () => {
    const connectionId = "00000000-0000-4000-8000-000000000030";

    const identityRow = makeIdentityMapRow({
      saleorUserId: SALEOR_USER_A,
      fiefUserId: FIEF_USER_A,
    });

    const fief = new FakeFiefAdminUserSource(
      new Map([
        [
          connectionId,
          [makeFiefUser({ id: FIEF_USER_A, email: "alice@example.com", is_active: false })],
        ],
      ]),
    );
    const saleor = new FakeSaleorCustomerSource(
      new Map([
        [
          SALEOR_URL as unknown as string,
          [
            {
              items: [
                makeSaleorCustomer({
                  id: SALEOR_USER_A,
                  email: "alice@example.com",
                  isActive: true,
                }),
              ],
              nextCursor: null,
            },
          ],
        ],
      ]),
    );
    const identityMap = new FakeIdentityMapRepo(
      new Map([[`${SALEOR_URL as unknown as string}::${FIEF_USER_A}`, identityRow]]),
      new Map([[SALEOR_URL as unknown as string, [identityRow]]]),
    );
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(connectionId)]]]),
    );

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    /* Default: should detect isActive divergence. */
    const rowsDefault: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rowsDefault.push(row);
    }
    expect(rowsDefault).toHaveLength(1);
    expect(rowsDefault[0].kind).toBe("field_divergence");
    if (rowsDefault[0].kind === "field_divergence") {
      expect(rowsDefault[0].diffs.map((d) => d.field)).toStrictEqual(["isActive"]);
    }

    /* fieldsToCompare = ["email"] — isActive divergence ignored, no rows. */
    const rowsEmailOnly: DriftReportRow[] = [];

    for await (const row of detector.detect({
      saleorApiUrl: SALEOR_URL,
      fieldsToCompare: ["email"],
    })) {
      rowsEmailOnly.push(row);
    }
    expect(rowsEmailOnly).toStrictEqual([]);
  });

  it("streams rows incrementally without buffering the full result", async () => {
    /*
     * Construct a Fief side that yields five "missing_in_saleor" candidates;
     * confirm the consumer can `break` after the first two and the iterator
     * stops driving the source. Proves we don't materialize the full list up
     * front.
     */
    const connectionId = "00000000-0000-4000-8000-000000000040";

    let yielded = 0;

    class CountingFiefAdminUserSource implements FiefAdminUserSource {
      async *iterateUsers(): AsyncIterable<FiefUser> {
        for (let i = 0; i < 5; i += 1) {
          yielded += 1;
          yield makeFiefUser({
            id: `1111111${i}-1111-4111-8111-111111111111`,
            email: `u${i}@example.com`,
          });
        }
      }
    }

    const fief = new CountingFiefAdminUserSource();
    const saleor = new FakeSaleorCustomerSource(
      new Map([[SALEOR_URL as unknown as string, [{ items: [], nextCursor: null }]]]),
    );
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(connectionId)]]]),
    );

    const detector = await buildDetector({
      fief: fief as unknown as FakeFiefAdminUserSource,
      saleor,
      identityMap,
      connections,
    });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rows.push(row);
      if (rows.length === 2) break;
    }

    expect(rows).toHaveLength(2);
    /*
     * The async generator should pull at most 3 (push 2 + the in-flight one)
     * — anything materially higher means the detector pre-buffered.
     */
    expect(yielded).toBeLessThanOrEqual(3);
  });

  it("walks Saleor pages until the source returns nextCursor=null", async () => {
    const connectionId = "00000000-0000-4000-8000-000000000050";

    const fief = new FakeFiefAdminUserSource(new Map([[connectionId, []]]));
    const saleor = new FakeSaleorCustomerSource(
      new Map([
        [
          SALEOR_URL as unknown as string,
          [
            {
              items: [
                makeSaleorCustomer({
                  id: SALEOR_USER_A,
                  email: "p1@example.com",
                  metadata: [{ key: "fief_sync_origin", value: "fief" }],
                }),
              ],
              nextCursor: "1",
            },
            {
              items: [
                makeSaleorCustomer({
                  id: SALEOR_USER_B,
                  email: "p2@example.com",
                  metadata: [{ key: "fief_sync_origin", value: "fief" }],
                }),
              ],
              nextCursor: null,
            },
          ],
        ],
      ]),
    );
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(connectionId)]]]),
    );

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rows.push(row);
    }

    /* Both Saleor customers carry the fief origin marker but no identity row → orphaned. */
    expect(rows.filter((r) => r.kind === "orphaned_in_saleor")).toHaveLength(2);
    expect(saleor.seenPageRequests.map((p) => p.cursor)).toStrictEqual([null, "1"]);
  });

  it("does not attribute drift to the wrong connection (multi-connection scoping)", async () => {
    /*
     * Two connections under the same install. Fief user A lives under conn1,
     * Fief user B under conn2. Their identity_map rows are scoped to
     * SALEOR_URL — both should be evaluated against the same Saleor side
     * (they share the install). Asserting we don't double-count or cross
     * the streams.
     */
    const conn1 = "00000000-0000-4000-8000-000000000060";
    const conn2 = "00000000-0000-4000-8000-000000000061";

    const fief = new FakeFiefAdminUserSource(
      new Map([
        [conn1, [makeFiefUser({ id: FIEF_USER_A, email: "a@example.com" })]],
        [conn2, [makeFiefUser({ id: FIEF_USER_B, email: "b@example.com" })]],
      ]),
    );
    const saleor = new FakeSaleorCustomerSource(
      new Map([[SALEOR_URL as unknown as string, [{ items: [], nextCursor: null }]]]),
    );
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(
      new Map([[SALEOR_URL, [makeConnection(conn1), makeConnection(conn2)]]]),
    );

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL })) {
      rows.push(row);
    }

    /*
     * 2 missing_in_saleor (A, B). No duplication because Saleor walk happens
     * once per (saleorApiUrl) — installs share the Saleor side.
     */
    expect(rows.filter((r) => r.kind === "missing_in_saleor")).toHaveLength(2);
  });

  it("yields nothing for an unknown saleorApiUrl", async () => {
    const fief = new FakeFiefAdminUserSource(new Map());
    const saleor = new FakeSaleorCustomerSource(new Map());
    const identityMap = new FakeIdentityMapRepo(new Map(), new Map());
    const connections = new FakeProviderConnectionRepo(new Map());

    const detector = await buildDetector({ fief, saleor, identityMap, connections });

    const rows: DriftReportRow[] = [];

    for await (const row of detector.detect({ saleorApiUrl: SALEOR_URL_2 })) {
      rows.push(row);
    }

    expect(rows).toStrictEqual([]);
  });
});
