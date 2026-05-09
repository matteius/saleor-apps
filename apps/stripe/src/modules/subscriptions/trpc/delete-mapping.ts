/**
 * tRPC handler for `subscriptions.deleteMapping` (T25).
 *
 * Hard-deletes a Stripe-price ↔ Saleor-variant mapping. Does NOT consult
 * Stripe (no need — the mapping store is local; if the price has been
 * removed in Stripe, the mapping should be deletable too).
 *
 * Auth: `protectedClientProcedure` (Saleor JWT) — admin-only by virtue of
 * dashboard-only access.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import { DynamoDbPriceVariantMapRepo } from "../repositories/dynamodb/dynamodb-price-variant-map-repo";
import { createStripePriceId, type PriceVariantMapRepo } from "../saleor-bridge/price-variant-map";

const logger = createLogger("deleteMappingTrpcHandler");

export const deleteMappingInputSchema = z.object({
  stripePriceId: z.string().min(1).startsWith("price_"),
});

export const deleteMappingOutputSchema = z.object({
  ok: z.literal(true),
});

export type DeleteMappingInput = z.infer<typeof deleteMappingInputSchema>;
export type DeleteMappingOutput = z.infer<typeof deleteMappingOutputSchema>;

export interface DeleteMappingHandlerDeps {
  priceVariantMapRepo: PriceVariantMapRepo;
}

export class DeleteMappingHandler {
  baseProcedure = protectedClientProcedure;
  private readonly priceVariantMapRepo: PriceVariantMapRepo;

  constructor(deps?: Partial<DeleteMappingHandlerDeps>) {
    this.priceVariantMapRepo = deps?.priceVariantMapRepo ?? new DynamoDbPriceVariantMapRepo();
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(deleteMappingInputSchema)
      .output(deleteMappingOutputSchema)
      .mutation(async ({ input, ctx }): Promise<DeleteMappingOutput> => {
        const saleorApiUrl = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrl.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Malformed saleorApiUrl",
          });
        }

        const deleteResult = await this.priceVariantMapRepo.delete(
          { saleorApiUrl: saleorApiUrl.value, appId: ctx.appId },
          createStripePriceId(input.stripePriceId),
        );

        if (deleteResult.isErr()) {
          logger.error("Failed to delete price-variant mapping", {
            stripePriceId: input.stripePriceId,
            error: deleteResult.error,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to delete price-variant mapping",
            cause: deleteResult.error,
          });
        }

        return { ok: true };
      });
  }
}
