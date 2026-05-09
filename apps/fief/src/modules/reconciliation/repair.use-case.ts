// cspell:ignore upsert reconcile dispatcher idempotently

import { type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import type { SaleorApiUrl } from "@/modules/identity-map/identity-map";
import { type UserDeleteUseCase } from "@/modules/sync/fief-to-saleor/user-delete.use-case";
import { type UserUpsertUseCase } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";
import { type CustomerCreatedUseCase } from "@/modules/sync/saleor-to-fief/customer-created.use-case";
import { type CustomerDeletedUseCase } from "@/modules/sync/saleor-to-fief/customer-deleted.use-case";

import type { DriftReportRow } from "./drift-detector";

/*
 * T31 — Reconciliation repair use case.
 *
 * Consumes a `DriftReportRow` stream from T30 and dispatches each row to the
 * existing sync use cases (T23/T24/T26/T29). NEVER writes to repos directly:
 * every repair flows through a sync use case so loop-guard, claims projection,
 * and origin-marker behavior are identical to push-mode sync.
 *
 * Mapping (Fief is source of truth — see plan T31 entry for rationale):
 *
 *   missing_in_saleor  → UserUpsertUseCase (T23)
 *                        Provision Saleor side via the same path Fief webhooks
 *                        use. Synthesized payload carries fiefUserId + email
 *                        only; the use case will create the Saleor customer
 *                        and write claim metadata + origin marker.
 *
 *   field_divergence   → UserUpsertUseCase (T23)
 *                        Re-sync from Fief side. Same path as missing-in-saleor
 *                        because Fief wins by convention. T27 (Saleor→Fief) is
 *                        intentionally NOT used here — pulling Saleor's diverged
 *                        value back to Fief would invert the architectural
 *                        contract that Fief is the auth-plane source of truth.
 *
 *   stale_mapping(fief)→ UserDeleteUseCase (T24)
 *                        Fief user is gone but identity_map row still binds it
 *                        to a live Saleor customer → deactivate the Saleor side
 *                        (the same outcome as a normal Fief user.deleted hook).
 *
 *   stale_mapping(saleor)→ skip + warn
 *                        Saleor customer was deleted but identity_map row
 *                        remains. We have no clean delegation path: the live
 *                        Fief user is fine, only the binding is stale. Manual
 *                        cleanup is required (T38 will surface this in the UI).
 *
 *   orphaned_in_saleor (with identityMapRow) → UserDeleteUseCase (T24)
 *                        Same as stale_mapping(fief) — we have a fiefUserId.
 *
 *   orphaned_in_saleor (without identityMapRow) → skip + warn
 *                        Saleor customer carries the `fief_sync_origin` marker
 *                        but no identity_map row exists. We have no fiefUserId
 *                        to feed UserDeleteUseCase, and bypassing the use case
 *                        is forbidden by the architecture. Manual cleanup
 *                        (T38).
 *
 * Bounded concurrency: a hand-rolled semaphore (no external dep). Default 5.
 *
 * Per-row error capture: failures of the underlying use case are captured in
 * `perRowErrors` and counted toward `summary.failed`. By default
 * `stopOnError: false` — one bad row does not poison the run. With
 * `stopOnError: true` the dispatcher stops admitting new rows after the first
 * failure (in-flight rows are allowed to drain).
 *
 * Dry-run: log the intended action and count it toward `summary.repaired`,
 * but do NOT invoke any use case. Useful for the T38 UI's "Preview repair"
 * button.
 */

const logger = createLogger("modules.reconciliation.RepairUseCase");

// ---------- Public types ----------

export interface RepairOptions {
  /** Default false. Log only — do not invoke any use case. */
  dryRun?: boolean;
  /** Default 5. Max concurrent in-flight dispatches. */
  concurrency?: number;
  /** Default false. Abort run after first per-row failure. */
  stopOnError?: boolean;
}

export interface RepairSummary {
  total: number;
  repaired: number;
  skipped: number;
  failed: number;
}

export interface RepairPerRowError {
  row: DriftReportRow;
  error: string;
}

export interface RepairResult {
  summary: RepairSummary;
  perRowErrors: RepairPerRowError[];
}

export interface RepairInput {
  saleorApiUrl: SaleorApiUrl;
  drift: AsyncIterable<DriftReportRow>;
  options?: RepairOptions;
}

export interface RepairUseCaseDeps {
  userUpsertUseCase: UserUpsertUseCase;
  userDeleteUseCase: UserDeleteUseCase;
  customerCreatedUseCase: CustomerCreatedUseCase;
  customerDeletedUseCase: CustomerDeletedUseCase;
  /**
   * Resolves the per-saleor-tenant claim mapping needed by UserUpsertUseCase /
   * UserDeleteUseCase. T32's runner will bind this to the connection-scoped
   * mapping; tests pass a fixed function.
   */
  resolveClaimMapping: (input: {
    saleorApiUrl: SaleorApiUrl;
  }) => readonly ClaimMappingProjectionEntry[];
}

// ---------- Implementation ----------

const DEFAULT_CONCURRENCY = 5;

export class RepairUseCase {
  private readonly deps: RepairUseCaseDeps;

  constructor(deps: RepairUseCaseDeps) {
    this.deps = deps;
  }

  async repair(input: RepairInput): Promise<RepairResult> {
    const { saleorApiUrl, drift, options } = input;
    const dryRun = options?.dryRun ?? false;
    const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);
    const stopOnError = options?.stopOnError ?? false;

    const summary: RepairSummary = { total: 0, repaired: 0, skipped: 0, failed: 0 };
    const perRowErrors: RepairPerRowError[] = [];

    /*
     * Bounded concurrency via a Set of in-flight Promises. When `inFlight.size`
     * hits the cap we await `Promise.race` to drain one slot.
     *
     * Why not a queue + workers? — drift is an AsyncIterable; we can only
     * advance it serially. A semaphore over a serial pull naturally bounds
     * concurrency without standing up a worker pool.
     */
    const inFlight = new Set<Promise<void>>();
    let aborted = false;

    for await (const row of drift) {
      summary.total += 1;

      if (aborted) {
        /*
         * stopOnError: don't dispatch new rows. They aren't counted as failed
         * (they were never attempted) and they aren't counted as skipped
         * (we intentionally aborted; this is a runtime decision, not a per-row
         * one). They DO contribute to `summary.total` so a downstream observer
         * can tell that the run was incomplete.
         */
        continue;
      }

      const dispatchP = this.dispatchRow({
        saleorApiUrl,
        row,
        dryRun,
      })
        .then((outcome) => {
          if (outcome.kind === "repaired") {
            summary.repaired += 1;
          } else if (outcome.kind === "skipped") {
            summary.skipped += 1;
          } else {
            summary.failed += 1;
            perRowErrors.push({ row, error: outcome.error });

            if (stopOnError) {
              aborted = true;
            }
          }
        })
        .catch((error: unknown) => {
          /*
           * Defensive — `dispatchRow` already converts thrown errors to
           * `failed` outcomes. This branch only fires for genuinely unhandled
           * exceptions in the dispatcher itself.
           */
          summary.failed += 1;
          perRowErrors.push({
            row,
            error: error instanceof Error ? error.message : String(error),
          });

          if (stopOnError) {
            aborted = true;
          }
        });

      const wrapped = dispatchP.finally(() => {
        inFlight.delete(wrapped);
      });

      inFlight.add(wrapped);

      if (inFlight.size >= concurrency) {
        await Promise.race(inFlight);
      }
    }

    /* Drain any still-running dispatches. */
    await Promise.all(inFlight);

    logger.info("repair run complete", {
      saleorApiUrl,
      total: summary.total,
      repaired: summary.repaired,
      skipped: summary.skipped,
      failed: summary.failed,
      dryRun,
      stopOnError,
      aborted,
    });

    return { summary, perRowErrors };
  }

  private async dispatchRow(input: {
    saleorApiUrl: SaleorApiUrl;
    row: DriftReportRow;
    dryRun: boolean;
  }): Promise<DispatchOutcome> {
    const { saleorApiUrl, row, dryRun } = input;
    const action = classifyRepair(row);

    if (action.kind === "skip") {
      logger.info("repair skipping drift row", {
        saleorApiUrl,
        rowKind: row.kind,
        reason: action.reason,
      });

      return { kind: "skipped" };
    }

    if (dryRun) {
      logger.info("repair dry-run: would dispatch", {
        saleorApiUrl,
        rowKind: row.kind,
        action: action.kind,
      });

      return { kind: "repaired" };
    }

    try {
      if (action.kind === "upsert") {
        const claimMapping = this.deps.resolveClaimMapping({ saleorApiUrl });
        const result = await this.deps.userUpsertUseCase.execute({
          saleorApiUrl,
          claimMapping,
          payload: action.payload,
        });

        return resultToOutcome(result);
      }

      /* action.kind === "delete" */
      const claimMapping = this.deps.resolveClaimMapping({ saleorApiUrl });
      const result = await this.deps.userDeleteUseCase.execute({
        saleorApiUrl,
        claimMapping,
        payload: action.payload,
      });

      return resultToOutcome(result);
    } catch (error: unknown) {
      return {
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ---------- Internal helpers ----------

interface SyntheticPayload {
  type: string;
  data: Record<string, unknown>;
  eventId: string;
}

type RepairAction =
  | { kind: "upsert"; payload: SyntheticPayload }
  | { kind: "delete"; payload: SyntheticPayload }
  | { kind: "skip"; reason: string };

const REPAIR_EVENT_TYPE_UPSERT = "user.updated";
const REPAIR_EVENT_TYPE_DELETE = "user.deleted";

const classifyRepair = (row: DriftReportRow): RepairAction => {
  switch (row.kind) {
    case "missing_in_saleor": {
      return {
        kind: "upsert",
        payload: synthesizeUpsertPayload({
          fiefUserId: row.fiefUserId as unknown as string,
          email: row.fiefEmail,
        }),
      };
    }
    case "field_divergence": {
      /*
       * Recover Fief-side values for diverged fields where available; the
       * upsert path will idempotently re-write them on the Saleor side.
       */
      const emailDiff = row.diffs.find((d) => d.field === "email");
      const isActiveDiff = row.diffs.find((d) => d.field === "isActive");

      const email = typeof emailDiff?.fiefValue === "string" ? emailDiff.fiefValue : "";
      const isActive = typeof isActiveDiff?.fiefValue === "boolean" ? isActiveDiff.fiefValue : true;

      return {
        kind: "upsert",
        payload: synthesizeUpsertPayload({
          fiefUserId: row.fiefUserId as unknown as string,
          email,
          isActive,
        }),
      };
    }
    case "stale_mapping": {
      if (row.missingSide === "fief") {
        return {
          kind: "delete",
          payload: synthesizeDeletePayload({
            fiefUserId: row.identityMapRow.fiefUserId as unknown as string,
          }),
        };
      }

      return {
        kind: "skip",
        reason: "stale_mapping(saleor) — Saleor side gone, manual cleanup required",
      };
    }
    case "orphaned_in_saleor": {
      if (row.identityMapRow !== null) {
        return {
          kind: "delete",
          payload: synthesizeDeletePayload({
            fiefUserId: row.identityMapRow.fiefUserId as unknown as string,
          }),
        };
      }

      return {
        kind: "skip",
        reason:
          "orphaned_in_saleor without identity_map row — no fiefUserId to dispatch with, manual cleanup required",
      };
    }
    default: {
      /* exhaustive */
      const _: never = row;

      throw new Error(`Unknown drift row kind: ${JSON.stringify(_)}`);
    }
  }
};

const synthesizeUpsertPayload = (input: {
  fiefUserId: string;
  email: string;
  isActive?: boolean;
}): SyntheticPayload => ({
  type: REPAIR_EVENT_TYPE_UPSERT,
  data: {
    id: input.fiefUserId,
    email: input.email,
    is_active: input.isActive ?? true,
    fields: {},
  },
  eventId: `repair:${input.fiefUserId}`,
});

const synthesizeDeletePayload = (input: { fiefUserId: string }): SyntheticPayload => ({
  type: REPAIR_EVENT_TYPE_DELETE,
  data: {
    id: input.fiefUserId,
    fields: {},
  },
  eventId: `repair:${input.fiefUserId}`,
});

// ---------- Outcome helpers ----------

type DispatchOutcome =
  | { kind: "repaired" }
  | { kind: "skipped" }
  | { kind: "failed"; error: string };

const resultToOutcome = (result: Result<unknown, unknown>): DispatchOutcome => {
  if (result.isOk()) {
    return { kind: "repaired" };
  }

  const error = result.error;

  return {
    kind: "failed",
    error:
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : JSON.stringify(error),
  };
};
