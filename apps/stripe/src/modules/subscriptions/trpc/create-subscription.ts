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
 *   3. Look up the existing `SubscriptionRecord` for this Fief user. Resume
 *      any pending SetupIntent/PaymentIntent, fail closed on cache errors,
 *      and reuse the Stripe customer when a terminal subscription is replaced.
 *   4. Resolve / create the Stripe customer via T11.
 *   5. Call T7's `IStripeSubscriptionsApi.createSubscription` with the
 *      shared subscription options (default_incomplete, automatic_tax, and
 *      expanded PaymentIntent/SetupIntent state). A stable idempotency key
 *      collapses concurrent storefront retries into one Stripe object.
 *   6. Upsert the `SubscriptionRecord` into the DynamoDB cache (T8) with the
 *      Stripe-supplied status (typically `incomplete` or `trialing` until
 *      payment authorization completes). The subscription webhook will
 *      overwrite this shortly after with the authoritative state. A failed
 *      cache write is NON-FATAL: the Stripe subscription already exists and
 *      the webhook reconciler is the durable system of record.
 *   7. Return the subscription/customer IDs, intent type, and client secret
 *      so the storefront can confirm either deferred SetupIntent or initial
 *      PaymentIntent authorization with Stripe's Payment Element.
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
 * The dashboard tRPC router and internal storefront route instantiate this
 * deps-injected handler with their own
 * `IStripeSubscriptionsApi`, `IStripeCustomerApi`, GraphQL client, and
 * Saleor-installation `accessPattern`. Public-route production wiring resolves
 * the Saleor APL entry and installed Stripe configuration at request time.
 */
import { TRPCError } from "@trpc/server";
import type Stripe from "stripe";
import { type Client } from "urql";
import { z } from "zod";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import { type IStripeCustomerApi } from "../api/stripe-customer-api";
import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import {
  type IStripeSubscriptionsApiFactory,
  StripeSubscriptionsApiFactory,
} from "../api/stripe-subscriptions-api-factory";
import { priceVariantMapRepo as defaultPriceVariantMapRepo } from "../repositories/price-variant-map-repo-impl";
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
import { subscriptionRepo as defaultSubscriptionRepo } from "../repositories/subscription-repo-impl";
import {
  createStripePriceId as createPriceVariantStripePriceId,
  type PriceVariantMapRepo,
} from "../saleor-bridge/price-variant-map";
import {
  type ISaleorCustomerResolver,
  SaleorCustomerResolver,
} from "../saleor-bridge/saleor-customer-resolver";
import { selectSubscriptionStripeConfig } from "../subscription-stripe-config-selector";

/**
 * Re-declared here so the router can wire `new CreateSubscriptionHandler().getTrpcProcedure()`
 * directly (mirrors the T22/T23 pattern). The dashboard router file used to
 * own these inline; they now live with the handler.
 *
 * `.strict()` so unknown keys throw at validation. Storefront / dashboard
 * callers MUST NOT pass `promoCode`, `couponId`, or `discount` — the
 * existing OwlBooks `PromoCode` model is for AI-credit redemption and does
 * not apply to subscriptions in v1 (T20). The strict mode surfaces these
 * as a Zod error naming the offending key so the integration misuse is
 * obvious from the error message alone.
 */
const billingAddressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1).optional(),
  postalCode: z.string().min(1),
  country: z.string().length(2, "ISO-3166-1 alpha-2 country code (e.g. 'US')"),
});

export const createInputSchema = z
  .object({
    fiefUserId: z.string().min(1),
    email: z.string().email(),
    stripePriceId: z.string().min(1).startsWith("price_"),
    trialEnd: z.number().int().positive().optional(),
    billingAddress: billingAddressSchema.optional(),
  })
  .strict();

export const createOutputSchema = z.object({
  stripeSubscriptionId: z.string(),
  stripeCustomerId: z.string(),
  clientSecret: z.string(),
  intentType: z.enum(["payment", "setup"]),
});

