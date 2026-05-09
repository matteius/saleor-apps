/**
 * Procedure body for `subscriptions.create` (T20).
 *
 * Orchestrates the new-subscription chain for a Fief-authenticated storefront
 * caller (T19a) or an admin dashboard user (T19):
 *   1. Resolve the price → Saleor channel mapping (T10) so we can stamp the
 *      channel slug into Stripe metadata. The webhook side (T13/T15) requires
 *      `metadata.saleorChannelSlug` to route subscription events back to the
 *      correct Saleor channel; without a mapping we MUST fail before creating
 *      the Stripe object — silently minting against a default would corrupt
 *      multi-channel installs.
 *   2. Resolve / create the Saleor user via T11's `SaleorCustomerResolver`.
 *   3. Look up the existing `SubscriptionRecord` for this Fief user (if any)
 *      so we can reuse a previously-created Stripe customer rather than
 *      creating a duplicate on every retry.
 *   4. Resolve / create the Stripe customer via T11.
 *   5. Call T7's `IStripeSubscriptionsApi.createSubscription` with the
 *      OwlBooks-required options (default_incomplete, automatic_tax,
 *      `expand: ['latest_invoice.payment_intent']`). Pass an idempotency key
 *      of `signup-${fiefUserId}-${stripePriceId}` so storefront retries
 *      collapse to one Stripe object even under duplicate clicks.
 *   6. Upsert the `SubscriptionRecord` into the DynamoDB cache (T8) with the
 *      Stripe-supplied status (typically `incomplete` until the first PI
 *      confirms). The `customer.subscription.created` webhook (T15) will
 *      overwrite this shortly after with the authoritative state. A failed
 *      cache write is NON-FATAL: the Stripe subscription already exists and
 *      the webhook reconciler is the durable system of record.
 *   7. Return `{stripeSubscriptionId, stripeCustomerId, clientSecret}` from
 *      the expanded `latest_invoice.payment_intent.client_secret` so the
 *      storefront can confirm the first invoice's PaymentIntent client-side
 *      via Stripe's Payment Element.
 *
 * ## Promo codes
 *
 * The router-level Zod schema (`subscriptions-router.ts`) is `.strict()` so
 * unknown keys (`promoCode`, `couponId`, `discount`) throw at the validation
 * layer — this body never sees them. The OwlBooks `PromoCode` model is for
 * AI-credit redemption and does not apply to subscriptions in v1.
 *
 * ## Wiring
 *
 * Wave-6 deps-injected handler class — same shape as T21
 * (`CancelSubscriptionHandler`) and T22/T23. The dashboard tRPC router (T19)
 * and the internal storefront router (T19a) instantiate this with their own
 * `IStripeSubscriptionsApi`, `IStripeCustomerApi`, GraphQL client, and
 * Saleor-installation `accessPattern`. Production wiring (resolving the
 * Saleor APL entry → Stripe restricted key) lives in T29 (orchestration)
 * since it spans multiple subscription procedures.
 */
import { TRPCError } from "@trpc/server";
import type Stripe from "stripe";
import { type Client } from "urql";

import { createLogger } from "@/lib/logger";

import { type IStripeCustomerApi } from "../api/stripe-customer-api";
import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import {
  createFiefUserId,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
} from "../repositories/subscription-repo";
import {
  createStripePriceId as createPriceVariantStripePriceId,
  type PriceVariantMapRepo,
} from "../saleor-bridge/price-variant-map";
import { type ISaleorCustomerResolver } from "../saleor-bridge/saleor-customer-resolver";

