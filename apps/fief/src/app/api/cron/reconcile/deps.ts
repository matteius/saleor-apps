import { ok } from "neverthrow";

import { getProductionDeps } from "@/lib/composition-root";
import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import { DriftDetector } from "@/modules/reconciliation/drift-detector";
import { RepairUseCase } from "@/modules/reconciliation/repair.use-case";
import { MongodbReconciliationRunHistoryRepo } from "@/modules/reconciliation/repositories/mongodb/mongodb-run-history-repo";
import {
  type ConnectionListEntry,
  type ReconciliationRunnerDeps,
} from "@/modules/reconciliation/runner";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * T32 — composition seam for the reconciliation cron route.
 *
 * Why this lives next to the route (not in `composition-root.ts`):
 * the reconciliation graph pulls in T23/T24/T26/T29 use cases plus a
 * `DriftDetector`, `RepairUseCase`, and the new run-history repo —
 * dependencies the rest of the app does not need. Co-locating the
 * wiring here keeps the central composition root from sprouting
 * recon-only fields, and tests can `vi.mock(...)` this module to
 * substitute a stub runner without touching the production graph.
 *
 * Drift / repair production wiring is a deliberate v1 placeholder.
 * `DriftDetector`'s sources (T5 admin client + T7 GraphQL paged customers
 * source) and the use-case repair surface require T7 GraphQL wiring +
 * a Saleor write client which are themselves placeholders in
 * `composition-root.ts`. Until those land:
 *
 *   - the placeholder `fiefAdmin` / `saleorCustomers` / iteration-source
 *     return empty so the drift stream is always empty, the repair
 *     dispatcher does nothing, and the run history records a
 *     `summary: { total: 0, ... }` for every connection.
 *   - the placeholder use-case clients throw on dispatch, surfacing as
 *     per-row errors when (a future) drift row arrives.
 *
 * The cron tick is therefore exercisable end-to-end against the real
 * Mongo lock + history collection today; T38's UI consumes the
 * run-history shape regardless of whether drift detection is "real" yet.
 */

const claimMappingResolver = (_: {
  saleorApiUrl: SaleorApiUrl;
}): readonly ClaimMappingProjectionEntry[] => [];

const noopUserUpsertUseCase = {
  async execute() {
    return ok(undefined as never);
  },
};

const noopUserDeleteUseCase = {
  async execute() {
    return ok(undefined as never);
  },
};

const noopCustomerCreatedUseCase = {
  async execute() {
    return ok(undefined as never);
  },
};

const noopCustomerDeletedUseCase = {
  async execute() {
    return ok(undefined as never);
  },
};

export const buildReconciliationRunnerDeps = (): ReconciliationRunnerDeps => {
  const prod = getProductionDeps();

  /*
   * Drift detector wiring stub. Production needs T5 admin-API client
   * factory + T7 GraphQL `customers(first, after)` page source; today
   * those are not in the composition root, so the cron tick exercises
   * the full claim → drift (empty) → repair (no-op) → complete pipeline
   * against the real Mongo lock.
   */
  const driftDetector = new DriftDetector({
    fiefAdmin: {
      // eslint-disable-next-line require-yield
      iterateUsers: async function* () {
        return;
      },
    },
    saleorCustomers: {
      async fetchPage() {
        return { items: [], nextCursor: null };
      },
    },
    identityMapRepo: {
      ...prod.identityMapRepo,
      // eslint-disable-next-line require-yield
      iterateForReconciliation: async function* () {
        return;
      },
    },
    providerConnectionRepo: prod.connectionRepo,
  });

  const repairUseCase = new RepairUseCase({
    /*
     * Cast to the use-case shapes — the repair dispatcher only calls
     * `execute(input)` on each, and the no-op clients above return `ok`
     * on every input. When drift detection is wired in production, swap
     * these placeholders for real use-case instances from `composition-root.ts`.
     */
    userUpsertUseCase: noopUserUpsertUseCase as never,
    userDeleteUseCase: noopUserDeleteUseCase as never,
    customerCreatedUseCase: noopCustomerCreatedUseCase as never,
    customerDeletedUseCase: noopCustomerDeletedUseCase as never,
    resolveClaimMapping: claimMappingResolver,
  });

  const runHistoryRepo = new MongodbReconciliationRunHistoryRepo();

  const listConnections = async (input: {
    saleorApiUrl: SaleorApiUrl;
  }): Promise<ConnectionListEntry[]> => {
    const result = await prod.connectionRepo.list({ saleorApiUrl: input.saleorApiUrl });

    if (result.isErr()) {
      return [];
    }

    return result.value.map((c) => ({
      id: c.id,
      saleorApiUrl: c.saleorApiUrl,
    }));
  };

  return {
    driftDetector,
    repairUseCase,
    runHistoryRepo,
    listConnections,
  };
};
