/**
 * T37 — `webhookLog` tRPC sub-router.
 *
 * Two procedures, both behind `protectedClientProcedure` so the dashboard
 * JWT + APL auth runs first:
 *
 *   - `list({ connectionId?, direction?, status?, limit?, before? })`
 *     returns the most recent rows for the install (sorted by `createdAt`
 *     desc). The list response intentionally OMITS `payloadRedacted` —
 *     payloads are fetched lazily via `getPayload` so the dashboard does
 *     not pull every row's body when only a header view is needed.
 *
 *   - `getPayload({ id })` returns the redacted payload JSON for a single
 *     row. `NOT_FOUND` if the row does not exist OR belongs to a
 *     different tenant (cross-tenant reads are silently treated as
 *     missing — operators on tenant A should not be able to probe
 *     tenant B's row ids).
 *
 * `connectionId` and `before` filtering happens in the router after the
 * fetch — the existing `WebhookLogRepo.list` interface (T11) only filters
 * by `saleorApiUrl / status / direction / eventType / createdAfter`, and
 * the dashboard's "last 50 events" cap means post-fetch filtering is
 * cheap. Adding repo-side support is a follow-up if a tenant ever blows
 * past the 1000-row internal cap.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import { createWebhookLogId, type WebhookLog, type WebhookStatus } from "./webhook-log";
import { type WebhookLogRepo } from "./webhook-log-repo";

/*
 * ----------------------------------------------------------------------------
 * Public response shapes
 * ----------------------------------------------------------------------------
 */

/**
 * Header-only projection of a `WebhookLog` row. The bulky `payloadRedacted`
 * is intentionally absent — the dashboard fetches it lazily via
 * `getPayload` once the operator clicks "View payload".
 */
export interface WebhookLogListRow {
  id: string;
  connectionId: string;
  direction: WebhookLog["direction"];
  eventId: string;
  eventType: string;
  status: WebhookStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface WebhookLogListResponse {
  rows: WebhookLogListRow[];
}

export interface WebhookLogPayloadResponse {
  payloadRedacted: unknown;
}

const projectRowToHeaderShape = (row: WebhookLog): WebhookLogListRow => ({
  id: row.id as unknown as string,
  connectionId: row.connectionId as unknown as string,
  direction: row.direction,
  eventId: row.eventId as unknown as string,
  eventType: row.eventType,
  status: row.status,
  attempts: row.attempts,
  ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
  createdAt: row.createdAt.toISOString(),
});

/*
 * ----------------------------------------------------------------------------
 * Input schemas
 * ----------------------------------------------------------------------------
 */

const listInputSchema = z.object({
  connectionId: z.string().min(1).optional(),
  direction: z.enum(["fief_to_saleor", "saleor_to_fief"]).optional(),
  status: z.enum(["ok", "retrying", "dead"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  /**
   * ISO-8601 timestamp; rows older than this are returned (sorted desc).
   * Used by the dashboard to page backwards through history.
   */
  before: z.string().datetime().optional(),
});

const getPayloadInputSchema = z.object({
  id: z.string().min(1, "id must be non-empty"),
});

/*
 * ----------------------------------------------------------------------------
 * Router builder
 * ----------------------------------------------------------------------------
 */

export interface WebhookLogRouterDeps {
  repo: WebhookLogRepo;
}

export const buildWebhookLogRouter = (deps: WebhookLogRouterDeps) => {
  const { repo } = deps;

  return router({
    /**
     * List webhook-log rows for the current install.
     */
    list: protectedClientProcedure
      .input(listInputSchema)
      .query(async ({ ctx, input }): Promise<WebhookLogListResponse> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        const result = await repo.list({
          saleorApiUrl: saleorApiUrlResult.value,
          ...(input.direction !== undefined ? { direction: input.direction } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });

        if (result.isErr()) {
          ctx.logger.error("webhookLog.list failed", { error: result.error });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to list webhook log rows",
          });
        }

        let rows = result.value;

        if (input.connectionId !== undefined) {
          const target = input.connectionId;

          rows = rows.filter((row) => (row.connectionId as unknown as string) === target);
        }

        if (input.before !== undefined) {
          const cutoff = new Date(input.before);

          rows = rows.filter((row) => row.createdAt < cutoff);
        }

        return { rows: rows.map(projectRowToHeaderShape) };
      }),

    /**
     * Fetch the redacted payload JSON for a single row. Cross-tenant
     * reads are folded into NOT_FOUND so an operator on tenant A cannot
     * probe tenant B's row ids.
     */
    getPayload: protectedClientProcedure
      .input(getPayloadInputSchema)
      .mutation(async ({ ctx, input }): Promise<WebhookLogPayloadResponse> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        const idResult = createWebhookLogId(input.id);

        if (idResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid webhook log id: ${idResult.error.message}`,
          });
        }

        const result = await repo.getById(idResult.value);

        if (result.isErr()) {
          ctx.logger.error("webhookLog.getPayload failed", { error: result.error });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to load webhook log row",
          });
        }

        const row = result.value;

        if (row === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Webhook log ${input.id} not found` });
        }

        if ((row.saleorApiUrl as unknown as string) !== saleorApiUrlResult.value) {
          /*
           * Hide cross-tenant reads as 404 — same shape as the missing
           * case so operators get no signal about what exists in other
           * tenants.
           */
          throw new TRPCError({ code: "NOT_FOUND", message: `Webhook log ${input.id} not found` });
        }

        return { payloadRedacted: row.payloadRedacted };
      }),
  });
};

export type WebhookLogRouter = ReturnType<typeof buildWebhookLogRouter>;
