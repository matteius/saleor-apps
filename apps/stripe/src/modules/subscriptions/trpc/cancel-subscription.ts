/**
 * Procedure body for `subscriptions.cancel` (T21).
 *
 * Two cancellation modes:
 *  - **default** (`immediate` omitted/false): Stripe sets
 *    `cancel_at_period_end=true`; the subscription stays `active` until the
 *    end of the paid period. T7's `cancelSubscription({immediate: false})`
 *    handles the `subscriptions.update` call.
 *  - **immediate** (`immediate=true`): Stripe terminates the subscription
 *    on the spot. T7's wrapper calls `subscriptions.cancel(id)`.
 *
 * Pre-flight cache lookup: we read the local DDB record before calling
 * Stripe so we can (a) bail with `NOT_FOUND` if the storefront caller is
 * targeting a subscription we don't own, and (b) propagate the cache update
 * post-cancel without a second round trip. The `customer.subscription.*`
 * webhook (T15) fires shortly after and is the authoritative reconciler;
 * the cache write here is a best-effort optimistic update so subsequent
 * storefront polls see the new state without waiting for the webhook hop.
 * A failed cache write is therefore non-fatal.
 *
 * Wiring: this module exports a `CancelSubscriptionHandler` class that the
 * dashboard tRPC router (T19) and the internal storefront router (T19a)
 * will instantiate with their own `IStripeSubscriptionsApi`,
 * `SubscriptionRepo`, and `accessPattern`. Direct integration into the
 * routers is deferred to T29 (orchestration); this task lands the body so
 * unit tests cover the procedure logic in isolation.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import {
  type IStripeSubscriptionsApiFactory,
  StripeSubscriptionsApiFactory,
} from "../api/stripe-subscriptions-api-factory";
import {
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
} from "../repositories/subscription-repo";
import { subscriptionRepo as defaultSubscriptionRepo } from "../repositories/subscription-repo-impl";

/**
 * Re-declared here so the router can wire `new CancelSubscriptionHandler().getTrpcProcedure()`
 * directly (mirrors the T22/T23 pattern). The dashboard router file used to
 * own these inline; they now live with the handler.
 */
export const cancelInputSchema = z.object({
  stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  immediate: z.boolean().optional(),
});

export const cancelOutputSchema = z.object({
  status: z.string(),
});

export interface CancelSubscriptionInput {
  stripeSubscriptionId: string;
  immediate?: boolean;
}

export interface CancelSubscriptionOutput {
  status: string;
}

export interface CancelSubscriptionHandlerDeps {
  stripeSubscriptionsApi: IStripeSubscriptionsApi;
  subscriptionRepo: SubscriptionRepo;
  /**
   * Saleor installation scope (saleorApiUrl + appId) used to read/write
   * the DDB cache record. Held by the handler so callers don't pass it on
   * every invocation.
   */
  accessPattern: SubscriptionRepoAccess;
}

/**
 * Optional deps for the parameterless / lazy-resolution path used by the
 * tRPC procedure. When the handler is instantiated WITHOUT a fully-built
 * `CancelSubscriptionHandlerDeps` (e.g. `new CancelSubscriptionHandler()`),
 * `getTrpcProcedure()` lazily resolves the missing pieces from the
 * procedure ctx (saleorApiUrl + appId + Stripe restricted key from
 * `appConfigRepo`). Mirrors the T22 `BillingPortalTrpcHandler` shape.
 */
export interface CancelSubscriptionTrpcLazyDeps {
  stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  appConfigRepo: AppConfigRepo;
  subscriptionRepo: SubscriptionRepo;
}

const trpcLogger = createLogger("CancelSubscriptionTrpcHandler");

export class CancelSubscriptionHandler {
  baseProcedure = protectedClientProcedure;

  /**
   * Execution-mode deps: present when the handler was constructed with a
   * fully-built `CancelSubscriptionHandlerDeps` (the path the unit tests
   * exercise). Absent when constructed parameterless via `new
   * CancelSubscriptionHandler()` for `getTrpcProcedure()` — the procedure
   * resolves lazy deps from ctx instead.
   */
  private readonly deps?: CancelSubscriptionHandlerDeps;

  private readonly lazyDeps: CancelSubscriptionTrpcLazyDeps;

  private readonly logger = createLogger("CancelSubscriptionHandler");

  /**
   * Two construction modes:
   *  - Pass `CancelSubscriptionHandlerDeps` for direct `execute()` use
   *    (unit tests + the deferred T29 orchestration code path).
   *  - Pass `Partial<CancelSubscriptionTrpcLazyDeps>` (or no arg) for the
   *    `getTrpcProcedure()` path — missing deps default to production
   *    impls; tests that want to exercise the procedure can swap them.
   *
   * Discriminated by the presence of `accessPattern` on the input — only
   * the eager-deps shape carries it.
   */
  constructor(deps?: CancelSubscriptionHandlerDeps | Partial<CancelSubscriptionTrpcLazyDeps>) {
    if (deps && "accessPattern" in deps && deps.accessPattern) {
      this.deps = deps;
    }

    const lazy = (deps as Partial<CancelSubscriptionTrpcLazyDeps> | undefined) ?? {};

    this.lazyDeps = {
      stripeSubscriptionsApiFactory:
        lazy.stripeSubscriptionsApiFactory ?? new StripeSubscriptionsApiFactory(),
      appConfigRepo: lazy.appConfigRepo ?? appConfigRepoImpl,
      subscriptionRepo: lazy.subscriptionRepo ?? defaultSubscriptionRepo,
    };
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(cancelInputSchema)
      .output(cancelOutputSchema)
      .mutation(async ({ input, ctx }): Promise<CancelSubscriptionOutput> => {
        const saleorApiUrl = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrl.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Malformed saleorApiUrl",
          });
        }

