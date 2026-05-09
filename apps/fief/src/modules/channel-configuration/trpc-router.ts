/**
 * T34 — `channelConfig` tRPC sub-router.
 *
 * Two procedures, both behind `protectedClientProcedure` (T33) so the
 * dashboard JWT + APL auth runs first:
 *
 *   - `get`    — returns the persisted `ChannelConfiguration` for the install
 *                or `null` when nothing has been written yet. The resolver
 *                (T12) treats `null` as "no connections configured".
 *   - `upsert` — full-replace per T9's repo contract (the entire override list
 *                is written atomically). This deliberately mirrors T36's UI
 *                shape: the form always submits the complete list, so partial-
 *                update semantics would be a sharp edge.
 *
 * Repo dependency injection
 * -------------------------
 *
 * The router is built by `buildChannelConfigRouter({ repo })` so unit tests
 * can pass a fake (`FakeChannelConfigurationRepo` in this module's test
 * file). The production app composes the Mongo-backed repo at the
 * `appRouter` boundary in `modules/trpc/trpc-router.ts`. This keeps the
 * tRPC layer free of Mongo lifetime concerns and matches the pattern used
 * by Stripe's app-config router.
 *
 * Input shape
 * -----------
 *
 * `upsert` accepts the operator-facing shape (raw strings for connection ids
 * and channel slugs) so the dashboard does not need to know about branded
 * types. We re-construct the branded primitives via the schema's parser
 * before handing the payload to the repo — branded validity is enforced at
 * the boundary, not at the call site.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import {
  type ChannelConfiguration,
  channelConfigurationSchema,
  DISABLED_CHANNEL,
} from "./channel-configuration";
import { type IChannelConfigurationRepo } from "./channel-configuration-repo";

export interface ChannelConfigRouterDeps {
  repo: IChannelConfigurationRepo;
}

/*
 * Operator-facing input. We accept raw strings for connection ids and
 * channel slugs (the dashboard does not know about branded types) and run
 * them through `channelConfigurationSchema` once `saleorApiUrl` is appended
 * from the tRPC context.
 */
const overrideInputSchema = z.object({
  channelSlug: z.string().min(1, "channelSlug must be non-empty"),
  /*
   * `connectionId` is either a non-empty string OR the literal `"disabled"`
   * sentinel. The schema's full validation runs at the boundary below.
   */
  connectionId: z.union([z.string().min(1), z.literal(DISABLED_CHANNEL)]),
});

const upsertInputSchema = z.object({
  defaultConnectionId: z.string().min(1).nullable(),
  overrides: z.array(overrideInputSchema),
});

export const buildChannelConfigRouter = (deps: ChannelConfigRouterDeps) => {
  const { repo } = deps;

  return router({
    /**
     * Fetch the channel-config document for the install (or `null`).
     */
    get: protectedClientProcedure.query(async ({ ctx }): Promise<ChannelConfiguration | null> => {
      const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

      if (saleorApiUrlResult.isErr()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid saleorApiUrl in request context",
        });
      }

      const result = await repo.get(saleorApiUrlResult.value);

      if (result.isErr()) {
        ctx.logger.error("channelConfig.get failed", { error: result.error });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load channel configuration",
        });
      }

      return result.value;
    }),

    /**
     * Full-replace the channel-config document. Returns the freshly-written
     * config so callers can refresh local state without a follow-up `get`.
     */
    upsert: protectedClientProcedure
      .input(upsertInputSchema)
      .mutation(async ({ ctx, input }): Promise<ChannelConfiguration> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        /*
         * Run the operator-supplied raw shape through the schema parser to
         * produce branded primitives. Failures here surface as BAD_REQUEST
         * because the operator picked an invalid id / slug.
         */
        const parsed = channelConfigurationSchema.safeParse({
          saleorApiUrl: saleorApiUrlResult.value,
          defaultConnectionId: input.defaultConnectionId,
          overrides: input.overrides,
        });

        if (!parsed.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid channel configuration: ${parsed.error.message}`,
          });
        }

        const result = await repo.upsert(parsed.data);

        if (result.isErr()) {
          ctx.logger.error("channelConfig.upsert failed", { error: result.error });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to save channel configuration",
          });
        }

        return parsed.data;
      }),
  });
};

/**
 * Type alias used by the root `appRouter` to declare the shape of the
 * sub-router without ever materializing a default instance — production wires
 * the Mongo repo in at composition time.
 */
export type ChannelConfigRouter = ReturnType<typeof buildChannelConfigRouter>;