export interface CreateSubscriptionInput {
  fiefUserId: string;
  email: string;
  stripePriceId: string;
  trialEnd?: number;
  billingAddress?: {
    line1: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
}

export interface CreateSubscriptionOutput {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  clientSecret: string;
  intentType: "payment" | "setup";
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
 * Optional deps for the parameterless / lazy-resolution path used by the
 * tRPC procedure. When the handler is instantiated WITHOUT a fully-built
 * `CreateSubscriptionHandlerDeps`, `getTrpcProcedure()` lazily resolves
 * the missing pieces from the procedure ctx (saleorApiUrl + appId +
 * apiClient + Stripe restricted key from `appConfigRepo`). Mirrors the T22
 * `BillingPortalTrpcHandler` shape.
 */
export interface CreateSubscriptionTrpcLazyDeps {
  stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  appConfigRepo: AppConfigRepo;
  customerResolver: ISaleorCustomerResolver;
  subscriptionRepo: SubscriptionRepo;
  priceVariantMapRepo: PriceVariantMapRepo;
}

/**
 * Prefer the expanded pending SetupIntent used by trials and other deferred
 * starts, then fall back to the first invoice's PaymentIntent. Returns null
 * when there is no customer-confirmable authorization left to complete.
 */
function extractClientSecret(
  sub: Stripe.Subscription,
): { clientSecret: string; intentType: "payment" | "setup" } | null {
  const pendingSetupIntent = sub.pending_setup_intent;

  if (pendingSetupIntent && typeof pendingSetupIntent !== "string") {
    const setupClientSecret = pendingSetupIntent.client_secret;

    if (typeof setupClientSecret === "string" && setupClientSecret.length > 0) {
      return { clientSecret: setupClientSecret, intentType: "setup" };
    }
  }

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

  return typeof clientSecret === "string" && clientSecret.length > 0
    ? { clientSecret, intentType: "payment" }
    : null;
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

const trpcLogger = createLogger("CreateSubscriptionTrpcHandler");

export class CreateSubscriptionHandler {
  baseProcedure = protectedClientProcedure;

  private readonly deps?: CreateSubscriptionHandlerDeps;

  private readonly lazyDeps: CreateSubscriptionTrpcLazyDeps;

  private readonly logger = createLogger("CreateSubscriptionHandler");

  /**
   * Two construction modes:
   *  - Pass `CreateSubscriptionHandlerDeps` for direct `execute()` use
   *    (unit tests + the deferred T29 orchestration code path).
   *  - Pass `Partial<CreateSubscriptionTrpcLazyDeps>` (or no arg) for the
   *    `getTrpcProcedure()` path — missing deps default to production
   *    impls; tests that want to exercise the procedure can swap them.
   *
   * Discriminated by the presence of `accessPattern` on the input — only
   * the eager-deps shape carries it.
   */
  constructor(deps?: CreateSubscriptionHandlerDeps | Partial<CreateSubscriptionTrpcLazyDeps>) {
    if (deps && "accessPattern" in deps && deps.accessPattern) {
      this.deps = deps;
    }

    const lazy = (deps as Partial<CreateSubscriptionTrpcLazyDeps> | undefined) ?? {};

    this.lazyDeps = {
      stripeSubscriptionsApiFactory:
        lazy.stripeSubscriptionsApiFactory ?? new StripeSubscriptionsApiFactory(),
      appConfigRepo: lazy.appConfigRepo ?? appConfigRepoImpl,
      customerResolver: lazy.customerResolver ?? new SaleorCustomerResolver(),
      subscriptionRepo: lazy.subscriptionRepo ?? defaultSubscriptionRepo,
      priceVariantMapRepo: lazy.priceVariantMapRepo ?? defaultPriceVariantMapRepo,
    };
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(createInputSchema)
      .output(createOutputSchema)
      .mutation(async ({ input, ctx }): Promise<CreateSubscriptionOutput> => {
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

        const stripeConfig = selectSubscriptionStripeConfig(
          rootConfigResult.value.getAllConfigsAsList(),
          env.SUBSCRIPTIONS_STRIPE_CONFIG_ID,
        );

        const stripeSubscriptionsApi =
          this.lazyDeps.stripeSubscriptionsApiFactory.createSubscriptionsApi({
            key: stripeConfig.restrictedKey,
          });
        const stripeCustomerApi = this.lazyDeps.stripeSubscriptionsApiFactory.createCustomerApi({
          key: stripeConfig.restrictedKey,
        });

        const handler = new CreateSubscriptionHandler({
          stripeSubscriptionsApi,
          stripeCustomerApi,
          customerResolver: this.lazyDeps.customerResolver,
          subscriptionRepo: this.lazyDeps.subscriptionRepo,
          priceVariantMapRepo: this.lazyDeps.priceVariantMapRepo,
          graphqlClient: ctx.apiClient,
          accessPattern: { saleorApiUrl: saleorApiUrl.value, appId: ctx.appId },
        });

        return handler.execute(input);
      });
  }

  async execute(input: CreateSubscriptionInput): Promise<CreateSubscriptionOutput> {
    if (!this.deps) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "CreateSubscriptionHandler.execute() called on a handler instance without eager deps. " +
          "Either construct with full `CreateSubscriptionHandlerDeps` or invoke via `.getTrpcProcedure()`.",
      });
    }

    const deps = this.deps;
    const { fiefUserId, email, stripePriceId, trialEnd, billingAddress } = input;

