import type { FiefUser, FiefUserId } from "@/modules/fief-client/admin-api-types";
import type {
  IdentityMapRow,
  SaleorApiUrl,
  SaleorUserId,
} from "@/modules/identity-map/identity-map";
import type { IdentityMapRepo } from "@/modules/identity-map/identity-map-repo";
import type {
  ProviderConnection,
  ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import type { ProviderConnectionRepo } from "@/modules/provider-connections/provider-connection-repo";
import { FIEF_SYNC_ORIGIN_KEY } from "@/modules/sync/loop-guard";

/*
 * T30 — Reconciliation drift-detection walker.
 *
 * Read-only. Streams `DriftReportRow`s as it walks Fief admin users + Saleor
 * customers, joined via the identity_map. Designed to run on millions of users
 * without OOM:
 *
 *   - Saleor side: paged GraphQL `customers(first, after)`. Pages are
 *     accumulated into an in-memory join map BUT only entries that
 *     (a) carry the `fief_sync_origin` metadata marker OR (b) have a matching
 *     identity_map row are retained — so the working set is bounded by the
 *     number of "in-scope" customers, not the entire Saleor catalog.
 *
 *   - Fief side: streaming async iterator (T5 `iterateUsers`). One Fief user
 *     in memory at a time.
 *
 *   - Identity-map side: streaming async iterator (extension on the T10
 *     repo). Used in step 3 to find rows whose Fief side disappeared.
 *
 * Algorithm (per connection):
 *
 *   1. Page Saleor customers → build `saleorByUserId` (Map<SaleorUserId, …>)
 *      for those with origin marker OR an identity_map row scoped to this
 *      install. Same step also indexes by `fiefUserId` (when an identity_map
 *      row exists) so the Fief-side join is O(1).
 *
 *   2. `for-await` each Fief user via T5's iterator:
 *        - No identity_map row     → emit `missing_in_saleor`.
 *        - Identity_map row exists, but no Saleor customer in our join map
 *                                   → emit `stale_mapping` (missingSide: saleor).
 *        - Both exist               → diff `fieldsToCompare`; emit
 *                                     `field_divergence` if any field differs.
 *      Track each `fiefUserId` we see in `seenFiefUserIds`.
 *
 *   3. `for-await` each identity_map row (this install). If `fiefUserId`
 *      wasn't seen in step 2 → emit `stale_mapping` (missingSide: fief).
 *
 *   4. Walk the join map. For each Saleor customer with no identity_map row
 *      but `fief_sync_origin === "fief"` → emit `orphaned_in_saleor`.
 *
 * Multi-connection: if `connectionId` is omitted, run the algorithm for each
 * connection under the install. The Saleor side walk is shared across
 * connections (one install → one Saleor) — done once before iterating Fief
 * sources.
 *
 * Caveats / future hooks (carry over to T31 + T38):
 *
 *   - `SaleorCustomerSource.fetchPage` currently has no `metadata` filter
 *     because Saleor's `CustomerWhereInput` does not expose
 *     `metadata.fief_sync_origin` for filtering at the API. T30 walks all
 *     customers; the source can be specialized later (T32 cron) to add a
 *     server-side filter once Saleor exposes one.
 *
 *   - Repair (T31) consumes `DriftReportRow` directly — keep the shape
 *     stable.
 */

// ---------- Public discriminated union ----------

export interface DriftDiff {
  field: "email" | "isActive";
  fiefValue: string | boolean | null;
  saleorValue: string | boolean | null;
}

export type DriftReportRow =
  | {
      kind: "missing_in_saleor";
      fiefUserId: FiefUserId;
      fiefEmail: string;
    }
  | {
      kind: "orphaned_in_saleor";
      saleorUserId: SaleorUserId;
      saleorEmail: string;
      identityMapRow: IdentityMapRow | null;
    }
  | {
      kind: "field_divergence";
      fiefUserId: FiefUserId;
      saleorUserId: SaleorUserId;
      diffs: DriftDiff[];
    }
  | {
      kind: "stale_mapping";
      identityMapRow: IdentityMapRow;
      missingSide: "fief" | "saleor";
    };

export type DriftFieldName = DriftDiff["field"];

const DEFAULT_FIELDS_TO_COMPARE: ReadonlyArray<DriftFieldName> = ["email", "isActive"];

// ---------- Source interfaces (testable seams) ----------

/**
 * Fief admin user source. Backed in production by T5's
 * `FiefAdminApiClient.iterateUsers(...)` per connection, with the per-call
 * admin token resolved from `ProviderConnectionRepo.getDecryptedSecrets(...)`
 * inside the implementation. Kept as an interface here so the detector can
 * be unit-tested without the full T17 wiring.
 */
export interface FiefAdminUserSource {
  iterateUsers(input: { connection: ProviderConnection }): AsyncIterable<FiefUser>;
}

/**
 * Saleor customers paged source. Backed in production by an urql query of
 * `FiefCustomersListPageDocument` (T7). Returns a single page; the detector
 * walks pages by repeatedly calling with the previous `nextCursor`.
 *
 * The shape is intentionally narrow (only the fields we diff on) so the
 * GraphQL impl can map straight off `FiefCustomerFragment`.
 */
export interface SaleorCustomerSource {
  fetchPage(input: {
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
  }>;
}

/**
 * Identity-map repo extension that the detector relies on for steps 1 + 3.
 * Real impl will be added to the Mongo repo (T32 timeline) — declared here
 * so the test suite can stub it without touching the Mongo layer.
 */
export interface IdentityMapReconciliationSource {
  iterateForReconciliation(input: { saleorApiUrl: SaleorApiUrl }): AsyncIterable<IdentityMapRow>;
}

// ---------- Detector ----------

export interface DriftDetectorDeps {
  fiefAdmin: FiefAdminUserSource;
  saleorCustomers: SaleorCustomerSource;
  identityMapRepo: Pick<IdentityMapRepo, "getByFiefUser"> & IdentityMapReconciliationSource;
  providerConnectionRepo: Pick<ProviderConnectionRepo, "list">;
}

export interface DetectInput {
  saleorApiUrl: SaleorApiUrl;
  /** When omitted, all connections under the install are walked. */
  connectionId?: ProviderConnectionId;
  fieldsToCompare?: ReadonlyArray<DriftFieldName>;
  /** Per Saleor `customers(first: N)` page size. Saleor caps at 100. */
  saleorPageSize?: number;
}

export class DriftDetector {
  private readonly deps: DriftDetectorDeps;

  constructor(deps: DriftDetectorDeps) {
    this.deps = deps;
  }

  async *detect(input: DetectInput): AsyncIterable<DriftReportRow> {
    const fields = input.fieldsToCompare ?? DEFAULT_FIELDS_TO_COMPARE;
    const pageSize = input.saleorPageSize ?? 100;

    /* Resolve target connections. */
    const connectionsResult = await this.deps.providerConnectionRepo.list({
      saleorApiUrl: input.saleorApiUrl,
    });

    if (connectionsResult.isErr()) {
      throw connectionsResult.error;
    }

    const allConnections = connectionsResult.value;
    const targetConnections =
      input.connectionId !== undefined
        ? allConnections.filter(
            (c) => (c.id as unknown as string) === (input.connectionId as unknown as string),
          )
        : allConnections;

    if (targetConnections.length === 0) return;

    /*
     * Step 1 — page Saleor side ONCE per (saleorApiUrl). Two indices:
     *   - `saleorByUserId` keyed by SaleorUserId — the orphan walk in step 4.
     *   - `saleorByFiefUserId` keyed by FiefUserId — the field-divergence
     *     join in step 2 (O(1) lookup per Fief user).
     *
     * Identity-map rows for this install are pre-loaded so we can decide,
     * per Saleor customer, whether to retain it in the join map.
     */
    const identityRowBySaleorUserId = new Map<string, IdentityMapRow>();
    const identityRowByFiefUserId = new Map<string, IdentityMapRow>();

    for await (const row of this.deps.identityMapRepo.iterateForReconciliation({
      saleorApiUrl: input.saleorApiUrl,
    })) {
      identityRowBySaleorUserId.set(row.saleorUserId as unknown as string, row);
      identityRowByFiefUserId.set(row.fiefUserId as unknown as string, row);
    }

    interface SaleorJoinEntry {
      saleorUserId: string;
      email: string;
      isActive: boolean;
      fiefSyncOrigin: string | null;
      identityMapRow: IdentityMapRow | null;
    }

    const saleorByUserId = new Map<string, SaleorJoinEntry>();
    const saleorByFiefUserId = new Map<string, SaleorJoinEntry>();

    let cursor: string | null = null;
    let safety = 0;
    const HARD_PAGE_CAP = 10_000;

    do {
      safety += 1;
      if (safety > HARD_PAGE_CAP) {
        throw new Error(
          `DriftDetector: Saleor customers walk exceeded ${HARD_PAGE_CAP} pages — refusing to continue`,
        );
      }

      const page = await this.deps.saleorCustomers.fetchPage({
        saleorApiUrl: input.saleorApiUrl,
        cursor,
        pageSize,
      });

      for (const c of page.items) {
        const originEntry = c.metadata.find((m) => m.key === FIEF_SYNC_ORIGIN_KEY);
        const fiefSyncOrigin = originEntry?.value ?? null;
        const idRow = identityRowBySaleorUserId.get(c.id) ?? null;

        /*
         * Retention rule: customer is in scope IF it has the origin marker
         * OR an identity_map row. Out-of-scope customers are non-issues for
         * reconciliation (they were never managed by this app).
         */
        if (idRow === null && fiefSyncOrigin === null) continue;

        const entry: SaleorJoinEntry = {
          saleorUserId: c.id,
          email: c.email,
          isActive: c.isActive,
          fiefSyncOrigin,
          identityMapRow: idRow,
        };

        saleorByUserId.set(c.id, entry);
        if (idRow !== null) {
          saleorByFiefUserId.set(idRow.fiefUserId as unknown as string, entry);
        }
      }

      cursor = page.nextCursor;
    } while (cursor !== null);

    /* Step 2 — iterate Fief side per connection. */
    const seenFiefUserIds = new Set<string>();

    for (const connection of targetConnections) {
      for await (const fiefUser of this.deps.fiefAdmin.iterateUsers({ connection })) {
        const fiefUserIdStr = fiefUser.id as unknown as string;

        seenFiefUserIds.add(fiefUserIdStr);

        const idRowResult = await this.deps.identityMapRepo.getByFiefUser({
          saleorApiUrl: input.saleorApiUrl,
          fiefUserId: fiefUser.id,
        });

        if (idRowResult.isErr()) {
          throw idRowResult.error;
        }
        const idRow = idRowResult.value;

        if (idRow === null) {
          yield {
            kind: "missing_in_saleor",
            fiefUserId: fiefUser.id,
            fiefEmail: fiefUser.email,
          };
          continue;
        }

        const saleorEntry = saleorByFiefUserId.get(idRow.fiefUserId as unknown as string);

        if (saleorEntry === undefined) {
          yield {
            kind: "stale_mapping",
            identityMapRow: idRow,
            missingSide: "saleor",
          };
          continue;
        }

        const diffs: DriftDiff[] = [];

        if (fields.includes("email") && saleorEntry.email !== fiefUser.email) {
          diffs.push({
            field: "email",
            fiefValue: fiefUser.email,
            saleorValue: saleorEntry.email,
          });
        }
        if (fields.includes("isActive") && saleorEntry.isActive !== fiefUser.is_active) {
          diffs.push({
            field: "isActive",
            fiefValue: fiefUser.is_active,
            saleorValue: saleorEntry.isActive,
          });
        }

        if (diffs.length > 0) {
          yield {
            kind: "field_divergence",
            fiefUserId: fiefUser.id,
            saleorUserId: idRow.saleorUserId,
            diffs,
          };
        }
      }
    }

    /* Step 3 — identity_map rows whose Fief side disappeared. */
    for (const [fiefUserIdStr, row] of identityRowByFiefUserId) {
      if (seenFiefUserIds.has(fiefUserIdStr)) continue;
      yield {
        kind: "stale_mapping",
        identityMapRow: row,
        missingSide: "fief",
      };
    }

    /* Step 4 — orphaned Saleor customers (have origin marker, no id row). */
    for (const entry of saleorByUserId.values()) {
      if (entry.identityMapRow !== null) continue;
      if (entry.fiefSyncOrigin !== "fief") continue;
      yield {
        kind: "orphaned_in_saleor",
        saleorUserId: entry.saleorUserId as unknown as SaleorUserId,
        saleorEmail: entry.email,
        identityMapRow: null,
      };
    }
  }
}
