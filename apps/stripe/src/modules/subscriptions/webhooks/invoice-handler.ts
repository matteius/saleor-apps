/**
 * Handler for `invoice.{paid,payment_failed}` events.
 *
 * - `invoice.paid` (T14 — THE Saleor order mint bridge per PRD §5.4):
 *     1. Look up cached `SubscriptionRecord` by Stripe subscription id.
 *     2. Idempotency check vs `lastInvoiceId` (DynamoDB cache); a second
 *        webhook for the same invoice short-circuits to `Ok` without minting.
 *     3. Resolve Saleor variant from Stripe price via T10's
 *        `IPriceVariantMapRepo.get`. An unknown price ID returns
 *        `Err(UnknownStripePriceError)` rather than minting against a
 *        placeholder variant.
 *     4. Call T9's `mintOrderFromInvoice` to create + complete a Saleor draft
 *        order and record the Stripe transaction.
 *     5. Update `lastInvoiceId` + `lastSaleorOrderId` on the cached record.
 *     6. Notify OwlBooks via T28's `/api/webhooks/subscription-status`
 *        receiver. The OwlBooks Postgres path provides the second line of
 *        idempotency defense via `SaleorOrderImport.stripeInvoiceId @unique`
 *        (T31 hardens this further).
 *
 *   Postgres-side concern: writing `'PAST_DUE'` (and other newly-added
 *   subscription statuses) requires the Postgres enum migration to have run.
 *   T28 documents this as a manual `ALTER TYPE` until the production migration
 *   ships; unit tests are unaffected.
 *
 *   Tax handling is intentionally minimal here — `taxCents` is the simple sum
 *   of `invoice.total_tax_amounts[].amount`. T30 extends `mintOrderFromInvoice`
 *   itself with full Saleor draft-order tax-line propagation.
 *
 * - `invoice.payment_failed` (T16): updates the cached subscription status
 *   to `past_due` and notifies OwlBooks. Does NOT mint a Saleor order — no
 *   money moved. Stripe handles smart-retry; if all retries exhaust,
 *   `customer.subscription.deleted` fires and T15 cancels.
 */
