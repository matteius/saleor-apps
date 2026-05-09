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

const createInputSchema = z.object({
  fiefUserId: z.string().min(1),
  email: z.string().email(),
  stripePriceId: z.string().min(1).startsWith("price_"),
  billingAddress: billingAddressSchema.optional(),
});

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

const billingPortalInputSchema = z.object({
  stripeCustomerId: z.string().min(1).startsWith("cus_"),
  returnUrl: z.string().url(),
});

const billingPortalOutputSchema = z.object({
  url: z.string().url(),
});

/**
 * XOR via Zod discriminated union — caller must provide exactly one of the
 * two lookup keys. Discriminator field is `by` so downstream handlers can
 * branch without ambiguity.
 */
const getStatusInputSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("stripeSubscriptionId"),
    stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  }),
  z.object({
    by: z.literal("fiefUserId"),
    fiefUserId: z.string().min(1),
  }),
]);

const getStatusOutputSchema = z.object({
  status: z.string(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  lastSaleorOrderId: z.string().nullable(),
  planName: z.string().nullable(),
});

export type SubscriptionsCreateInput = z.infer<typeof createInputSchema>;
export type SubscriptionsCreateOutput = z.infer<typeof createOutputSchema>;
export type SubscriptionsCancelInput = z.infer<typeof cancelInputSchema>;
export type SubscriptionsCancelOutput = z.infer<typeof cancelOutputSchema>;
export type SubscriptionsChangePlanInput = z.infer<typeof changePlanInputSchema>;
export type SubscriptionsChangePlanOutput = z.infer<typeof changePlanOutputSchema>;
export type SubscriptionsBillingPortalInput = z.infer<typeof billingPortalInputSchema>;
export type SubscriptionsBillingPortalOutput = z.infer<typeof billingPortalOutputSchema>;
export type SubscriptionsGetStatusInput = z.infer<typeof getStatusInputSchema>;
export type SubscriptionsGetStatusOutput = z.infer<typeof getStatusOutputSchema>;

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
   * Body implemented in T22 (`billing-portal.ts`).
   */
  createBillingPortalSession: protectedClientProcedure
    .input(billingPortalInputSchema)
    .output(billingPortalOutputSchema)
    .mutation(async (_opts): Promise<SubscriptionsBillingPortalOutput> => {
      throw notImplemented("T22");
    }),

  /**
   * Read subscription state from the DynamoDB cache.
   * Body implemented in T23 (`get-status.ts`).
   */
  getStatus: protectedClientProcedure
    .input(getStatusInputSchema)
    .output(getStatusOutputSchema)
    .query(async (_opts): Promise<SubscriptionsGetStatusOutput> => {
      throw notImplemented("T23");
    }),
});
