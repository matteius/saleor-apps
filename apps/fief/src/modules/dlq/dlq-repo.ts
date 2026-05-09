import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type DlqEntry, type DlqEntryId } from "./dlq";

/*
 * T11 — Repository interface for the `dlq` collection.
 *
 * The DLQ is purely producer→read→delete: rows are added by the queue
 * worker (T52) via `WebhookLogRepo.moveToDlq()`, then surfaced to the
 * operator dashboard (T37). The dashboard offers "delete" and (later)
 * "replay" actions; neither path mutates row contents in place — the
 * operator either drops a row outright or T51's replay tooling
 * resubmits it through the original receiver path (which goes back
 * through `WebhookLogRepo.record()` with a fresh ttl).
 */

export const DlqRepoError = BaseError.subclass("DlqRepoError", {
  props: {
    _brand: "FiefApp.Dlq.RepoError" as const,
  },
});
export const DlqNotFoundError = BaseError.subclass("DlqNotFoundError", {
  props: {
    _brand: "FiefApp.Dlq.NotFoundError" as const,
  },
});

export interface DlqFilters {
  saleorApiUrl?: SaleorApiUrl;
  /**
   * Inclusive lower bound on `movedToDlqAt`. The dashboard defaults to
   * "last 30 days" via this filter.
   */
  movedAfter?: Date;
  limit?: number;
}

export interface DlqRepo {
  /**
   * Insert a DLQ row. Producer is `WebhookLogRepo.moveToDlq()`; the
   * dashboard does not call this directly.
   */
  add(entry: DlqEntry): Promise<Result<void, InstanceType<typeof DlqRepoError>>>;

  /**
   * List rows matching `filters`, sorted by `movedToDlqAt` desc. Caps
   * results at 1000 internally.
   */
  list(filters: DlqFilters): Promise<Result<DlqEntry[], InstanceType<typeof DlqRepoError>>>;

  /** Fetch a single row by id; returns `null` (not error) when missing. */
  getById(id: DlqEntryId): Promise<Result<DlqEntry | null, InstanceType<typeof DlqRepoError>>>;

  /**
   * Permanently delete a DLQ row. Used by the dashboard "discard"
   * action after operator review.
   */
  delete(
    id: DlqEntryId,
  ): Promise<Result<void, InstanceType<typeof DlqRepoError | typeof DlqNotFoundError>>>;
}
