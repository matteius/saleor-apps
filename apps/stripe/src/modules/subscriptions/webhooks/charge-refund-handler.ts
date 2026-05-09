/**
 * Subscription-aware extension of the `charge.refunded` handler (T17).
 *
 * Plan: PRD_OwlBooks_Subscription_Billing-plan.md §T17.
 *
 * ## Path selection
 *
 * The webhook payload only carries the `Charge` object — `charge.invoice`
 * is just an ID string at that point. To distinguish subscription-origin
 * refunds (where we want to auto-void the corresponding Saleor order) from
 * one-shot purchase refunds (where T18's existing `StripeRefundHandler`
 * already does the right thing), we expand the invoice via T17's
 * {@link IStripeChargesApi.retrieveChargeWithInvoice}.
 *
 *  - `expandedCharge.invoice?.subscription` set → subscription path.
 *  - otherwise → return {@link PassThroughToOneShotRefundHandlerResponse}
 *    so T18's dispatcher knows to route this to the existing
 *    `StripeRefundHandler` (one-shot purchases — unchanged behavior).
 *
 * ## Subscription-origin paths
 *
 * 1. **Full refund** (`amount_refunded === amount_captured`):
 *    a. Look up the cached `SubscriptionRecord` by `lastInvoiceId` in
 *       DynamoDB; that record carries `lastSaleorOrderId`.
 *    b. Call Saleor `orderVoid({id: lastSaleorOrderId})`.
 *    c. On success, fire OwlBooks `order.voided` notifier so the OwlBooks
 *       Postgres `SaleorOrderImport.voidedAt` gets set.
 *
 * 2. **Partial refund** (`amount_refunded < amount_captured`):
 *    Do NOT call orderVoid. Emit a Sentry alert with structured tags AND
 *    write a `pending-refund-review` DLQ entry so ops can resolve manually.
 *    Do NOT fire `order.voided` to OwlBooks.
 *
 * 3. **Cache miss on `SubscriptionRecord` lookup** (out-of-order delivery —
 *    refund fired before `invoice.paid` was processed): write to the
 *    `failed-refund` DLQ so a retry job can sweep it later. Do NOT call
 *    orderVoid; do NOT fire OwlBooks notifier.
 *
 * ## Idempotency
 *
 * `orderVoid` on an already-voided order returns a Saleor error code; we
 * surface it as `Ok(SuccessResponse)` (with `voidedSaleorOrderId: null` in
 * future revisions if needed) but for now we treat any non-empty `errors`
 * array from Saleor as a failure to retry. T18's higher-level dispatcher
 * sees the Result and decides whether Stripe should retry the webhook.
 */
import { captureException } from "@sentry/nextjs";
import { err, ok, type Result } from "neverthrow";
import type Stripe from "stripe";
import { type Client } from "urql";

import { type OrderErrorCode, SubscriptionOrderVoidDocument } from "@/generated/graphql";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import { type IStripeChargesApi } from "../api/stripe-charges-api";
import {
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "../notifiers/owlbooks-notifier";
import { type RefundDlqRepo } from "../repositories/refund-dlq-repo";
import {
  createStripeSubscriptionId,
  type SubscriptionRecord,
} from "../repositories/subscription-record";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

/*
 * ---------------------------------------------------------------------------
 * Helpers — Stripe SDK shape adapters
 * ---------------------------------------------------------------------------
 */

/**
 * Extract the subscription id from a Stripe Invoice across SDK versions.
 *
 * Stripe SDK 18+ moved the subscription link from `invoice.subscription` to
 * `invoice.parent.subscription_details.subscription`. We accept either to
 * tolerate both old fixtures and live Stripe API versions during rollout.
 * Returns null if neither is populated.
 */
function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  /* New shape (Stripe SDK 18+). */
  const parent = (invoice as unknown as { parent?: Stripe.Invoice.Parent | null }).parent;
  const newShape = parent?.subscription_details?.subscription ?? null;

  if (newShape) {
    return typeof newShape === "string" ? newShape : newShape.id;
  }

  /* Legacy shape. */
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription | null })
    .subscription;

  if (!legacy) {
    return null;
  }

  return typeof legacy === "string" ? legacy : legacy.id;
}

