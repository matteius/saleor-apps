import { fromThrowable } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { FiefUserIdSchema } from "@/modules/fief-client/admin-api-types";

/*
 * T10 — `identity_map` domain entity.
 *
 * The identity map is the bidirectional join between a Saleor customer and
 * a Fief user, scoped per Saleor instance (`saleorApiUrl`). It is the
 * synchronization point for the auth-plane race documented in T19/T23 of
 * `fief-app-plan.md`:
 *
 *   - Two-device first-login (T19): two AUTH_ISSUE_ACCESS_TOKENS handlers
 *     fire concurrently with the same `fiefUserId` and DIFFERENT candidate
 *     `saleorUserId`s. The repo's `upsert(...)` returns `wasInserted: true`
 *     to exactly one caller (the winner — they own the Saleor customer
 *     creation) and `wasInserted: false` to every other concurrent caller
 *     (they reuse the bound row).
 *
 *   - Saleor-side webhook race (T23): a `UserCreated` webhook from Fief
 *     can arrive while AUTH_ISSUE is still in flight. T23 calls the same
 *     `upsert(...)` — whoever lands first wins the bind, the other side
 *     observes `wasInserted: false` and skips the customer-create step.
 *
 *   - Out-of-order updates: every write carries a `syncSeq` (monotonic per
 *     `(saleorApiUrl, fiefUserId)` per the loop-guard module in T13). The
 *     repo refuses to regress `lastSyncSeq` — older writes are dropped at
 *     the storage layer so callers can be optimistic about ordering.
 *
 * Branded primitives (ADR 0002):
 *
 *   - `SaleorUserId` — opaque Saleor customer identifier (typically a base64
 *     Relay node id). We brand-only — no length / format validation beyond
 *     "non-empty string" because Saleor's id encoding is implementation-
 *     defined and we don't want to break on a future bump.
 *
 *   - `FiefUserId` — re-exported from `@/modules/fief-client/admin-api-types`
 *     (T5) so consumers don't double-brand.
 *
 *   - `SaleorApiUrl` — re-exported from `@/modules/saleor/saleor-api-url`.
 *
 *   - `SyncSeq` — non-negative integer. The brand prevents accidental mixing
 *     with arbitrary `number` values (e.g. timestamps).
 *
 * The persistence shape is captured by `IdentityMapRowSchema` so the Mongo
 * impl in `repositories/mongodb/` can `parse(...)` after a `findOne` and we
 * fail loudly on schema drift instead of returning a half-typed row to use
 * cases (PRD R6 — schema drift visibility).
 */

export const IdentityMapValidationError = BaseError.subclass("IdentityMapValidationError", {
  props: {
    _brand: "IdentityMap.ValidationError" as const,
  },
});

// ---------- Branded primitives ----------

const saleorUserIdSchema = z.string().min(1).brand("SaleorUserId");

export type SaleorUserId = z.infer<typeof saleorUserIdSchema>;

/**
 * Construct a `SaleorUserId` from a raw string. Returns Result so callers
 * never throw across the module boundary (`neverthrow` convention).
 */
export const createSaleorUserId = (raw: string) =>
  fromThrowable(saleorUserIdSchema.parse, (e) => IdentityMapValidationError.normalize(e))(raw);

const syncSeqSchema = z
  .number()
  .int({ message: "SyncSeq must be an integer" })
  .nonnegative({ message: "SyncSeq must be non-negative" })
  .brand("SyncSeq");

export type SyncSeq = z.infer<typeof syncSeqSchema>;

export const createSyncSeq = (raw: number) =>
  fromThrowable(syncSeqSchema.parse, (e) => IdentityMapValidationError.normalize(e))(raw);

// Re-export FiefUserId so consumers depend on a single domain surface.
export { type FiefUserId, FiefUserIdSchema } from "@/modules/fief-client/admin-api-types";
export { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

// ---------- Row schema (storage shape) ----------

/*
 * The persisted row's `saleorApiUrl` is validated upstream (the use case has
 * already produced a branded `SaleorApiUrl` before the repo is called). The
 * row schema is a defense-in-depth check on what the driver returns — we
 * accept any string for `saleorApiUrl` here and re-brand at the use-case
 * layer if needed.
 */

export const IdentityMapRowSchema = z.object({
  saleorApiUrl: z.string().min(1),
  saleorUserId: saleorUserIdSchema,
  fiefUserId: FiefUserIdSchema,
  lastSyncSeq: z.number().int().nonnegative(),
  lastSyncedAt: z.date(),
});

/**
 * Domain row. Note `saleorApiUrl` is the brand-stripped string-typed view; the
 * upstream caller holds the branded `SaleorApiUrl` for type-safe routing.
 */
export type IdentityMapRow = z.infer<typeof IdentityMapRowSchema>;
