/**
 * tRPC handler for `subscriptions.listMappings` (T25).
 *
 * Reads all Stripe-price ↔ Saleor-variant mappings for the current
 * installation from the DynamoDB store (T10 — `PriceVariantMapRepo.list`).
 * Used by the Saleor Dashboard UI at `/subscriptions` to render the
 * mappings table.
 *
 * Auth: `protectedClientProcedure` (Saleor JWT) — admin-only by virtue of
 * dashboard-only access. No additional permission check is required because
 * the dashboard IFRAME is itself behind Saleor's staff-user gate.
 *
 * Output: ISO-string dates (not native `Date`) so the payload survives the
 * tRPC HTTP serialization without depending on superjson on the client.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import { priceVariantMapRepo as defaultPriceVariantMapRepo } from "../repositories/price-variant-map-repo-impl";
import { type PriceVariantMapRepo } from "../saleor-bridge/price-variant-map";

const logger = createLogger("listMappingsTrpcHandler");

export const listMappingsInputSchema = z.void();

export const listMappingsOutputSchema = z.object({
  mappings: z.array(
    z.object({
      stripePriceId: z.string(),
      saleorVariantId: z.string(),
      saleorChannelSlug: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
});

export type ListMappingsOutput = z.infer<typeof listMappingsOutputSchema>;

export interface ListMappingsHandlerDeps {
  priceVariantMapRepo: PriceVariantMapRepo;
}

export class ListMappingsHandler {
  baseProcedure = protectedClientProcedure;
  private readonly priceVariantMapRepo: PriceVariantMapRepo;

  constructor(deps?: Partial<ListMappingsHandlerDeps>) {
    this.priceVariantMapRepo = deps?.priceVariantMapRepo ?? defaultPriceVariantMapRepo;
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(listMappingsInputSchema)
      .output(listMappingsOutputSchema)
      .query(async ({ ctx }): Promise<ListMappingsOutput> => {
        const saleorApiUrl = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrl.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Malformed saleorApiUrl",
          });
        }

        const listResult = await this.priceVariantMapRepo.list({
          saleorApiUrl: saleorApiUrl.value,
          appId: ctx.appId,
        });

        if (listResult.isErr()) {
          logger.error("Failed to list price-variant mappings", {
            error: listResult.error,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to list price-variant mappings",
          });
        }

        return {
          mappings: listResult.value.map((m) => ({
            stripePriceId: m.stripePriceId,
            saleorVariantId: m.saleorVariantId,
            saleorChannelSlug: m.saleorChannelSlug,
            createdAt: m.createdAt.toISOString(),
            updatedAt: m.updatedAt.toISOString(),
          })),
        };
      });
  }
}
