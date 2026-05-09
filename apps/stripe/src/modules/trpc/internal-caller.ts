/**
 * Server-side internal tRPC caller for the public storefront API (T19a).
 *
 * The dashboard `subscriptionsRouter` (T19) gates every procedure with
 * `protectedClientProcedure`, which requires a Saleor JWT validated against
 * Saleor's JWKS. The storefront has no Saleor JWT — only a Fief access
 * token — so it cannot reach that router. This module exposes a parallel
 * **internal** router whose procedures use plain `procedure` (no auth at
 * the tRPC layer); access is gated upstream by the Fief + HMAC layers in
 * `modules/subscriptions/public-api/auth.ts`.
 *
 * Procedure bodies will be implemented in T20–T23. For now each throws
 * `NOT_IMPLEMENTED` so the public route handlers can wire end-to-end and
 * the wiring tests confirm the bubble-up works as intended.
 *
 * The schemas here intentionally mirror the dashboard router's schemas so
 * a single source-of-truth implementation can later be extracted into a
 * shared module that both routers delegate to.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

const billingAddressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().length(2),
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

const cancelOutputSchema = z.object({ status: z.string() });

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

const billingPortalOutputSchema = z.object({ url: z.string().url() });

const getStatusInputSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("stripeSubscriptionId"),
    stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  }),
  z.object({ by: z.literal("fiefUserId"), fiefUserId: z.string().min(1) }),
]);

const getStatusOutputSchema = z.object({
  status: z.string(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  lastSaleorOrderId: z.string().nullable(),
  planName: z.string().nullable(),
});

/**
 * Internal context — populated by the route handler from the verified Fief
 * claims. T20–T23 will use these for audit logging and as a defense-in-depth
 * cross-check against the body fields.
 */
export interface InternalSubscriptionsContext {
  fiefUserId: string;
  email: string;
}

const t = initTRPC.context<InternalSubscriptionsContext>().create();

const notImplemented = (taskId: string) =>
  new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `Implemented in ${taskId}`,
  });

export const internalSubscriptionsRouter = t.router({
  create: t.procedure
    .input(createInputSchema)
    .output(createOutputSchema)
    .mutation(async () => {
      throw notImplemented("T20");
    }),
  cancel: t.procedure
    .input(cancelInputSchema)
    .output(cancelOutputSchema)
    .mutation(async () => {
      throw notImplemented("T21");
    }),
  changePlan: t.procedure
    .input(changePlanInputSchema)
    .output(changePlanOutputSchema)
    .mutation(async () => {
      throw notImplemented("T21");
    }),
  createBillingPortalSession: t.procedure
    .input(billingPortalInputSchema)
    .output(billingPortalOutputSchema)
    .mutation(async () => {
      throw notImplemented("T22");
    }),
  getStatus: t.procedure
    .input(getStatusInputSchema)
    .output(getStatusOutputSchema)
    .query(async () => {
      throw notImplemented("T23");
    }),
});

export type InternalSubscriptionsRouter = typeof internalSubscriptionsRouter;

/**
 * Build an internal caller bound to verified Fief claims. Public route
 * handlers do `createInternalSubscriptionsCaller(claims).create({...})`.
 */
export const createInternalSubscriptionsCaller = (ctx: InternalSubscriptionsContext) =>
  internalSubscriptionsRouter.createCaller(ctx);
