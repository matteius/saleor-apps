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

import { createLogger } from "@/lib/logger";

import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import {
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
} from "../repositories/subscription-repo";

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

export class CancelSubscriptionHandler {
  private readonly deps: CancelSubscriptionHandlerDeps;

  private readonly logger = createLogger("CancelSubscriptionHandler");

  constructor(deps: CancelSubscriptionHandlerDeps) {
    this.deps = deps;
  }

  async execute(input: CancelSubscriptionInput): Promise<CancelSubscriptionOutput> {
    const { stripeSubscriptionId, immediate = false } = input;

    const brandedId = createStripeSubscriptionId(stripeSubscriptionId);

    /*
     * Step 1 — pre-flight cache lookup. Bail before touching Stripe if the
     * storefront caller is asking about a subscription we don't have a
     * record for in this installation. Defense-in-depth on top of the
     * Fief/HMAC auth at the public-API edge.
     */
    const existingResult = await this.deps.subscriptionRepo.getBySubscriptionId(
      this.deps.accessPattern,
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
    const cancelResult = await this.deps.stripeSubscriptionsApi.cancelSubscription({
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

    const upsertResult = await this.deps.subscriptionRepo.upsert(
      this.deps.accessPattern,
      updatedRecord,
    );

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