/*
 * ---------------------------------------------------------------------------
 * Public types — handler success / pass-through sentinel / error union
 * ---------------------------------------------------------------------------
 */

export interface ChargeRefundHandlerSuccess {
  readonly _tag: "ChargeRefundHandlerSuccess";
  readonly stripeChargeId: string;
  readonly voidedSaleorOrderId: string | null;
}

/**
 * Sentinel response: the refund is for a one-shot purchase (no subscription
 * on the underlying invoice, or no invoice at all). T18's dispatcher routes
 * on this `_tag` to fall through to the existing `StripeRefundHandler`.
 */
export class PassThroughToOneShotRefundHandlerResponse {
  readonly _tag = "PassThroughToOneShotRefundHandlerResponse" as const;
  readonly stripeChargeId: string;

  constructor(args: { stripeChargeId: string }) {
    this.stripeChargeId = args.stripeChargeId;
  }
}

export const ChargeRefundHandlerError = {
  GraphqlClientFactoryMissingError: BaseError.subclass(
    "ChargeRefundHandler.GraphqlClientFactoryMissingError",
    {
      props: {
        _internalName: "ChargeRefundHandler.GraphqlClientFactoryMissingError" as const,
      },
    },
  ),
  ChargeRetrieveFailedError: BaseError.subclass("ChargeRefundHandler.ChargeRetrieveFailedError", {
    props: {
      _internalName: "ChargeRefundHandler.ChargeRetrieveFailedError" as const,
    },
  }),
  OrderVoidFailedError: BaseError.subclass("ChargeRefundHandler.OrderVoidFailedError", {
    props: {
      _internalName: "ChargeRefundHandler.OrderVoidFailedError" as const,
    },
  }),
  NotifierFailedError: BaseError.subclass("ChargeRefundHandler.NotifierFailedError", {
    props: {
      _internalName: "ChargeRefundHandler.NotifierFailedError" as const,
    },
  }),
  CacheReadFailedError: BaseError.subclass("ChargeRefundHandler.CacheReadFailedError", {
    props: {
      _internalName: "ChargeRefundHandler.CacheReadFailedError" as const,
    },
  }),
};

export type ChargeRefundHandlerError = InstanceType<
  | typeof ChargeRefundHandlerError.GraphqlClientFactoryMissingError
  | typeof ChargeRefundHandlerError.ChargeRetrieveFailedError
  | typeof ChargeRefundHandlerError.OrderVoidFailedError
  | typeof ChargeRefundHandlerError.NotifierFailedError
  | typeof ChargeRefundHandlerError.CacheReadFailedError
  | typeof BaseError
>;

export interface IChargeRefundHandler {
  handle(
    event: Stripe.ChargeRefundedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<
    Result<
      ChargeRefundHandlerSuccess | PassThroughToOneShotRefundHandlerResponse,
      ChargeRefundHandlerError
    >
  >;
}

/*
 * ---------------------------------------------------------------------------
 * Dependency interfaces
 * ---------------------------------------------------------------------------
 */

/**
 * Factory producing a Saleor GraphQL client for a given installation. Mirrors
 * the pattern used by `lib/graphql-client.ts` so callers can pass the
 * APL-resolved auth without wiring AppConfigRepo through here.
 */
export interface ISaleorGraphqlClientFactory {
  createForInstallation(args: {
    saleorApiUrl: string;
    appId: string;
  }): Promise<Pick<Client, "mutation" | "query"> | null>;
}

export interface ChargeRefundHandlerDeps {
  stripeChargesApi: IStripeChargesApi;
  subscriptionRepo: SubscriptionRepo;
  refundDlqRepo: RefundDlqRepo;
  notifier: OwlBooksWebhookNotifier;
  /**
   * Optional injected GraphQL client. When provided, the handler uses it
   * directly (test injection); when omitted, it falls back to
   * `graphqlClientFactory.createForInstallation(ctx)`.
   */
  graphqlClient?: Pick<Client, "mutation" | "query">;
  graphqlClientFactory?: ISaleorGraphqlClientFactory;
  /**
   * Optional Sentry capture function. Defaults to `@sentry/nextjs`'s
   * `captureException` — replaceable for tests.
   */
  captureException?: typeof captureException;
}

/*
 * ---------------------------------------------------------------------------
 * Handler
 * ---------------------------------------------------------------------------
 */

export class ChargeRefundHandler implements IChargeRefundHandler {
  private readonly deps: ChargeRefundHandlerDeps;
  private readonly logger = createLogger("ChargeRefundHandler");

