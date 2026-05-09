// cspell:ignore opensensor retriable

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * T25 — Reconciliation flag domain entity.
 *
 * A small, narrow store that records "schema-shape changed; you may want to
 * run reconciliation soon". Raised by T25's `user_field.updated` handler
 * (and intentionally NOT fanned out per-user — schema changes apply to
 * every user, so we just raise the flag once per `(saleorApiUrl)` and let
 * T38's UI / T30's job consume it on operator demand).
 *
 * Storage choice (per the T25 task brief):
 *
 *   We picked a small Mongo collection (`reconciliation_flags`) over
 *   "key in `provider_connections`" for two reasons:
 *
 *     1. Lifecycle independence. The flag is raised on Fief-side schema
 *        changes; clearing it is a separate operator action ("ack" /
 *        "ran reconciliation"). Putting it on the connection doc would
 *        couple the flag's write/read surface to the encryption +
 *        secret-rotation flow that owns `provider_connections` — which
 *        is the wrong tradeoff for a low-frequency operational signal.
 *
 *     2. Audit. A separate collection lets us keep history (raisedAt,
 *        clearedAt, raisedBy reason) without bloating connection docs.
 *        The collection is tiny (one row per `(saleorApiUrl, scope)`)
 *        and is intentionally not paginated.
 *
 * Scope is `saleorApiUrl` rather than `(saleorApiUrl, connectionId)` —
 * a `user_field.updated` event for tenant T affects every connection
 * scoped to that tenant, but our resolver currently picks a single
 * connection per webhook (see register-handlers.ts notes). We raise
 * the flag at the saleorApiUrl level so a multi-connection install only
 * sees one banner — cheaper to consume and matches operator intent.
 *
 * The reason is a free-form string for now (e.g. "user_field.updated:
 * user_field_id=…"). T38 surfaces it in the UI.
 */

// -- Errors -------------------------------------------------------------------

export const ReconciliationFlagError = {
  /**
   * Storage write failed (Mongo error, etc.). Retriable from the caller's
   * perspective — the use case treats it as a soft failure (logs + keeps
   * the user-side write that already succeeded).
   */
  WriteFailed: BaseError.subclass("ReconciliationFlagWriteFailedError", {
    props: { _brand: "FiefApp.ReconciliationFlag.WriteFailed" as const },
  }),
  /**
   * Storage read failed.
   */
  ReadFailed: BaseError.subclass("ReconciliationFlagReadFailedError", {
    props: { _brand: "FiefApp.ReconciliationFlag.ReadFailed" as const },
  }),
};

export type ReconciliationFlagError =
  | InstanceType<(typeof ReconciliationFlagError)["WriteFailed"]>
  | InstanceType<(typeof ReconciliationFlagError)["ReadFailed"]>;

// -- Branded primitives -------------------------------------------------------

const reconciliationFlagReasonSchema = z
  .string()
  .min(1, { message: "ReconciliationFlagReason requires at least one character" })
  .max(500, { message: "ReconciliationFlagReason capped at 500 characters" })
  .brand("ReconciliationFlagReason");

export type ReconciliationFlagReason = z.infer<typeof reconciliationFlagReasonSchema>;

export const createReconciliationFlagReason = (
  raw: string,
): Result<ReconciliationFlagReason, z.ZodError> => {
  const parsed = reconciliationFlagReasonSchema.safeParse(raw);

  if (!parsed.success) {
    return err(parsed.error);
  }

  return ok(parsed.data);
};

// -- Row shape ----------------------------------------------------------------

export interface ReconciliationFlagRow {
  saleorApiUrl: SaleorApiUrl;
  /** Free-form reason for visibility in the UI. */
  reason: ReconciliationFlagReason;
  /**
   * Mirror of the Fief webhook event id that raised the flag. Helpful for
   * cross-referencing a banner back to a specific log line.
   */
  raisedByEventId: string | null;
  raisedAt: Date;
  clearedAt: Date | null;
}

export interface RaiseReconciliationFlagInput {
  saleorApiUrl: SaleorApiUrl;
  reason: ReconciliationFlagReason;
  raisedByEventId: string | null;
}
