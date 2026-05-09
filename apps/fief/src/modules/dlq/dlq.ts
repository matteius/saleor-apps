import { fromThrowable } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  type WebhookDirection,
  webhookDirectionSchema,
  type WebhookEventId,
  type WebhookLog,
  type WebhookLogConnectionId,
  type WebhookStatus,
  webhookStatusSchema,
} from "@/modules/webhook-log/webhook-log";

/**
 * Re-export the cross-module types the DLQ collection happens to need —
 * `WebhookDirection` / `WebhookEventId` / `WebhookLogConnectionId` /
 * `WebhookStatus` are part of the DLQ domain too because a DLQ row IS a
 * dead-letter webhook-log row. Keeping the re-export here prevents the
 * Mongo DLQ impl (in this module) from cross-importing the
 * `webhook-log` module just for types.
 */
export type {
  WebhookDirection,
  WebhookEventId,
  WebhookLogConnectionId,
  WebhookStatus,
} from "@/modules/webhook-log/webhook-log";

/*
 * T11 — Domain entity + Zod schemas for the `dlq` collection.
 *
 * The DLQ holds the same shape as `webhook_log` (see `webhook-log.ts`)
 * with two semantic differences:
 *
 *   1. **No TTL.** A DLQ row stays until an operator deletes it via T37
 *     (the dashboard "DLQ viewer"). Auto-expiry on dead-letter rows
 *     would silently drop incidents on the floor.
 *   2. **`movedToDlqAt`** is set instead of (or in addition to) the
 *     original `createdAt` so the operator UI can sort by "most recent
 *     dead". `createdAt` keeps the original event arrival time so
 *     replay tooling (T51) can preserve event ordering.
 *
 * Per the plan, the producer is `webhook_log.moveToDlq()` (which writes
 * here + removes from webhook_log) — the DLQ repo itself only exposes
 * `add`, `list`, `getById`, `delete` so the dashboard can manipulate
 * existing rows but never produce arbitrary new ones.
 */

export const DlqValidationError = BaseError.subclass("DlqValidationError", {
  props: {
    _brand: "FiefApp.Dlq.ValidationError" as const,
  },
});

const dlqEntryIdSchema = z.string().min(1).brand("DlqEntryId");

export type DlqEntryId = z.infer<typeof dlqEntryIdSchema>;

export const createDlqEntryId = (raw: string) =>
  fromThrowable(dlqEntryIdSchema.parse, (error) => DlqValidationError.normalize(error))(raw);

/**
 * DLQ row shape — same `{saleorApiUrl, connectionId, direction, eventId,
 * eventType, status, attempts, lastError?, payloadRedacted, createdAt}`
 * as `webhook_log` plus `movedToDlqAt`. The `status` is always `"dead"`
 * by the time a row lands here (the move-to-dlq path is only taken
 * after the queue worker has flipped status), but we keep the field in
 * the schema for forward-compat with manual-insertion paths the
 * operator UI may add later.
 */
export const dlqEntrySchema = z.object({
  id: dlqEntryIdSchema,
  saleorApiUrl: z
    .string()
    .min(1)
    .transform((value) => value as SaleorApiUrl),
  connectionId: z
    .string()
    .min(1)
    .transform((value) => value as WebhookLogConnectionId),
  direction: webhookDirectionSchema,
  eventId: z
    .string()
    .min(1)
    .transform((value) => value as WebhookEventId),
  eventType: z.string().min(1),
  status: webhookStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  payloadRedacted: z.unknown(),
  /**
   * Original arrival time (carried over from `webhook_log.createdAt`).
   * Preserved so replay tooling (T51) can ask "what would have run at
   * 10:30?" without losing ordering.
   */
  createdAt: z.date(),
  /**
   * Wall-clock at which the row was moved to DLQ. Distinct from
   * `createdAt` because the queue may take many minutes to declare a
   * row dead (exponential backoff up to ~10 min per the plan).
   */
  movedToDlqAt: z.date(),
});
export type DlqEntry = z.infer<typeof dlqEntrySchema>;

/**
 * Project a `WebhookLog` row into the `DlqEntry` shape. Used by
 * `WebhookLogRepo.moveToDlq()` so the move path is a single atomic
 * "insert here, delete there".
 */
export const projectWebhookLogToDlqEntry = (
  row: WebhookLog,
  movedToDlqAt: Date = new Date(),
): DlqEntry => ({
  id: row.id as unknown as DlqEntryId,
  saleorApiUrl: row.saleorApiUrl,
  connectionId: row.connectionId,
  direction: row.direction as WebhookDirection,
  eventId: row.eventId,
  eventType: row.eventType,
  status: row.status as WebhookStatus,
  attempts: row.attempts,
  lastError: row.lastError,
  payloadRedacted: row.payloadRedacted,
  createdAt: row.createdAt,
  movedToDlqAt,
});