  constructor(deps: ChargeRefundHandlerDeps) {
    this.deps = deps;
  }

  async handle(
    event: Stripe.ChargeRefundedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<
    Result<
      ChargeRefundHandlerSuccess | PassThroughToOneShotRefundHandlerResponse,
      ChargeRefundHandlerError
    >
  > {
    const charge = event.data.object;

    this.logger.debug("Handling charge.refunded", {
      chargeId: charge.id,
      amountCaptured: charge.amount_captured,
      amountRefunded: charge.amount_refunded,
    });

    /*
     * Step 1 — expand the charge so we can read `invoice.subscription`.
     * (The webhook payload only gives us `invoice` as an ID string.)
     */
    const expandedResult = await this.deps.stripeChargesApi.retrieveChargeWithInvoice({
      chargeId: charge.id,
    });

    if (expandedResult.isErr()) {
      this.logger.error("Failed to retrieve expanded charge from Stripe", {
        chargeId: charge.id,
        error: expandedResult.error,
      });

      return err(
        new ChargeRefundHandlerError.ChargeRetrieveFailedError(
          `Stripe charges.retrieve failed for charge ${charge.id}`,
          { cause: expandedResult.error },
        ),
      );
    }

    const expandedCharge = expandedResult.value;
    const invoice = expandedCharge.invoice;

    /*
     * Step 2 — pass-through detection. No invoice OR no subscription on the
     * invoice means this is a one-shot purchase; T18's dispatcher will route
     * to the existing `StripeRefundHandler`.
     *
     * The Stripe SDK exposes the subscription link in two shapes depending
     * on the API version:
     *   - legacy: `invoice.subscription: string | Subscription | null`
     *   - 2024+: `invoice.parent.subscription_details.subscription: string | Subscription`
     * We accept either via {@link extractInvoiceSubscriptionId}.
     */
    const invoiceSubscriptionId = invoice ? extractInvoiceSubscriptionId(invoice) : null;

    if (!invoice || !invoiceSubscriptionId) {
      this.logger.debug(
        "Charge refund is not subscription-origin; passing through to one-shot refund handler",
        { chargeId: charge.id, hasInvoice: invoice !== null },
      );

      return ok(new PassThroughToOneShotRefundHandlerResponse({ stripeChargeId: charge.id }));
    }

    /*
     * Step 3 — subscription-origin path. Resolve the matching cache record
     * via the underlying Stripe subscription id (the cache row carries
     * `lastSaleorOrderId`).
     */
    const stripeSubscriptionIdRaw = invoiceSubscriptionId;

    const cacheLookupResult = await this.deps.subscriptionRepo.getBySubscriptionId(
      { saleorApiUrl: ctx.saleorApiUrl, appId: ctx.appId },
      createStripeSubscriptionId(stripeSubscriptionIdRaw),
    );

    if (cacheLookupResult.isErr()) {
      this.logger.error("Failed to read SubscriptionRecord from DynamoDB cache", {
        chargeId: charge.id,
        stripeSubscriptionId: stripeSubscriptionIdRaw,
        error: cacheLookupResult.error,
      });

      return err(
        new ChargeRefundHandlerError.CacheReadFailedError(
          `Failed to read SubscriptionRecord cache for ${stripeSubscriptionIdRaw}`,
          { cause: cacheLookupResult.error },
        ),
      );
    }

    const subscriptionRecord = cacheLookupResult.value;

    /*
     * Step 3a — out-of-order: refund landed before `invoice.paid` was
     * processed. Write to the failed-refund DLQ for later manual
     * resolution, then return Ok so Stripe stops retrying. (Stripe will
     * not redeliver the same `charge.refunded` indefinitely; ops handles
     * the manual reconciliation.)
     */
    if (!subscriptionRecord || !subscriptionRecord.lastSaleorOrderId) {
      this.logger.warn(
        "No SubscriptionRecord cache hit (or no Saleor order yet); writing failed-refund DLQ entry",
        {
          chargeId: charge.id,
          invoiceId: invoice.id,
          stripeSubscriptionId: stripeSubscriptionIdRaw,
          hasRecord: subscriptionRecord !== null,
        },
      );

      const dlqResult = await this.deps.refundDlqRepo.recordFailedRefund(
        { saleorApiUrl: ctx.saleorApiUrl, appId: ctx.appId },
        {
          stripeChargeId: charge.id,
          invoiceId: invoice.id ?? "<unknown-invoice-id>",
          refundAmountCents: charge.amount_refunded,
          currency: charge.currency,
        },
      );

      if (dlqResult.isErr()) {
        return err(
          new BaseError("Failed to write to refund DLQ", {
            cause: dlqResult.error,
          }),
        );
      }

      return ok({
        _tag: "ChargeRefundHandlerSuccess" as const,
        stripeChargeId: charge.id,
        voidedSaleorOrderId: null,
      });
    }

    /*
     * Step 3b — full vs partial refund. Use cumulative `amount_refunded`
     * (the charge object accumulates refunds across multiple Refund
     * sub-objects) compared to `amount_captured`.
     */
    const isFullRefund = charge.amount_refunded >= charge.amount_captured;

    if (!isFullRefund) {
      return this.handlePartialRefund({
        charge,
        invoice,
        subscriptionRecord,
        ctx,
      });
    }

    return this.handleFullRefund({
      charge,
      invoice,
      subscriptionRecord,
      ctx,
    });
  }

  /*
   * -------------------------------------------------------------------------
   * Internal — full-refund path
   * -------------------------------------------------------------------------
   */
  private async handleFullRefund(args: {
    charge: Stripe.Charge;
    invoice: Stripe.Invoice;
    subscriptionRecord: SubscriptionRecord;
    ctx: SubscriptionWebhookContext;
  }): Promise<Result<ChargeRefundHandlerSuccess, ChargeRefundHandlerError>> {
    const { charge, invoice, subscriptionRecord, ctx } = args;
    const saleorOrderId = subscriptionRecord.lastSaleorOrderId!;

    /* Resolve a GraphQL client. Prefer the explicitly injected one (tests). */
    let graphqlClient: Pick<Client, "mutation" | "query"> | undefined = this.deps.graphqlClient;

    if (!graphqlClient && this.deps.graphqlClientFactory) {
      const resolved = await this.deps.graphqlClientFactory.createForInstallation({
        saleorApiUrl: ctx.saleorApiUrl,
        appId: ctx.appId,
      });

      if (resolved) {
        graphqlClient = resolved;
      }
    }

    if (!graphqlClient) {
      return err(
        new ChargeRefundHandlerError.GraphqlClientFactoryMissingError(
          "No Saleor GraphQL client available — neither explicit injection nor factory configured",
        ),
      );
    }

    this.logger.info("Voiding Saleor order due to full refund", {
      chargeId: charge.id,
      saleorOrderId,
    });

    const orderVoidResp = await graphqlClient
      .mutation(SubscriptionOrderVoidDocument, { id: saleorOrderId })
      .toPromise();

    if (orderVoidResp.error) {
      return err(
        new ChargeRefundHandlerError.OrderVoidFailedError(
          `Saleor orderVoid GraphQL transport error for order ${saleorOrderId}`,
          { cause: orderVoidResp.error },
        ),
      );
    }

    const errors = orderVoidResp.data?.orderVoid?.errors ?? [];

    if (errors.length > 0) {
      const errorSummary = errors
        .map(
          (e: { code: OrderErrorCode; field?: string | null; message?: string | null }) =>
            `${e.code}${e.field ? `(${e.field})` : ""}: ${e.message ?? "<no message>"}`,
        )
        .join("; ");

      return err(
        new ChargeRefundHandlerError.OrderVoidFailedError(
          `Saleor orderVoid returned errors for order ${saleorOrderId}: ${errorSummary}`,
        ),
      );
    }

    const voidedOrderId = orderVoidResp.data?.orderVoid?.order?.id ?? saleorOrderId;

    /* Fire OwlBooks notifier — `order.voided` event. */
    const payload: OwlBooksWebhookPayload = {
      type: "order.voided",
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      stripeCustomerId: subscriptionRecord.stripeCustomerId,
      fiefUserId: subscriptionRecord.fiefUserId,
      saleorUserId: subscriptionRecord.saleorUserId,
      stripeEventCreatedAt: Math.floor(Date.now() / 1000),
      status: "ACTIVE",
      stripePriceId: subscriptionRecord.stripePriceId,
      currentPeriodStart: subscriptionRecord.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscriptionRecord.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: subscriptionRecord.cancelAtPeriodEnd,
      lastInvoiceId: invoice.id,
      lastSaleorOrderId: voidedOrderId,
      saleorChannelSlug: subscriptionRecord.saleorChannelSlug,
      stripeChargeId: charge.id,
      voidedAt: new Date().toISOString(),
    };

    const notifyResult = await this.deps.notifier.notify(payload);

    if (notifyResult.isErr()) {
      this.logger.warn("OwlBooks notifier failed for order.voided event", {
        chargeId: charge.id,
        saleorOrderId: voidedOrderId,
        error: notifyResult.error,
      });

      return err(
        new ChargeRefundHandlerError.NotifierFailedError(
          `OwlBooks order.voided notifier failed for order ${voidedOrderId}`,
          { cause: notifyResult.error },
        ),
      );
    }

    return ok({
      _tag: "ChargeRefundHandlerSuccess" as const,
      stripeChargeId: charge.id,
      voidedSaleorOrderId: voidedOrderId,
    });
  }

  /*
   * -------------------------------------------------------------------------
   * Internal — partial-refund path
   * -------------------------------------------------------------------------
   */
  private async handlePartialRefund(args: {
    charge: Stripe.Charge;
    invoice: Stripe.Invoice;
    subscriptionRecord: SubscriptionRecord;
    ctx: SubscriptionWebhookContext;
  }): Promise<Result<ChargeRefundHandlerSuccess, ChargeRefundHandlerError>> {
    const { charge, invoice, subscriptionRecord, ctx } = args;
    const saleorOrderId = subscriptionRecord.lastSaleorOrderId!;

    this.logger.warn(
      "Partial subscription refund — NOT auto-voiding; alerting Sentry + writing pending-review DLQ",
      {
        chargeId: charge.id,
        saleorOrderId,
        amountCaptured: charge.amount_captured,
        amountRefunded: charge.amount_refunded,
      },
    );

    const sentryCapture = this.deps.captureException ?? captureException;

    sentryCapture(
      new BaseError(`Partial subscription refund requires manual review (charge ${charge.id})`),
      {
        tags: {
          subsystem: "stripe-subscriptions",
          event: "charge.refunded.partial",
          stripeChargeId: charge.id,
          saleorOrderId,
          stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
        },
        extra: {
          invoiceId: invoice.id,
          amountCapturedCents: charge.amount_captured,
          amountRefundedCents: charge.amount_refunded,
          currency: charge.currency,
        },
      },
    );

    const dlqResult = await this.deps.refundDlqRepo.recordPendingReview(
      { saleorApiUrl: ctx.saleorApiUrl, appId: ctx.appId },
      {
        stripeChargeId: charge.id,
        invoiceId: invoice.id ?? "<unknown-invoice-id>",
        saleorOrderId,
        refundAmountCents: charge.amount_refunded,
        capturedAmountCents: charge.amount_captured,
        currency: charge.currency,
      },
    );

    if (dlqResult.isErr()) {
      return err(
        new BaseError("Failed to write pending-refund-review DLQ entry", {
          cause: dlqResult.error,
        }),
      );
    }

    return ok({
      _tag: "ChargeRefundHandlerSuccess" as const,
      stripeChargeId: charge.id,
      voidedSaleorOrderId: null,
    });
  }
}