import { type APL } from "@saleor/app-sdk/APL";
import { err, ok, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type OwlBooksSubscriptionStatus,
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "../notifiers/owlbooks-notifier";
import {
  createStripeSubscriptionId,
  SubscriptionRecord,
  type SubscriptionStatus,
} from "../repositories/subscription-record";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import { createStripePriceId, type PriceVariantMapRepo } from "../saleor-bridge/price-variant-map";
import {
  type MintOrderFromInvoiceArgs,
  type MintOrderFromInvoiceResult,
  type SaleorOrderFromInvoiceError,
} from "../saleor-bridge/saleor-order-from-invoice";
import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

export const TODO_T14_INVOICE_HANDLER = "implement in T14";
export const TODO_T16_INVOICE_HANDLER = "implement in T16";

/*
 * ---------------------------------------------------------------------------
 * Result types
 * ---------------------------------------------------------------------------
 */

export interface InvoiceHandlerSuccess {
  readonly _tag: "InvoiceHandlerSuccess";
  readonly stripeInvoiceId: string;
  readonly mintedSaleorOrderId: string | null;
}

const SubscriptionRecordMissingError = BaseError.subclass(
  "InvoiceHandler.SubscriptionRecordMissingError",
  {
    props: { _internalName: "InvoiceHandler.SubscriptionRecordMissingError" },
  },
);

const UnknownStripePriceError = BaseError.subclass("InvoiceHandler.UnknownStripePriceError", {
  props: { _internalName: "InvoiceHandler.UnknownStripePriceError" },
});

const SubscriptionRepoFailedError = BaseError.subclass(
  "InvoiceHandler.SubscriptionRepoFailedError",
  {
    props: { _internalName: "InvoiceHandler.SubscriptionRepoFailedError" },
  },
);

const PriceVariantMapFailedError = BaseError.subclass("InvoiceHandler.PriceVariantMapFailedError", {
  props: { _internalName: "InvoiceHandler.PriceVariantMapFailedError" },
});

const MintFailedError = BaseError.subclass("InvoiceHandler.MintFailedError", {
  props: { _internalName: "InvoiceHandler.MintFailedError" },
});

const InvoiceMissingFieldError = BaseError.subclass("InvoiceHandler.InvoiceMissingFieldError", {
  props: { _internalName: "InvoiceHandler.InvoiceMissingFieldError" },
});

const AuthDataMissingError = BaseError.subclass("InvoiceHandler.AuthDataMissingError", {
  props: { _internalName: "InvoiceHandler.AuthDataMissingError" },
});

const NotConfiguredError = BaseError.subclass("InvoiceHandler.NotConfiguredError", {
  props: { _internalName: "InvoiceHandler.NotConfiguredError" },
});

export const InvoiceHandlerErrors = {
  SubscriptionRecordMissingError,
  UnknownStripePriceError,
  SubscriptionRepoFailedError,
  PriceVariantMapFailedError,
  MintFailedError,
  InvoiceMissingFieldError,
  AuthDataMissingError,
  NotConfiguredError,
};

export type InvoiceHandlerError = InstanceType<
  | typeof SubscriptionRecordMissingError
  | typeof UnknownStripePriceError
  | typeof SubscriptionRepoFailedError
  | typeof PriceVariantMapFailedError
  | typeof MintFailedError
  | typeof InvoiceMissingFieldError
  | typeof AuthDataMissingError
  | typeof NotConfiguredError
  | typeof BaseError
>;

export interface IInvoiceHandler {
  handlePaid(
    event: Stripe.InvoicePaidEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>>;

  handleFailed(
    event: Stripe.InvoicePaymentFailedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>>;
}

/*
 * ---------------------------------------------------------------------------
 * Dependencies
 * ---------------------------------------------------------------------------
 */

/**
 * Pluggable mint function — narrowed to a function-shape so unit tests can
 * inject a `vi.fn()` rather than a class instance. The default is T9's free
 * function `mintOrderFromInvoice`.
 */
export type MintOrderFromInvoiceFn = (
  args: MintOrderFromInvoiceArgs,
) => Promise<Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>>;

/**
 * Factory that produces a Saleor GraphQL client given APL `authData`. Default
 * implementation calls `createInstrumentedGraphqlClient(authData)`. Tests
 * inject a fake `Pick<Client, "mutation" | "query">` directly.
 */
export type GraphqlClientFactory = (authData: {
  saleorApiUrl: string;
  token: string;
}) => MintOrderFromInvoiceArgs["graphqlClient"];

export interface InvoiceHandlerDeps {
  subscriptionRepo: SubscriptionRepo;
  priceVariantMapRepo: PriceVariantMapRepo;
  owlbooksWebhookNotifier: OwlBooksWebhookNotifier;
  apl: APL;
  /** Override for tests; production uses T9's free function. */
  mintOrderFromInvoice?: MintOrderFromInvoiceFn;
  /** Override for tests; production uses `createInstrumentedGraphqlClient`. */
  graphqlClientFactory?: GraphqlClientFactory;
}

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

const logger = createLogger("InvoiceHandler");

/**
 * Stripe `Invoice.subscription` may be a string id, a populated `Subscription`
 * object, or null. Normalize to a string id; null/undefined means this is a
 * one-shot invoice (not subscription-billed) and we must NOT route through
 * the subscription-mint path.
 */
function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = (invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null })
    .subscription;

  if (!sub) {
    return null;
  }

  return typeof sub === "string" ? sub : sub.id;
}

/**
 * Stripe `Invoice.charge` may be a string id, a populated `Charge` object, or
 * null. Used here for the OwlBooks payload's `stripeChargeId` field.
 */
function extractChargeId(invoice: Stripe.Invoice): string | null {
  const charge = (invoice as Stripe.Invoice & { charge?: string | Stripe.Charge | null }).charge;

  if (!charge) {
    return null;
  }

  return typeof charge === "string" ? charge : charge.id;
}

/**
 * Sum tax amounts across jurisdictions. T30 will move to full per-line tax
 * propagation onto the Saleor draft order; for v1 of the OwlBooks AR row we
 * only need a single integer-cent total.
 */
function sumTaxCents(invoice: Stripe.Invoice): number {
  const taxAmounts = (
    invoice as Stripe.Invoice & {
      total_tax_amounts?: Array<{ amount: number }> | null;
    }
  ).total_tax_amounts;

  if (!taxAmounts || taxAmounts.length === 0) {
    return 0;
  }

  return taxAmounts.reduce((s, t) => s + t.amount, 0);
}

/**
 * Stripe subscription statuses are lowercase strings; OwlBooks's enum is
 * UPPERCASE per T28's Zod schema. This is a deliberate translation point —
 * Stripe's "incomplete_expired" maps 1:1 to OwlBooks "INCOMPLETE_EXPIRED",
 * "past_due" to "PAST_DUE", etc.
 */
function toOwlBooksStatus(status: SubscriptionStatus): OwlBooksSubscriptionStatus {
  return status.toUpperCase() as OwlBooksSubscriptionStatus;
}

function isoOrUndefined(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString() : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Implementation
 * ---------------------------------------------------------------------------
 */

export class InvoiceHandler implements IInvoiceHandler {
  private readonly deps: InvoiceHandlerDeps | null;

  /**
   * Deps are optional to preserve the historical no-arg constructor used by
   * `SubscriptionWebhookUseCase` when no override is injected. Without deps
   * the methods return `Err(NotConfiguredError)` so a misconfigured
   * production wiring fails loud rather than silently returning a no-op. The
   * use-case passes deps in production after T14.
   */
  constructor(deps?: InvoiceHandlerDeps) {
    this.deps = deps ?? null;
  }

  async handlePaid(
    event: Stripe.InvoicePaidEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>> {
    const deps = this.deps;

    if (!deps) {
      return err(
        new NotConfiguredError("InvoiceHandler is not wired with deps; cannot handle invoice.paid"),
      );
    }

    const invoice = event.data.object;

    if (!invoice.id) {
      return err(new InvoiceMissingFieldError("invoice.id missing on invoice.paid event"));
    }

    const stripeInvoiceId = invoice.id;
    const subscriptionId = extractSubscriptionId(invoice);

    if (!subscriptionId) {
      logger.debug(
        "invoice.paid carried no subscription field — one-shot invoice path, returning Ok no-op",
        { stripeInvoiceId },
      );

      return ok({
        _tag: "InvoiceHandlerSuccess",
        stripeInvoiceId,
        mintedSaleorOrderId: null,
      });
    }

    const repoAccess = { saleorApiUrl: ctx.saleorApiUrl, appId: ctx.appId };

    const lookupResult = await deps.subscriptionRepo.getBySubscriptionId(
      repoAccess,
      createStripeSubscriptionId(subscriptionId),
    );

    if (lookupResult.isErr()) {
      logger.error("Failed to look up SubscriptionRecord during invoice.paid", {
        stripeInvoiceId,
        subscriptionId,
        error: lookupResult.error,
      });

      return err(
        new SubscriptionRepoFailedError(
          `Failed to read subscription record for ${subscriptionId}`,
          { cause: lookupResult.error },
        ),
      );
    }

    const subscriptionRecord = lookupResult.value;

    if (!subscriptionRecord) {
      /*
       * Race vs T13's customer.subscription.created arrival. Returning Err
       * signals the dispatcher to surface a non-2xx so Stripe retries the
       * delivery.
       */
      logger.warn(
        "No SubscriptionRecord found for invoice.paid — likely race vs sub.created arrival; returning Err to trigger Stripe retry",
        { stripeInvoiceId, subscriptionId },
      );

      return err(
        new SubscriptionRecordMissingError(
          `No cached SubscriptionRecord for stripeSubscriptionId=${subscriptionId} on invoice.paid`,
        ),
      );
    }

    /*
     * Idempotency layer 1: in-memory check vs DynamoDB cache. Stripe webhooks
     * are at-least-once; a second delivery of the same `invoice.paid` MUST
     * NOT mint a second Saleor order. Layer 2 (Postgres `@unique` on
     * SaleorOrderImport.stripeInvoiceId) is enforced by T28's receiver.
     */
    if (subscriptionRecord.lastInvoiceId === stripeInvoiceId) {
      logger.info("invoice.paid is a replay (lastInvoiceId match) — returning Ok without minting", {
        stripeInvoiceId,
        subscriptionId,
        existingSaleorOrderId: subscriptionRecord.lastSaleorOrderId,
      });

      return ok({
        _tag: "InvoiceHandlerSuccess",
        stripeInvoiceId,
        mintedSaleorOrderId: subscriptionRecord.lastSaleorOrderId,
      });
    }

    // Resolve Saleor variant via T10.
    const mappingResult = await deps.priceVariantMapRepo.get(
      repoAccess,
      createStripePriceId(subscriptionRecord.stripePriceId),
    );

    if (mappingResult.isErr()) {
      logger.error("Failed to resolve price→variant mapping during invoice.paid", {
        stripeInvoiceId,
        stripePriceId: subscriptionRecord.stripePriceId,
        error: mappingResult.error,
      });

      return err(
        new PriceVariantMapFailedError(
          `Failed to read price→variant mapping for ${subscriptionRecord.stripePriceId}`,
          { cause: mappingResult.error },
        ),
      );
    }

    const mapping = mappingResult.value;

    if (!mapping) {
      /*
       * Unknown price → DO NOT mint with a placeholder variant. Operator
       * intervention required (T25 admin UI). Loud log + Err so on-call sees
       * it; the original webhook returns 4xx so Stripe stops retrying (we
       * can't recover by retry).
       */
      logger.error(
        "[invoice.paid] UNKNOWN STRIPE PRICE — no Saleor variant mapping; alert + skip mint",
        {
          stripeInvoiceId,
          stripePriceId: subscriptionRecord.stripePriceId,
          stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
        },
      );

      return err(
        new UnknownStripePriceError(
          `No Saleor variant mapping for stripePriceId=${subscriptionRecord.stripePriceId} — refusing to mint with placeholder`,
        ),
      );
    }

    // Build / inject the GraphQL client.
    const graphqlClient = await this.resolveGraphqlClient(deps, ctx.saleorApiUrl);

    if (graphqlClient.isErr()) {
      return err(graphqlClient.error);
    }

    const mintFn = deps.mintOrderFromInvoice ?? defaultMintOrderFromInvoice;

    const mintResult = await mintFn({
      invoice,
      subscriptionRecord,
      saleorChannelSlug: subscriptionRecord.saleorChannelSlug,
      saleorVariantId: mapping.saleorVariantId,
      graphqlClient: graphqlClient.value,
    });

    if (mintResult.isErr()) {
      logger.error("mintOrderFromInvoice failed", {
        stripeInvoiceId,
        subscriptionId,
        error: mintResult.error,
      });

      return err(
        new MintFailedError(`Failed to mint Saleor order for invoice ${stripeInvoiceId}`, {
          cause: mintResult.error,
        }),
      );
    }

    const minted = mintResult.value;

    /*
     * Step 7: persist the new lastInvoiceId / lastSaleorOrderId to the
     * DynamoDB cache so the next webhook delivery for the same invoice
     * short-circuits via the idempotency check above.
     */
    const updatedRecord = new SubscriptionRecord({
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      stripeCustomerId: subscriptionRecord.stripeCustomerId,
      saleorChannelSlug: subscriptionRecord.saleorChannelSlug,
      saleorUserId: subscriptionRecord.saleorUserId,
      fiefUserId: subscriptionRecord.fiefUserId,
      saleorEntityId: subscriptionRecord.saleorEntityId,
      stripePriceId: subscriptionRecord.stripePriceId,
      status: subscriptionRecord.status,
      currentPeriodStart: subscriptionRecord.currentPeriodStart,
      currentPeriodEnd: subscriptionRecord.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptionRecord.cancelAtPeriodEnd,
      lastInvoiceId: stripeInvoiceId,
      lastSaleorOrderId: minted.saleorOrderId,
      planName: subscriptionRecord.planName,
      createdAt: subscriptionRecord.createdAt,
      updatedAt: new Date(),
    });

    const upsertResult = await deps.subscriptionRepo.upsert(repoAccess, updatedRecord);

    if (upsertResult.isErr()) {
      /*
       * The Saleor order has already been created; failing here would cause
       * a re-mint on the next delivery (the idempotency check would miss).
       * T31's Postgres `@unique` is the second line of defense — log loud
       * and bubble the error so on-call sees it; T31 hardening will tighten
       * the race further.
       */
      logger.error("Failed to persist lastInvoiceId/lastSaleorOrderId after successful mint", {
        stripeInvoiceId,
        saleorOrderId: minted.saleorOrderId,
        error: upsertResult.error,
      });

      return err(
        new SubscriptionRepoFailedError(
          `Minted Saleor order ${minted.saleorOrderId} but failed to update cache for invoice ${stripeInvoiceId}`,
          { cause: upsertResult.error },
        ),
      );
    }

    /*
     * Notify OwlBooks. Notifier failures are logged but do not fail the
     * handler — Stripe should not retry the entire webhook just because
     * OwlBooks is down. T28's receiver re-derives state on the next event
     * anyway, and T34/T32 will add OwlBooks-side reconciliation.
     */
    const taxCents = sumTaxCents(invoice);
    const payload: OwlBooksWebhookPayload = {
      type: "invoice.paid",
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      stripeCustomerId: subscriptionRecord.stripeCustomerId,
      fiefUserId: subscriptionRecord.fiefUserId,
      saleorUserId: subscriptionRecord.saleorUserId || undefined,
      stripeEventCreatedAt: event.created,
      status: toOwlBooksStatus(subscriptionRecord.status),
      stripePriceId: subscriptionRecord.stripePriceId,
      currentPeriodStart: isoOrUndefined(subscriptionRecord.currentPeriodStart),
      currentPeriodEnd: isoOrUndefined(subscriptionRecord.currentPeriodEnd),
      cancelAtPeriodEnd: subscriptionRecord.cancelAtPeriodEnd,
      lastInvoiceId: stripeInvoiceId,
      lastSaleorOrderId: minted.saleorOrderId,
      saleorChannelSlug: subscriptionRecord.saleorChannelSlug,
      amountCents: invoice.amount_paid,
      taxCents,
      currency: invoice.currency,
      stripeChargeId: extractChargeId(invoice) ?? undefined,
    };

    const notifyResult = await deps.owlbooksWebhookNotifier.notify(payload);

    if (notifyResult.isErr()) {
      logger.warn(
        "OwlBooks notifier failed after successful Saleor mint — continuing (Stripe webhook returns 2xx)",
        {
          stripeInvoiceId,
          saleorOrderId: minted.saleorOrderId,
          error: notifyResult.error,
        },
      );
    }

    logger.info("invoice.paid handled — Saleor order minted + cache updated", {
      stripeInvoiceId,
      saleorOrderId: minted.saleorOrderId,
      amountCents: invoice.amount_paid,
      taxCents,
      currency: invoice.currency,
    });

    return ok({
      _tag: "InvoiceHandlerSuccess",
      stripeInvoiceId,
      mintedSaleorOrderId: minted.saleorOrderId,
    });
  }

  async handleFailed(
    event: Stripe.InvoicePaymentFailedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<InvoiceHandlerSuccess, InvoiceHandlerError>> {
    const deps = this.deps;

    if (!deps) {
      return err(
        new NotConfiguredError(
          "InvoiceHandler is not wired with deps; cannot handle invoice.payment_failed",
        ),
      );
    }

    const invoice = event.data.object;

    if (!invoice.id) {
      return err(
        new InvoiceMissingFieldError("invoice.id missing on invoice.payment_failed event"),
      );
    }

    const stripeInvoiceId = invoice.id;
    const subscriptionId = extractSubscriptionId(invoice);

    if (!subscriptionId) {
      logger.debug("invoice.payment_failed carried no subscription field — one-shot path, no-op", {
        stripeInvoiceId,
      });

      return ok({
        _tag: "InvoiceHandlerSuccess",
        stripeInvoiceId,
        mintedSaleorOrderId: null,
      });
    }

    const repoAccess = { saleorApiUrl: ctx.saleorApiUrl, appId: ctx.appId };

    const lookupResult = await deps.subscriptionRepo.getBySubscriptionId(
      repoAccess,
      createStripeSubscriptionId(subscriptionId),
    );

    if (lookupResult.isErr()) {
      return err(
        new SubscriptionRepoFailedError(
          `Failed to read subscription record for ${subscriptionId}`,
          { cause: lookupResult.error },
        ),
      );
    }

    const subscriptionRecord = lookupResult.value;

    if (!subscriptionRecord) {
      logger.warn(
        "No SubscriptionRecord found for invoice.payment_failed — returning Err to trigger Stripe retry",
        { stripeInvoiceId, subscriptionId },
      );

      return err(
        new SubscriptionRecordMissingError(
          `No cached SubscriptionRecord for stripeSubscriptionId=${subscriptionId} on invoice.payment_failed`,
        ),
      );
    }

    // Update local cache: status → past_due. Stripe handles smart-retry.
    const updatedRecord = new SubscriptionRecord({
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      stripeCustomerId: subscriptionRecord.stripeCustomerId,
      saleorChannelSlug: subscriptionRecord.saleorChannelSlug,
      saleorUserId: subscriptionRecord.saleorUserId,
      fiefUserId: subscriptionRecord.fiefUserId,
      saleorEntityId: subscriptionRecord.saleorEntityId,
      stripePriceId: subscriptionRecord.stripePriceId,
      status: "past_due" as SubscriptionStatus,
      currentPeriodStart: subscriptionRecord.currentPeriodStart,
      currentPeriodEnd: subscriptionRecord.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptionRecord.cancelAtPeriodEnd,
      lastInvoiceId: subscriptionRecord.lastInvoiceId,
      lastSaleorOrderId: subscriptionRecord.lastSaleorOrderId,
      planName: subscriptionRecord.planName,
      createdAt: subscriptionRecord.createdAt,
      updatedAt: new Date(),
    });

    const upsertResult = await deps.subscriptionRepo.upsert(repoAccess, updatedRecord);

    if (upsertResult.isErr()) {
      logger.error("Failed to update cache to PAST_DUE on invoice.payment_failed", {
        stripeInvoiceId,
        error: upsertResult.error,
      });

      return err(
        new SubscriptionRepoFailedError(
          `Failed to update SubscriptionRecord status=past_due for ${subscriptionId}`,
          { cause: upsertResult.error },
        ),
      );
    }

    const payload: OwlBooksWebhookPayload = {
      type: "invoice.payment_failed",
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      stripeCustomerId: subscriptionRecord.stripeCustomerId,
      fiefUserId: subscriptionRecord.fiefUserId,
      saleorUserId: subscriptionRecord.saleorUserId || undefined,
      stripeEventCreatedAt: event.created,
      status: "PAST_DUE",
      stripePriceId: subscriptionRecord.stripePriceId,
      currentPeriodStart: isoOrUndefined(subscriptionRecord.currentPeriodStart),
      currentPeriodEnd: isoOrUndefined(subscriptionRecord.currentPeriodEnd),
      cancelAtPeriodEnd: subscriptionRecord.cancelAtPeriodEnd,
    };

    const notifyResult = await deps.owlbooksWebhookNotifier.notify(payload);

    if (notifyResult.isErr()) {
      logger.warn(
        "OwlBooks notifier failed for invoice.payment_failed — cache update succeeded; continuing",
        { stripeInvoiceId, error: notifyResult.error },
      );
    }

    logger.info("invoice.payment_failed handled — status → PAST_DUE, no Saleor mint", {
      stripeInvoiceId,
      subscriptionId,
    });

    return ok({
      _tag: "InvoiceHandlerSuccess",
      stripeInvoiceId,
      mintedSaleorOrderId: null,
    });
  }

  /**
   * Resolve a Saleor GraphQL client for the invoking installation. In
   * production we look up `authData` via the APL by Saleor API URL; tests
   * inject `graphqlClientFactory` directly so APL can be a no-op stub.
   */
  private async resolveGraphqlClient(
    deps: InvoiceHandlerDeps,
    saleorApiUrl: SaleorApiUrl,
  ): Promise<Result<MintOrderFromInvoiceArgs["graphqlClient"], InvoiceHandlerError>> {
    const authData = await deps.apl.get(saleorApiUrl);

    if (!authData) {
      return err(
        new AuthDataMissingError(
          `APL returned no authData for ${saleorApiUrl}; installation may be broken`,
        ),
      );
    }

    const factory = deps.graphqlClientFactory ?? defaultGraphqlClientFactory;

    return ok(
      factory({
        saleorApiUrl: authData.saleorApiUrl,
        token: authData.token,
      }),
    );
  }
}

/**
 * Default factory — wraps `createInstrumentedGraphqlClient`. Hoisted so the
 * class doesn't need to import the symbol unless deps are used.
 */
const defaultGraphqlClientFactory: GraphqlClientFactory = (authData) =>
  createInstrumentedGraphqlClient({
    saleorApiUrl: authData.saleorApiUrl,
    token: authData.token,
  });

/**
 * Default mint function — re-exported so production wiring stays a one-liner.
 * Lazy-imported to avoid a circular import surface (saleor-bridge files
 * import from repositories/subscription-record which is also imported here).
 */
const defaultMintOrderFromInvoice: MintOrderFromInvoiceFn = async (args) => {
  const { mintOrderFromInvoice } = await import("../saleor-bridge/saleor-order-from-invoice");

  return mintOrderFromInvoice(args);
};
