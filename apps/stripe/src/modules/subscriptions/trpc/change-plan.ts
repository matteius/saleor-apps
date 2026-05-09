/**
 * Procedure body for `subscriptions.changePlan` (T21).
 *
 * Switches an existing subscription to a new Stripe price. Stripe will
 * (depending on `prorationBehavior`) generate a proration invoice — that
 * invoice fires `invoice.paid` shortly after, and T14's `InvoiceHandler`
 * mints the corresponding Saleor order. We deliberately do NOT mint here:
 * doing so would race the webhook, and the webhook path is the
 * single-sourced "this got paid → mint a Saleor order" code path.
 *
 * Default `prorationBehavior` is `'create_prorations'` per the OwlBooks
 * billing PRD — customers expect a partial credit/charge when they upgrade
 * mid-cycle. Callers may pass `'none'` to suppress proration.
 *
 * Cache update: we write the new `stripePriceId` (and the post-update
 * `status` + `currentPeriodEnd`) to the local DDB record. As with
 * `cancel-subscription`, the `customer.subscription.updated` webhook will
 * arrive shortly after with the authoritative snapshot; the cache write
 * here is best-effort.
 *
 * Wiring: see `cancel-subscription.ts` header — same pattern.
 */
import { TRPCError } from "@trpc/server";
import type Stripe from "stripe";

import { createLogger } from "@/lib/logger";

import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import {
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
} from "../repositories/subscription-repo";

export interface ChangePlanInput {
  stripeSubscriptionId: string;
  newStripePriceId: string;
  prorationBehavior?: "create_prorations" | "none";
}

export interface ChangePlanOutput {
  status: string;
  currentPeriodEnd: string | null;
}

export interface ChangePlanHandlerDeps {
  stripeSubscriptionsApi: IStripeSubscriptionsApi;
  subscriptionRepo: SubscriptionRepo;
  accessPattern: SubscriptionRepoAccess;
}

const DEFAULT_PRORATION_BEHAVIOR: Stripe.SubscriptionUpdateParams.ProrationBehavior =
  "create_prorations";

/**
 * Stripe returns `current_period_end` per subscription item (the legacy
 * top-level field is being removed). Read from `items.data[0]` and convert
 * to ISO; if items is empty (shouldn't happen for an active sub but the
 * SDK type allows it) return null so callers don't blow up.
 */
function readCurrentPeriodEndIso(sub: Stripe.Subscription): string | null {
  const firstItem = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;

  const periodEnd = firstItem?.current_period_end;

  if (typeof periodEnd !== "number") {
    return null;
  }

  return new Date(periodEnd * 1000).toISOString();
}

function readNewPriceId(sub: Stripe.Subscription, fallback: string): string {
  const firstItem = sub.items?.data?.[0];
  const price = firstItem?.price;

  if (price && typeof price !== "string" && typeof price.id === "string") {
    return price.id;
  }

  return fallback;
}

export class ChangePlanHandler {
  private readonly deps: ChangePlanHandlerDeps;

  private readonly logger = createLogger("ChangePlanHandler");

  constructor(deps: ChangePlanHandlerDeps) {
    this.deps = deps;
  }

  async execute(input: ChangePlanInput): Promise<ChangePlanOutput> {
    const { stripeSubscriptionId, newStripePriceId } = input;
    const prorationBehavior = input.prorationBehavior ?? DEFAULT_PRORATION_BEHAVIOR;

    const brandedSubId = createStripeSubscriptionId(stripeSubscriptionId);

    /*
     * Step 1 — pre-flight cache lookup; same defense-in-depth motivation as
     * cancel-subscription. A storefront caller who can't be matched to a
     * known subscription in this installation should not be able to
     * trigger Stripe price-swap calls.
     */
    const existingResult = await this.deps.subscriptionRepo.getBySubscriptionId(
      this.deps.accessPattern,
      brandedSubId,
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
     * Step 2 — Stripe update via T7's wrapper. T7 retrieves the
     * subscription internally so it can target the existing item id
     * (Stripe requires id-targeted price replacement). On error we
     * surface INTERNAL_SERVER_ERROR with the underlying Stripe error
     * attached as `cause`.
     */
    const updateResult = await this.deps.stripeSubscriptionsApi.updateSubscription({
      subscriptionId: stripeSubscriptionId,
      newPriceId: newStripePriceId,
      prorationBehavior,
    });

    if (updateResult.isErr()) {
      this.logger.error("Stripe updateSubscription failed", {
        stripeSubscriptionId,
        newStripePriceId,
        error: updateResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe plan change failed",
        cause: updateResult.error,
      });
    }

    const stripeSub = updateResult.value;
    const effectiveNewPriceId = readNewPriceId(stripeSub, newStripePriceId);
    const currentPeriodEndIso = readCurrentPeriodEndIso(stripeSub);

    /*
     * Step 3 — best-effort cache write of the new price + status. The
     * customer.subscription.updated webhook (T15) will reconcile shortly
     * after with authoritative period dates from Stripe.
     */
    const updatedRecord = new SubscriptionRecord({
      stripeSubscriptionId: existing.stripeSubscriptionId,
      stripeCustomerId: existing.stripeCustomerId,
      saleorChannelSlug: existing.saleorChannelSlug,
      saleorUserId: existing.saleorUserId,
      fiefUserId: existing.fiefUserId,
      saleorEntityId: existing.saleorEntityId,
      stripePriceId: createStripePriceId(effectiveNewPriceId),
      status: stripeSub.status,
      currentPeriodStart: existing.currentPeriodStart,
      currentPeriodEnd: currentPeriodEndIso
        ? new Date(currentPeriodEndIso)
        : existing.currentPeriodEnd,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? existing.cancelAtPeriodEnd,
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
        "DynamoDB cache update failed after successful Stripe plan change — webhook will reconcile",
        {
          stripeSubscriptionId,
          error: upsertResult.error,
        },
      );
    }

    return {
      status: stripeSub.status,
      currentPeriodEnd: currentPeriodEndIso,
    };
  }
}
