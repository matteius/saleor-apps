/**
 * tRPC handler for `subscriptions.getStatus` (T23).
 *
 * Reads from the DynamoDB cache (`SubscriptionRepo`) — fast path used by
 * (a) the storefront polling after Payment Element confirmation and
 * (b) the OwlBooks settings page.
 *
 * Input is a Zod-discriminated union (`by: 'stripeSubscriptionId' | 'fiefUserId'`).
 *
 * Behavior:
 *  - Cache hit  → 200 with the full status payload.
 *  - Cache miss → 404 (`NOT_FOUND`) per plan §T23 ("cache miss returns 404").
 *  - Repo err   → 500 (`INTERNAL_SERVER_ERROR`); the underlying error is
 *                 logged for Sentry but not echoed back to the client.
 *
 * Wiring mirrors `BillingPortalTrpcHandler` (T22): a class handler with a
 * constructor-injected `SubscriptionRepo` so the router can do
 * `new GetStatusTrpcHandler().getTrpcProcedure()` and unit tests can swap
 * the repo wholesale without spinning up DynamoDB.
 *
 * `planName` resolution: see plan log for T23 — option (b) was chosen.
 * The plan name is cached on `SubscriptionRecord.planName` at create time
 * (T20 looks it up from Stripe Product) and on T15 webhooks (preserved /
 * refreshed there). When `planName` isn't set on the cache record we fall
 * back to the `stripePriceId` so the UI never renders a blank label.
 */
import { TRPCError } from "@trpc/server";
import { type Result } from "neverthrow";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import { DynamoDbSubscriptionRepo } from "../repositories/dynamodb/dynamodb-subscription-repo";
import {
  createFiefUserId,
  createStripeSubscriptionId,
  type SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
  type SubscriptionRepoError,
} from "../repositories/subscription-repo";

const logger = createLogger("getStatusTrpcHandler");

export const getStatusInputSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("stripeSubscriptionId"),
    stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  }),
  z.object({
    by: z.literal("fiefUserId"),
    fiefUserId: z.string().min(1),
  }),
]);

export const getStatusOutputSchema = z.object({
  status: z.string(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  lastSaleorOrderId: z.string().nullable(),
  planName: z.string().nullable(),
});

export type GetStatusInput = z.infer<typeof getStatusInputSchema>;
export type GetStatusOutput = z.infer<typeof getStatusOutputSchema>;

export interface GetStatusTrpcHandlerDeps {
  subscriptionRepo: SubscriptionRepo;
}

const recordToOutput = (record: SubscriptionRecord): GetStatusOutput => ({
  status: record.status,
  currentPeriodEnd: record.currentPeriodEnd ? record.currentPeriodEnd.toISOString() : null,
  cancelAtPeriodEnd: record.cancelAtPeriodEnd,
  lastSaleorOrderId: record.lastSaleorOrderId ?? null,
  /*
   * Fallback: when the cache record predates T23 (or T20's Stripe Product
   * lookup failed and skipped populating planName), surface the
   * `stripePriceId` instead of an empty label. The storefront can map it
   * locally if it has the catalog cached; otherwise the raw id is still
   * more useful than `null` for support diagnostics.
   */
  planName: record.planName ?? record.stripePriceId,
});

const lookupRecord = (
  subscriptionRepo: SubscriptionRepo,
  access: SubscriptionRepoAccess,
  input: GetStatusInput,
): Promise<Result<SubscriptionRecord | null, SubscriptionRepoError>> => {
  switch (input.by) {
    case "stripeSubscriptionId":
      return subscriptionRepo.getBySubscriptionId(
        access,
        createStripeSubscriptionId(input.stripeSubscriptionId),
      );
    case "fiefUserId":
      return subscriptionRepo.getByFiefUserId(access, createFiefUserId(input.fiefUserId));
  }
};

/**
 * Handler class. Mirrors `BillingPortalTrpcHandler` (T22) so the router can
 * do `new GetStatusTrpcHandler().getTrpcProcedure()`.
 */
export class GetStatusTrpcHandler {
  baseProcedure = protectedClientProcedure;
  private readonly subscriptionRepo: SubscriptionRepo;

  constructor(deps?: Partial<GetStatusTrpcHandlerDeps>) {
    this.subscriptionRepo = deps?.subscriptionRepo ?? new DynamoDbSubscriptionRepo();
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(getStatusInputSchema)
      .output(getStatusOutputSchema)
      .query(async ({ input, ctx }): Promise<GetStatusOutput> => {
        const saleorApiUrl = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrl.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Malformed saleorApiUrl",
          });
        }

        const access: SubscriptionRepoAccess = {
          saleorApiUrl: saleorApiUrl.value,
          appId: ctx.appId,
        };

        const lookupResult = await lookupRecord(this.subscriptionRepo, access, input);

        if (lookupResult.isErr()) {
          logger.error("Failed to read subscription cache", {
            error: lookupResult.error,
            by: input.by,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to read subscription cache",
          });
        }

        const record = lookupResult.value;

        if (!record) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "No subscription record found for the given lookup key",
          });
        }

        return recordToOutput(record);
      });
  }
}
