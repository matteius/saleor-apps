/**
 * Subscriptions tRPC router.
 *
 * Mirrors the pattern from `modules/app-config/trpc-handlers/app-config-router.ts`
 * — handler stubs use `protectedClientProcedure` so the router gets the same
 * Saleor JWT + APL auth as the rest of the dashboard surface. Implementations
 * are filled in by T20–T23; for now each procedure throws a `NOT_IMPLEMENTED`
 * `TRPCError` tagged with the task that owns the body.
 *
 * Public storefront-facing entry points live separately under
 * `src/app/api/public/subscriptions/*` (T19a) and thin-wrap these procedures.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import { BillingPortalTrpcHandler } from "./billing-portal";
import { GetStatusTrpcHandler } from "./get-status";

/**
 * Shared address shape passed when creating a subscription. Optional on the
 * outer input; if present, all listed fields are required so Stripe Tax can
 * compute jurisdictions reliably.
 */
const billingAddressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().length(2, "ISO-3166-1 alpha-2 country code (e.g. 'US')"),
});

/**
 * `.strict()` so unknown keys throw at validation. Storefront / dashboard
 * callers MUST NOT pass `promoCode`, `couponId`, or `discount` — the
 * existing OwlBooks `PromoCode` model is for AI-credit redemption and does
 * not apply to subscriptions in v1 (T20). The strict mode surfaces these
 * as a Zod error naming the offending key so the integration misuse is
 * obvious from the error message alone.
 */
const createInputSchema = z
  .object({
    fiefUserId: z.string().min(1),
    email: z.string().email(),
    stripePriceId: z.string().min(1).startsWith("price_"),
    billingAddress: billingAddressSchema.optional(),
  })
  .strict();

const createOutputSchema = z.object({
  stripeSubscriptionId: z.string(),
  stripeCustomerId: z.string(),
  clientSecret: z.string(),
});

const cancelInputSchema = z.object({
  stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  immediate: z.boolean().optional(),
});

const cancelOutputSchema = z.object({
  status: z.string(),
});

const changePlanInputSchema = z.object({
  stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  newStripePriceId: z.string().min(1).startsWith("price_"),
  prorationBehavior: z.enum(["create_prorations", "none"]).optional(),
});

const changePlanOutputSchema = z.object({
  status: z.string(),
  currentPeriodEnd: z.string().datetime().nullable(),
});

/*
 * Note: The `createBillingPortalSession` (T22) and `getStatus` (T23)
 * procedure schemas live in their own modules (`./billing-portal` and
 * `./get-status`) and are re-exported from the handler classes. The inline
 * schema bindings were dropped here because the router-level type tests
 * (`subscriptions-router.types.test.ts`) derive their assertions from
 * `inferRouterInputs<TrpcRouter>` / `inferRouterOutputs<TrpcRouter>`,
 * which sees each procedure's bindings directly.
 */

export type SubscriptionsCreateInput = z.infer<typeof createInputSchema>;
export type SubscriptionsCreateOutput = z.infer<typeof createOutputSchema>;
export type SubscriptionsCancelInput = z.infer<typeof cancelInputSchema>;
export type SubscriptionsCancelOutput = z.infer<typeof cancelOutputSchema>;
export type SubscriptionsChangePlanInput = z.infer<typeof changePlanInputSchema>;
export type SubscriptionsChangePlanOutput = z.infer<typeof changePlanOutputSchema>;

const notImplemented = (taskId: string) =>
  new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `Implemented in ${taskId}`,
  });

export const subscriptionsRouter = router({
  /**
   * Create a subscription for a Fief user against a Stripe price.
   * Body implemented in T20 (`create-subscription.ts`).
   */
  create: protectedClientProcedure
    .input(createInputSchema)
    .output(createOutputSchema)
    .mutation(async (_opts): Promise<SubscriptionsCreateOutput> => {
      throw notImplemented("T20");
    }),

  /**
   * Cancel a subscription. Default behavior sets `cancel_at_period_end`;
   * `immediate=true` calls `stripe.subscriptions.cancel`.
   * Body implemented in T21 (`cancel-subscription.ts`).
   */
  cancel: protectedClientProcedure
    .input(cancelInputSchema)
    .output(cancelOutputSchema)
    .mutation(async (_opts): Promise<SubscriptionsCancelOutput> => {
      throw notImplemented("T21");
    }),

  /**
   * Switch a subscription to a new Stripe price.
   * Body implemented in T21 (`change-plan.ts`).
   */
  changePlan: protectedClientProcedure
    .input(changePlanInputSchema)
    .output(changePlanOutputSchema)
    .mutation(async (_opts): Promise<SubscriptionsChangePlanOutput> => {
      throw notImplemented("T21");
    }),

  /**
   * Mint a Stripe Customer Portal session URL.
   * Body implemented in T22 — delegates to {@link BillingPortalTrpcHandler}.
   *
   * The handler enforces its own input/output via schemas re-declared in
   * `billing-portal.ts` that mirror the inline `billingPortal*Schema`
   * bindings here (kept for type-test stability).
   */
  createBillingPortalSession: new BillingPortalTrpcHandler().getTrpcProcedure(),

  /**
   * Read subscription state from the DynamoDB cache.
   * Body implemented in T23 — delegates to {@link GetStatusTrpcHandler}.
   *
   * The handler enforces its own input/output via the same schemas declared
   * here (re-exported from `get-status.ts`); the inline schema bindings are
   * kept for type-test stability.
   */
  getStatus: new GetStatusTrpcHandler().getTrpcProcedure(),
});
