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
 * Create, status, and billing-portal procedures resolve the configured
 * Saleor installation at runtime. Cancel and plan-change remain unavailable
 * here; customers manage cancellation through Stripe's billing portal and
 * LightNVR allocation changes do not change the subscription price.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import { resolveInternalSubscriptionRuntime } from "@/modules/subscriptions/internal-runtime";
import {
  createFiefUserId,
  createStripeCustomerId,
  createStripeSubscriptionId,
} from "@/modules/subscriptions/repositories/subscription-record";
import { CreateSubscriptionHandler } from "@/modules/subscriptions/trpc/create-subscription";

const billingAddressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1).optional(),
  postalCode: z.string().min(1),
  country: z.string().length(2),
});

const createInputSchema = z.object({
  fiefUserId: z.string().min(1),
  email: z.string().email(),
  stripePriceId: z.string().min(1).startsWith("price_"),
  trialEnd: z.number().int().positive().optional(),
  billingAddress: billingAddressSchema.optional(),
});

const createOutputSchema = z.object({
  stripeSubscriptionId: z.string(),
  stripeCustomerId: z.string(),
  clientSecret: z.string(),
  intentType: z.enum(["payment", "setup"]),
  publishableKey: z.string().startsWith("pk_"),
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

const getStatusInputWithVerificationSchema = z.intersection(
  getStatusInputSchema,
  z.object({ verifyPaymentMethod: z.boolean().optional() }),
);

const getStatusOutputSchema = z.object({
  status: z.string(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  lastSaleorOrderId: z.string().nullable(),
  planName: z.string().nullable(),
  billingReady: z.boolean(),
});

/**
 * Internal context populated by the route handler from verified Fief claims.
 * Procedure bodies use it as a defense-in-depth ownership check.
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
    .mutation(async ({ input, ctx }) => {
      if (
        input.fiefUserId !== ctx.fiefUserId ||
        input.email.toLowerCase() !== ctx.email.toLowerCase()
      ) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Fief identity mismatch" });
      }
      const runtime = await resolveInternalSubscriptionRuntime();
      const result = await new CreateSubscriptionHandler(runtime).execute(input);

      return { ...result, publishableKey: runtime.publishableKey };
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
    .mutation(async ({ input, ctx }) => {
      const runtime = await resolveInternalSubscriptionRuntime();
      const recordResult = await runtime.subscriptionRepo.getByCustomerId(
        runtime.accessPattern,
        createStripeCustomerId(input.stripeCustomerId),
      );

      if (recordResult.isErr() || recordResult.value?.fiefUserId !== ctx.fiefUserId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Customer does not belong to user" });
      }
      const result = await runtime.stripeSubscriptionsApi.createBillingPortalSession({
        customerId: input.stripeCustomerId,
        returnUrl: input.returnUrl,
      });

      if (result.isErr()) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Portal creation failed" });
      }

      return { url: result.value.url };
    }),
  getStatus: t.procedure
    .input(getStatusInputWithVerificationSchema)
    .output(getStatusOutputSchema)
    .query(async ({ input, ctx }) => {
      const runtime = await resolveInternalSubscriptionRuntime();
      const recordResult =
        input.by === "stripeSubscriptionId"
          ? await runtime.subscriptionRepo.getBySubscriptionId(
              runtime.accessPattern,
              createStripeSubscriptionId(input.stripeSubscriptionId),
            )
          : await runtime.subscriptionRepo.getByFiefUserId(
              runtime.accessPattern,
              createFiefUserId(input.fiefUserId),
            );

      if (recordResult.isErr()) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Status lookup failed" });
      }
      const record = recordResult.value;

      if (!record) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Subscription not found" });
      }
      if (record.fiefUserId !== ctx.fiefUserId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Subscription does not belong to user",
        });
      }

      let status = record.status;
      let billingReady = false;

      if (input.verifyPaymentMethod) {
        const stripeResult = await runtime.stripeSubscriptionsApi.retrieveSubscription({
          subscriptionId: record.stripeSubscriptionId,
        });

        if (stripeResult.isErr()) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe status failed" });
        }
        status = stripeResult.value.status;
        billingReady =
          (status === "active" || status === "trialing") &&
          stripeResult.value.pending_setup_intent === null;
      }

      return {
        status,
        currentPeriodEnd: record.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: record.cancelAtPeriodEnd,
        lastSaleorOrderId: record.lastSaleorOrderId,
        planName: record.planName ?? record.stripePriceId,
        billingReady,
      };
    }),
});

export type InternalSubscriptionsRouter = typeof internalSubscriptionsRouter;

/**
 * Build an internal caller bound to verified Fief claims. Public route
 * handlers do `createInternalSubscriptionsCaller(claims).create({...})`.
 */
export const createInternalSubscriptionsCaller = (ctx: InternalSubscriptionsContext) =>
  internalSubscriptionsRouter.createCaller(ctx);