        const rootConfigResult = await this.lazyDeps.appConfigRepo.getRootConfig({
          saleorApiUrl: saleorApiUrl.value,
          appId: ctx.appId,
        });

        if (rootConfigResult.isErr()) {
          trpcLogger.error("Failed to load root config", { error: rootConfigResult.error });

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

        const stripeSubscriptionsApi =
          this.lazyDeps.stripeSubscriptionsApiFactory.createSubscriptionsApi({
            key: stripeConfigs[0].restrictedKey,
          });

        const handler = new CancelSubscriptionHandler({
          stripeSubscriptionsApi,
          subscriptionRepo: this.lazyDeps.subscriptionRepo,
          accessPattern: { saleorApiUrl: saleorApiUrl.value, appId: ctx.appId },
        });

        return handler.execute(input);
      });
  }

  async execute(input: CancelSubscriptionInput): Promise<CancelSubscriptionOutput> {
    if (!this.deps) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "CancelSubscriptionHandler.execute() called on a handler instance without eager deps. " +
          "Either construct with `new CancelSubscriptionHandler({stripeSubscriptionsApi, subscriptionRepo, accessPattern})` " +
          "or invoke via `.getTrpcProcedure()`.",
      });
    }

    const deps = this.deps;
    const { stripeSubscriptionId, immediate = false } = input;

    const brandedId = createStripeSubscriptionId(stripeSubscriptionId);

    /*
     * Step 1 — pre-flight cache lookup. Bail before touching Stripe if the
     * storefront caller is asking about a subscription we don't have a
     * record for in this installation. Defense-in-depth on top of the
     * Fief/HMAC auth at the public-API edge.
     */
    const existingResult = await deps.subscriptionRepo.getBySubscriptionId(
      deps.accessPattern,
      brandedId,
    );

    if (existingResult.isErr()) {
      this.logger.error("Failed to read subscription from cache", {
        stripeSubscriptionId,
        error: existingResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to read subscription cache",
        cause: existingResult.error,
      });
    }

    const existing = existingResult.value;

    if (!existing) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Subscription ${stripeSubscriptionId} not found in this installation`,
      });
    }

    /*
     * Step 2 — call Stripe via T7's wrapper. The wrapper distinguishes
     * `immediate` internally (subscriptions.cancel vs subscriptions.update
     * with cancel_at_period_end). On error we surface INTERNAL_SERVER_ERROR
     * with the underlying Stripe error attached as `cause` for tracing.
     */
    const cancelResult = await deps.stripeSubscriptionsApi.cancelSubscription({
      subscriptionId: stripeSubscriptionId,
      immediate,
    });

    if (cancelResult.isErr()) {
      this.logger.error("Stripe cancelSubscription failed", {
        stripeSubscriptionId,
        immediate,
        error: cancelResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe cancellation failed",
        cause: cancelResult.error,
      });
    }

    const stripeSub = cancelResult.value;

    /*
     * Step 3 — best-effort cache update. The webhook from Stripe
     * (`customer.subscription.updated` for soft-cancel,
     * `customer.subscription.deleted` for immediate) will overwrite this
     * with the authoritative state shortly after — see T15. We log on
     * failure but don't propagate, because the Stripe-side cancel is
     * already in flight and surfacing an error here would mislead the
     * storefront into thinking the cancel did not happen.
     */
    const newStatus = stripeSub.status;
    const newCancelAtPeriodEnd = immediate ? false : true;

    const updatedRecord = new SubscriptionRecord({
      stripeSubscriptionId: existing.stripeSubscriptionId,
      stripeCustomerId: existing.stripeCustomerId,
      saleorChannelSlug: existing.saleorChannelSlug,
      saleorUserId: existing.saleorUserId,
      fiefUserId: existing.fiefUserId,
      saleorEntityId: existing.saleorEntityId,
      stripePriceId: existing.stripePriceId,
      status: newStatus,
      currentPeriodStart: existing.currentPeriodStart,
      currentPeriodEnd: existing.currentPeriodEnd,
      cancelAtPeriodEnd: newCancelAtPeriodEnd,
      lastInvoiceId: existing.lastInvoiceId,
      lastSaleorOrderId: existing.lastSaleorOrderId,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    });

    const upsertResult = await deps.subscriptionRepo.upsert(deps.accessPattern, updatedRecord);

    if (upsertResult.isErr()) {
      this.logger.warn(
        "DynamoDB cache update failed after successful Stripe cancel — webhook will reconcile",
        {
          stripeSubscriptionId,
          error: upsertResult.error,
        },
      );
    }

    return { status: newStatus };
  }
}
