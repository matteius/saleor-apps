/**
 * tRPC handler for `subscriptions.upsertMapping` (T25).
 *
 * Persists a Stripe-price ↔ Saleor-variant mapping in DynamoDB (T10) after
 * validating that the supplied `stripePriceId` exists in the connected
 * Stripe account.
 *
 * Validation strategy:
 *  1. Zod schema enforces shape (`price_*`, non-empty IDs).
 *  2. `stripeSubscriptionsApi.retrievePrice` round-trips Stripe; a 404 from
 *     Stripe surfaces as `StripeInvalidRequestError` and is mapped to a
 *     user-facing `TRPCError(NOT_FOUND)` so the dashboard can show a clear
 *     "no such price" message — distinct from generic 5xx-style errors.
 *  3. `priceVariantMapRepo.set` performs the upsert (PutItem semantics).
 *
 * Auth: `protectedClientProcedure` (Saleor JWT) — admin-only by virtue of
 * dashboard-only access.
 *
 * Wiring: mirrors the T22/T23 lazy-deps pattern. Passing a fully-built
 * `UpsertMappingHandlerDeps` (eager mode, used by tests) skips the
 * `appConfigRepo` lookup; the parameterless / partial-deps path resolves
 * the Stripe restricted key from `AppRootConfig` lazily inside the
 * procedure handler.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import {
  type IStripeSubscriptionsApiFactory,
  StripeSubscriptionsApiFactory,
} from "../api/stripe-subscriptions-api-factory";
import { DynamoDbPriceVariantMapRepo } from "../repositories/dynamodb/dynamodb-price-variant-map-repo";
import {
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  type PriceVariantMapRepo,
} from "../saleor-bridge/price-variant-map";

const logger = createLogger("upsertMappingTrpcHandler");

export const upsertMappingInputSchema = z.object({
  stripePriceId: z.string().min(1).startsWith("price_"),
  saleorVariantId: z.string().min(1),
  saleorChannelSlug: z.string().min(1),
});

export const upsertMappingOutputSchema = z.object({
  ok: z.literal(true),
});

export type UpsertMappingInput = z.infer<typeof upsertMappingInputSchema>;
export type UpsertMappingOutput = z.infer<typeof upsertMappingOutputSchema>;

export interface UpsertMappingHandlerDeps {
  stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  appConfigRepo: AppConfigRepo;
  priceVariantMapRepo: PriceVariantMapRepo;
}

export class UpsertMappingHandler {
  baseProcedure = protectedClientProcedure;
  private readonly stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  private readonly appConfigRepo: AppConfigRepo;
  private readonly priceVariantMapRepo: PriceVariantMapRepo;

  constructor(deps?: Partial<UpsertMappingHandlerDeps>) {
    this.stripeSubscriptionsApiFactory =
      deps?.stripeSubscriptionsApiFactory ?? new StripeSubscriptionsApiFactory();
    this.appConfigRepo = deps?.appConfigRepo ?? appConfigRepoImpl;
    this.priceVariantMapRepo = deps?.priceVariantMapRepo ?? new DynamoDbPriceVariantMapRepo();
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(upsertMappingInputSchema)
      .output(upsertMappingOutputSchema)
      .mutation(async ({ input, ctx }): Promise<UpsertMappingOutput> => {
        const saleorApiUrl = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrl.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Malformed saleorApiUrl",
          });
        }

        const rootConfigResult = await this.appConfigRepo.getRootConfig({
          saleorApiUrl: saleorApiUrl.value,
          appId: ctx.appId,
        });

        if (rootConfigResult.isErr()) {
          logger.error("Failed to load root config", { error: rootConfigResult.error });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to load Stripe configuration",
          });
        }

        const stripeConfigs = rootConfigResult.value.getAllConfigsAsList();

        if (stripeConfigs.length === 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "No Stripe configuration is installed for this Saleor app",
          });
        }

        /*
         * Single-tenant subscription model: pick the first config (same
         * convention as T22 BillingPortalTrpcHandler).
         */
        const stripeConfig = stripeConfigs[0];

        const stripeSubscriptionsApi = this.stripeSubscriptionsApiFactory.createSubscriptionsApi({
          key: stripeConfig.restrictedKey,
        });

        const priceResult = await stripeSubscriptionsApi.retrievePrice({
          priceId: input.stripePriceId,
        });

        if (priceResult.isErr()) {
          logger.warn("Stripe rejected the supplied stripePriceId during upsert", {
            stripePriceId: input.stripePriceId,
            error: priceResult.error,
          });

          /*
           * Use NOT_FOUND so the dashboard can render "no such Stripe price"
           * specifically; Stripe's restricted keys with insufficient scope
           * also surface as a `StripeInvalidRequestError` here, but those
           * are rare enough in practice that the user-facing message is
           * acceptable for both ("does not exist or is not accessible").
           */
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Stripe price "${input.stripePriceId}" does not exist or is not accessible`,
            cause: priceResult.error,
          });
        }

        const now = new Date();

        const setResult = await this.priceVariantMapRepo.set(
          { saleorApiUrl: saleorApiUrl.value, appId: ctx.appId },
          {
            stripePriceId: createStripePriceId(input.stripePriceId),
            saleorVariantId: createSaleorVariantId(input.saleorVariantId),
            saleorChannelSlug: createSaleorChannelSlug(input.saleorChannelSlug),
            /*
             * `createdAt` is filled here for the in-memory mapping, but the
             * DynamoDB layer overwrites it via dynamodb-toolbox's auto
             * timestamps. On updates of an existing row Dynamo preserves the
             * original `createdAt` only if the entity config sets that —
             * documented limitation; UI surfaces `updatedAt` as the meaningful
             * "last touched" timestamp.
             */
            createdAt: now,
            updatedAt: now,
          },
        );

        if (setResult.isErr()) {
          logger.error("Failed to persist price-variant mapping", {
            stripePriceId: input.stripePriceId,
            error: setResult.error,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to persist price-variant mapping",
            cause: setResult.error,
          });
        }

        return { ok: true };
      });
  }
}