export interface CreateSubscriptionInput {
  fiefUserId: string;
  email: string;
  stripePriceId: string;
  billingAddress?: {
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

export interface CreateSubscriptionOutput {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  clientSecret: string;
}

export interface CreateSubscriptionHandlerDeps {
  stripeSubscriptionsApi: IStripeSubscriptionsApi;
  stripeCustomerApi: IStripeCustomerApi;
  customerResolver: ISaleorCustomerResolver;
  subscriptionRepo: SubscriptionRepo;
  priceVariantMapRepo: PriceVariantMapRepo;
  /**
   * Saleor GraphQL client built via `createInstrumentedGraphqlClient(authData)`.
   * Forwarded into `customerResolver.resolveSaleorUser` (T11). Held on the
   * handler so the dashboard router (T19) and internal storefront router
   * (T19a) can inject the same APL-resolved auth.
   */
  graphqlClient: Pick<Client, "mutation" | "query">;
  /**
   * Saleor installation scope (saleorApiUrl + appId) used to read/write
   * the DDB cache and the price-variant-map. Held by the handler so callers
   * don't pass it on every invocation.
   */
  accessPattern: SubscriptionRepoAccess;
}

/**
 * Pull the expanded `latest_invoice.payment_intent.client_secret` off a
 * Stripe Subscription. Returns `null` if the chain is missing — the caller
 * (this handler) treats that as an INTERNAL_SERVER_ERROR since
 * `payment_behavior: default_incomplete` MUST yield a payment_intent on
 * cycle 1, and the storefront cannot confirm without the secret.
 */
function extractClientSecret(sub: Stripe.Subscription): string | null {
  const latestInvoice = (
    sub as Stripe.Subscription & {
      latest_invoice?: string | (Stripe.Invoice & { payment_intent?: unknown }) | null;
    }
  ).latest_invoice;

  if (!latestInvoice || typeof latestInvoice === "string") {
    return null;
  }

  const paymentIntent = (latestInvoice as { payment_intent?: unknown }).payment_intent;

  if (!paymentIntent || typeof paymentIntent === "string") {
    return null;
  }

  const clientSecret = (paymentIntent as { client_secret?: string | null }).client_secret;

  return typeof clientSecret === "string" && clientSecret.length > 0 ? clientSecret : null;
}

/**
 * Pull current_period_start / current_period_end off a Subscription. In Stripe
 * API v2025+ (SDK 18.x) these moved from the subscription onto each
 * SubscriptionItem. We always read from the first item — OwlBooks v1 issues
 * exactly one item per subscription. Returns `null` for either field if
 * unavailable; callers default to `new Date()` so we still write a complete
 * cache row even before the first webhook fires.
 */
function extractPeriodBoundaries(sub: Stripe.Subscription): {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
} {
  const firstItem = sub.items?.data?.[0];

  const startUnix = (firstItem as unknown as { current_period_start?: number } | undefined)
    ?.current_period_start;
  const endUnix = (firstItem as unknown as { current_period_end?: number } | undefined)
    ?.current_period_end;

  const now = new Date();

  return {
    currentPeriodStart: typeof startUnix === "number" ? new Date(startUnix * 1000) : now,
    currentPeriodEnd: typeof endUnix === "number" ? new Date(endUnix * 1000) : now,
  };
}

export class CreateSubscriptionHandler {
  private readonly deps: CreateSubscriptionHandlerDeps;

  private readonly logger = createLogger("CreateSubscriptionHandler");

  constructor(deps: CreateSubscriptionHandlerDeps) {
    this.deps = deps;
  }

  async execute(input: CreateSubscriptionInput): Promise<CreateSubscriptionOutput> {
    const { fiefUserId, email, stripePriceId } = input;

    /*
     * Step 1 — resolve price → Saleor channel mapping. We MUST have this
     * before calling Stripe because (a) the customer.subscription.* webhook
     * (T15) requires `metadata.saleorChannelSlug` to route, and (b) the
     * invoice.paid mint (T14) needs the variant id this mapping carries to
     * draft a Saleor order. A missing mapping is a config error from T25.
     */
    const brandedPriceId = createPriceVariantStripePriceId(stripePriceId);
    const mappingResult = await this.deps.priceVariantMapRepo.get(
      this.deps.accessPattern,
      brandedPriceId,
    );

    if (mappingResult.isErr()) {
      this.logger.error("Failed to read price→variant mapping", {
        stripePriceId,
        error: mappingResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to read price-variant mapping",
        cause: mappingResult.error,
      });
    }

    const mapping = mappingResult.value;

    if (!mapping) {
      this.logger.warn("No price-variant mapping configured for stripePriceId", {
        stripePriceId,
      });

      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          `No Saleor variant mapping is configured for Stripe price ${stripePriceId}. ` +
          "An admin must add the mapping in the Stripe app's subscriptions config (T25) before this price can be sold.",
      });
    }

    const saleorChannelSlug = mapping.saleorChannelSlug;

    /*
     * Step 2 — resolve the Saleor user (creates one if missing). Wraps T11.
     * Errors here block the chain since we cannot mint orders for a
     * subscription that has no Saleor counterpart.
     */
    const saleorUserResult = await this.deps.customerResolver.resolveSaleorUser({
      fiefUserId,
      email,
      graphqlClient: this.deps.graphqlClient,
    });

    if (saleorUserResult.isErr()) {
      this.logger.error("resolveSaleorUser failed", {
        fiefUserId,
        error: saleorUserResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to resolve Saleor user for subscription",
        cause: saleorUserResult.error,
      });
    }

    const saleorUserId = saleorUserResult.value.saleorUserId;

    /*
     * Step 3 — look up the existing subscription record for this Fief user
     * so we can reuse the prior Stripe customer id. Without this, every
     * retry on `default_incomplete` would create a duplicate Stripe customer.
     * A read error is NON-FATAL — we proceed without `existingStripeCustomerId`
     * and the resolver will create a fresh customer (which is the safe default).
     */
    const existingResult = await this.deps.subscriptionRepo.getByFiefUserId(
      this.deps.accessPattern,
      createFiefUserId(fiefUserId),
    );

    let existingStripeCustomerId: string | undefined;

    if (existingResult.isOk() && existingResult.value) {
      existingStripeCustomerId = existingResult.value.stripeCustomerId;
    } else if (existingResult.isErr()) {
      this.logger.warn(
        "getByFiefUserId failed — proceeding without existing Stripe customer reuse",
        {
          fiefUserId,
          error: existingResult.error,
        },
      );
    }

    /*
     * Step 4 — resolve / create the Stripe customer. T11's resolver tries to
     * `retrieveCustomer(existingStripeCustomerId)` first; on miss / deleted
     * it creates a fresh one with `fiefUserId` + `saleorUserId` in metadata.
     */
    const stripeCustomerResult = await this.deps.customerResolver.resolveStripeCustomer({
      fiefUserId,
      email,
      saleorUserId,
      stripeCustomerApi: this.deps.stripeCustomerApi,
      existingStripeCustomerId,
    });

    if (stripeCustomerResult.isErr()) {
      this.logger.error("resolveStripeCustomer failed", {
        fiefUserId,
        saleorUserId,
        error: stripeCustomerResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to resolve Stripe customer for subscription",
        cause: stripeCustomerResult.error,
      });
    }

    const stripeCustomerId = stripeCustomerResult.value.stripeCustomerId;

    /*
     * Step 5 — call Stripe via T7's wrapper. The wrapper supplies
     * `payment_behavior: default_incomplete`, `automatic_tax: enabled`,
     * `payment_settings.save_default_payment_method`, and
     * `expand: ['latest_invoice.payment_intent']`. We only have to pass the
     * customer + price + metadata + idempotency key.
     *
     * Idempotency key shape: `signup-${fiefUserId}-${stripePriceId}` — pinned
     * to the (user, price) pair so concurrent retries from a flaky
     * storefront network collapse to a single Stripe object, but a genuine
     * second sign-up to a different plan still creates a new subscription.
     */
    const idempotencyKey = `signup-${fiefUserId}-${stripePriceId}`;

    const createResult = await this.deps.stripeSubscriptionsApi.createSubscription({
      customerId: stripeCustomerId,
      priceId: stripePriceId,
      metadata: {
        fiefUserId,
        saleorUserId,
        saleorChannelSlug,
      },
      idempotencyKey,
    });

    if (createResult.isErr()) {
      this.logger.error("Stripe createSubscription failed", {
        fiefUserId,
        stripePriceId,
        error: createResult.error,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe subscription creation failed",
        cause: createResult.error,
      });
    }

    const stripeSub = createResult.value;
    const clientSecret = extractClientSecret(stripeSub);

    if (!clientSecret) {
      this.logger.error(
        "Stripe subscription is missing latest_invoice.payment_intent.client_secret",
        {
          stripeSubscriptionId: stripeSub.id,
          fiefUserId,
        },
      );

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Stripe subscription created without a usable client_secret — storefront cannot confirm payment",
      });
    }

    /*
     * Step 6 — best-effort cache upsert. The webhook
     * `customer.subscription.created` fires shortly after and is the
     * authoritative reconciler (T15). A failed write here is logged but
     * does NOT propagate, because the Stripe-side subscription already
     * exists and surfacing an error would mislead the storefront into
     * thinking the create did not happen.
     */
    const { currentPeriodStart, currentPeriodEnd } = extractPeriodBoundaries(stripeSub);

    const record = new SubscriptionRecord({
      stripeSubscriptionId: createStripeSubscriptionId(stripeSub.id),
      stripeCustomerId: createStripeCustomerId(stripeCustomerId),
      saleorChannelSlug,
      saleorUserId,
      fiefUserId: createFiefUserId(fiefUserId),
      saleorEntityId: null,
      stripePriceId: createStripePriceId(stripePriceId),
      status: stripeSub.status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
      lastInvoiceId: null,
      lastSaleorOrderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const upsertResult = await this.deps.subscriptionRepo.upsert(this.deps.accessPattern, record);

    if (upsertResult.isErr()) {
      this.logger.warn(
        "DynamoDB cache upsert failed after successful Stripe createSubscription — webhook will reconcile",
        {
          stripeSubscriptionId: stripeSub.id,
          error: upsertResult.error,
        },
      );
    }

    /*
     * Step 7 — return the storefront-facing trio. The clientSecret drives
     * Stripe's Payment Element on the storefront; on confirm the
     * customer.subscription.updated → invoice.paid chain promotes the
     * subscription out of `incomplete`.
     */
    return {
      stripeSubscriptionId: stripeSub.id,
      stripeCustomerId,
      clientSecret,
    };
  }
}