    /*
     * Step 1 — resolve price → Saleor channel mapping. We MUST have this
     * before calling Stripe because (a) the customer.subscription.* webhook
     * (T15) requires `metadata.saleorChannelSlug` to route, and (b) the
     * invoice.paid mint (T14) needs the variant id this mapping carries to
     * draft a Saleor order. A missing mapping is a config error from T25.
     */
    const brandedPriceId = createPriceVariantStripePriceId(stripePriceId);
    const mappingResult = await deps.priceVariantMapRepo.get(deps.accessPattern, brandedPriceId);

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
    const saleorUserResult = await deps.customerResolver.resolveSaleorUser({
      fiefUserId,
      email,
      graphqlClient: deps.graphqlClient,
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
     * A cache read error fails closed: proceeding could create duplicate Stripe
     * customers and subscriptions while the existing state is merely hidden.
     */
    const existingResult = await deps.subscriptionRepo.getByFiefUserId(
      deps.accessPattern,
      createFiefUserId(fiefUserId),
    );

    const existingRecord = existingResult.isOk() ? existingResult.value : null;
    let existingStripeCustomerId: string | undefined;
    let replacesSubscriptionId: string | undefined;

    if (existingRecord) {
      existingStripeCustomerId = existingRecord.stripeCustomerId;
    } else if (existingResult.isErr()) {
      this.logger.error("getByFiefUserId failed", {
        fiefUserId,
        error: existingResult.error,
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to check for an existing subscription",
        cause: existingResult.error,
      });
    }

    if (existingRecord && existingRecord.stripePriceId === stripePriceId) {
      if (existingRecord.status === "canceled" || existingRecord.status === "incomplete_expired") {
        replacesSubscriptionId = existingRecord.stripeSubscriptionId;
      } else {
        const retrieveResult = await deps.stripeSubscriptionsApi.retrieveSubscription({
          subscriptionId: existingRecord.stripeSubscriptionId,
        });

        if (retrieveResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to resume the existing subscription setup",
            cause: retrieveResult.error,
          });
        }

        const existingSubscription = retrieveResult.value;

        if (
          existingSubscription.status === "canceled" ||
          existingSubscription.status === "incomplete_expired"
        ) {
          replacesSubscriptionId = existingRecord.stripeSubscriptionId;
        } else {
          const existingIntent = extractClientSecret(existingSubscription);

          if (existingIntent) {
            return {
              stripeSubscriptionId: existingSubscription.id,
              stripeCustomerId: existingRecord.stripeCustomerId,
              clientSecret: existingIntent.clientSecret,
              intentType: existingIntent.intentType,
            };
          }

          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "The existing subscription is already ready for billing",
          });
        }
      }
    }

    /*
     * Step 4 — resolve / create the Stripe customer. T11's resolver tries to
     * `retrieveCustomer(existingStripeCustomerId)` first; on miss / deleted
     * it creates a fresh one with `fiefUserId` + `saleorUserId` in metadata.
     */
    const stripeCustomerResult = await deps.customerResolver.resolveStripeCustomer({
      fiefUserId,
      email,
      saleorUserId,
      stripeCustomerApi: deps.stripeCustomerApi,
      existingStripeCustomerId,
      ...(billingAddress && {
        billingAddress: {
          line1: billingAddress.line1,
          city: billingAddress.city,
          postal_code: billingAddress.postalCode,
          country: billingAddress.country.toUpperCase(),
          ...(billingAddress.state && { state: billingAddress.state }),
        },
      }),
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
     * expanded PaymentIntent and SetupIntent state. We only have to pass the
     * customer + price + metadata + idempotency key.
     *
     * Idempotency key shape: `signup-${fiefUserId}-${stripePriceId}` — pinned
     * to the (user, price) pair so concurrent retries from a flaky
     * storefront network collapse to a single Stripe object, but a genuine
     * second sign-up to a different plan still creates a new subscription.
     */
    const idempotencyKey = [
      `signup-${fiefUserId}-${stripePriceId}`,
      replacesSubscriptionId ? `after-${replacesSubscriptionId}` : null,
    ]
      .filter(Boolean)
      .join("-");

    const createResult = await deps.stripeSubscriptionsApi.createSubscription({
      customerId: stripeCustomerId,
      priceId: stripePriceId,
      metadata: {
        fiefUserId,
        saleorUserId,
        saleorChannelSlug,
      },
      idempotencyKey,
      trialEnd,
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
    const intent = extractClientSecret(stripeSub);

    if (!intent) {
      this.logger.error(
        "Stripe subscription is missing a confirmable SetupIntent or PaymentIntent",
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

    const upsertResult = await deps.subscriptionRepo.upsert(deps.accessPattern, record);

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
     * Step 7 — return the storefront-facing authorization details. The
     * intentType tells the storefront whether to call confirmSetup (deferred
     * billing) or confirmPayment (an immediately payable first invoice).
     */
    return {
      stripeSubscriptionId: stripeSub.id,
      stripeCustomerId,
      clientSecret: intent.clientSecret,
      intentType: intent.intentType,
    };
  }
}
