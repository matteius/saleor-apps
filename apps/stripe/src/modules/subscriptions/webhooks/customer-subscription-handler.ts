/**
 * Handler for `customer.subscription.{created,updated,deleted}` events.
 *
 * - `customer.subscription.created` (T13): upsert DynamoDB cache, notify
 *   OwlBooks, do NOT mint a Saleor order (waits for `invoice.paid`).
 * - `customer.subscription.updated` (T15): update status / period dates /
 *   price / `cancel_at_period_end`.
 * - `customer.subscription.deleted` (T15): set local OwlBooks status to
 *   `CANCELLED`, preserve `currentPeriodEnd` so `paidThrough` stays in the
 *   future and the user retains access through end of paid period (per
 *   PRD §10).
 *
 * The dispatcher (T12 — `SubscriptionWebhookUseCase`) routes the three
 * Stripe event types here. Returns `Result<…, BaseError>`:
 *   - `Ok(NoOp)` when subscription metadata is missing `fiefUserId` (the
 *     subscription wasn't created by us — likely a Stripe Dashboard edit).
 *   - `Err(…)` when the OwlBooks notifier or DynamoDB upsert fails. Stripe
 *     will retry; T28 dedupes via `lastStripeEventAt` and the
 *     `SaleorOrderImport.stripeInvoiceId` unique constraint.
 *
 * ## Status mapping
 *
 * The `mapStripeSubStatus` helper translates Stripe's snake-case
 * `Subscription.Status` into OwlBooks' `OwlBooksSubscriptionStatus` enum
 * (the receiver in T28 expects the SCREAMING_SNAKE form). Centralized so T15
 * shares the same table as T13.
 *
 * ## Production enum gap
 *
 * The four new `SubscriptionStatus` enum values (`PAST_DUE`, `INCOMPLETE`,
 * `INCOMPLETE_EXPIRED`, `UNPAID`) are NOT yet applied to the production
 * Postgres database — `ALTER TYPE` is gated by accounting-db MCP and must
 * be applied manually via the Postgres CLI before E2E (see plan §T6 log). Handlers
 * still emit the correct status; runtime gating is handled outside this
 * file.
 */
import { err, ok, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import {
  type OwlBooksSubscriptionStatus,
  type OwlBooksWebhookEventType,
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "../notifiers/owlbooks-notifier";
import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  type FiefUserId,
  type SaleorChannelSlug,
  type StripeCustomerId,
  type StripePriceId,
  type StripeSubscriptionId,
  SubscriptionRecord,
  type SubscriptionStatus,
} from "../repositories/subscription-record";
import {
  type SubscriptionRepo,
  type SubscriptionRepoAccess,
} from "../repositories/subscription-repo";
import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

const logger = createLogger("CustomerSubscriptionHandler");

/*
 * ---------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------
 */

export interface CustomerSubscriptionHandlerSuccess {
  readonly _tag: "CustomerSubscriptionHandlerSuccess";
  readonly stripeSubscriptionId: string;
}

export type CustomerSubscriptionHandlerError = InstanceType<typeof BaseError>;

export interface ICustomerSubscriptionHandler {
  handleCreated(
    event: Stripe.CustomerSubscriptionCreatedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>>;

  handleUpdated(
    event: Stripe.CustomerSubscriptionUpdatedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>>;

  handleDeleted(
    event: Stripe.CustomerSubscriptionDeletedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>>;
}

export interface CustomerSubscriptionHandlerDeps {
  subscriptionRepo: SubscriptionRepo;
  notifier: OwlBooksWebhookNotifier;
}

/*
 * ---------------------------------------------------------------------------
 * Status mapping (Stripe → OwlBooks enum)
 * ---------------------------------------------------------------------------
 */

/**
 * Map Stripe's `Subscription.Status` to the OwlBooks-side
 * `OwlBooksSubscriptionStatus` enum. Centralized so T13 (`created`) and T15
 * (`updated`/`deleted`) emit identical values.
 *
 * Stripe `paused` (added by Stripe but not in the OwlBooks v1 spec) maps to
 * `SUSPENDED` defensively — closest semantic neighbor. Any future Stripe
 * status added by Stripe will fall through `assertNever` and surface in the
 * dispatcher as a 500 (we'd rather know than silently misclassify).
 */
export function mapStripeSubStatus(
  stripeStatus: Stripe.Subscription.Status,
): OwlBooksSubscriptionStatus {
  switch (stripeStatus) {
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
    case "trialing":
      return "PENDING";
    case "active":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELLED";
    case "unpaid":
      return "UNPAID";
    case "paused":
      return "SUSPENDED";
    default: {
      const _exhaustive: never = stripeStatus;

      throw new BaseError(
        `mapStripeSubStatus: unhandled Stripe Subscription.Status ${String(_exhaustive)}`,
      );
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Parser — extract the fields we care about from a Stripe.Subscription
 * ---------------------------------------------------------------------------
 */

interface ParsedSubscription {
  stripeSubscriptionId: StripeSubscriptionId;
  stripeCustomerId: StripeCustomerId;
  stripePriceId: StripePriceId;
  fiefUserId: FiefUserId;
  saleorUserId: string;
  saleorChannelSlug: SaleorChannelSlug;
  status: SubscriptionStatus;
  owlbooksStatus: OwlBooksSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

type ParseFailure = { reason: "missing_fief_user_id" } | { reason: "malformed"; cause: unknown };

/**
 * Pull the Stripe subscription's relevant fields into a typed shape. Returns
 * the discriminated `ParseFailure` instead of throwing so the handler can
 * cleanly distinguish "we don't own this sub" (missing fiefUserId) from
 * "Stripe sent us garbage" (malformed/unbranded inputs).
 */
function parseSubscription(
  subscription: Stripe.Subscription,
): { ok: true; value: ParsedSubscription } | { ok: false; failure: ParseFailure } {
  try {
    const metadata = (subscription.metadata ?? {}) as Record<string, string | undefined>;
    const fiefUserIdRaw = metadata.fiefUserId;

    if (!fiefUserIdRaw || fiefUserIdRaw.length === 0) {
      return { ok: false, failure: { reason: "missing_fief_user_id" } };
    }

    const customerRaw =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

    /*
     * In Stripe API v2025+ (SDK 18.x), `current_period_*` moved from the
     * Subscription onto each SubscriptionItem. We always read from the first
     * item — OwlBooks v1 issues exactly one item per subscription.
     */
    const firstItem = subscription.items?.data?.[0];

    if (!firstItem) {
      return {
        ok: false,
        failure: {
          reason: "malformed",
          cause: new BaseError("subscription.items.data is empty"),
        },
      };
    }

    const priceId = typeof firstItem.price === "string" ? firstItem.price : firstItem.price.id;

    /*
     * `current_period_start/end` are unix-epoch seconds. Multiply by 1_000
     * for `Date`.
     */
    const periodStartUnix = (
      firstItem as unknown as {
        current_period_start: number;
      }
    ).current_period_start;
    const periodEndUnix = (
      firstItem as unknown as {
        current_period_end: number;
      }
    ).current_period_end;

    const saleorUserId = metadata.saleorUserId ?? "";
    const saleorChannelSlugRaw = metadata.saleorChannelSlug ?? "";

    if (saleorChannelSlugRaw.length === 0) {
      return {
        ok: false,
        failure: {
          reason: "malformed",
          cause: new BaseError(
            "subscription.metadata.saleorChannelSlug is required for OwlBooks subscriptions",
          ),
        },
      };
    }

    const owlbooksStatus = mapStripeSubStatus(subscription.status);

    return {
      ok: true,
      value: {
        stripeSubscriptionId: createStripeSubscriptionId(subscription.id),
        stripeCustomerId: createStripeCustomerId(customerRaw),
        stripePriceId: createStripePriceId(priceId),
        fiefUserId: createFiefUserId(fiefUserIdRaw),
        saleorUserId,
        saleorChannelSlug: createSaleorChannelSlug(saleorChannelSlugRaw),
        status: subscription.status,
        owlbooksStatus,
        currentPeriodStart: new Date(periodStartUnix * 1000),
        currentPeriodEnd: new Date(periodEndUnix * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      },
    };
  } catch (cause) {
    return { ok: false, failure: { reason: "malformed", cause } };
  }
}

/*
 * ---------------------------------------------------------------------------
 * Record + payload assembly helpers
 * ---------------------------------------------------------------------------
 */

function buildRecord(
  parsed: ParsedSubscription,
  existing: SubscriptionRecord | null,
): SubscriptionRecord {
  const now = new Date();

  return new SubscriptionRecord({
    stripeSubscriptionId: parsed.stripeSubscriptionId,
    stripeCustomerId: parsed.stripeCustomerId,
    saleorChannelSlug: parsed.saleorChannelSlug,
    saleorUserId: parsed.saleorUserId,
    fiefUserId: parsed.fiefUserId,
    saleorEntityId: existing?.saleorEntityId ?? null,
    stripePriceId: parsed.stripePriceId,
    status: parsed.status,
    currentPeriodStart: parsed.currentPeriodStart,
    currentPeriodEnd: parsed.currentPeriodEnd,
    cancelAtPeriodEnd: parsed.cancelAtPeriodEnd,
    lastInvoiceId: existing?.lastInvoiceId ?? null,
    lastSaleorOrderId: existing?.lastSaleorOrderId ?? null,
    /*
     * Preserve any planName cached by T20 (`create`) — T15 doesn't fetch
     * Stripe Product names on every webhook (it would double the call rate).
     * If the price changed, T15's caller is responsible for refreshing
     * planName via a follow-up upsert; for now the stale label is acceptable
     * and the storefront has a Stripe-side source of truth for the price id.
     */
    planName: existing?.planName ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

function buildPayload(args: {
  type: OwlBooksWebhookEventType;
  parsed: ParsedSubscription;
  eventCreatedAt: number;
  /** Override the OwlBooks status — used by `subscription.deleted` to force `CANCELLED`. */
  statusOverride?: OwlBooksSubscriptionStatus;
}): OwlBooksWebhookPayload {
  const { parsed } = args;

  return {
    type: args.type,
    stripeSubscriptionId: parsed.stripeSubscriptionId,
    stripeCustomerId: parsed.stripeCustomerId,
    fiefUserId: parsed.fiefUserId,
    saleorUserId: parsed.saleorUserId.length > 0 ? parsed.saleorUserId : undefined,
    stripeEventCreatedAt: args.eventCreatedAt,
    status: args.statusOverride ?? parsed.owlbooksStatus,
    stripePriceId: parsed.stripePriceId,
    currentPeriodStart: parsed.currentPeriodStart.toISOString(),
    currentPeriodEnd: parsed.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: parsed.cancelAtPeriodEnd,
    saleorChannelSlug: parsed.saleorChannelSlug,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Handler class
 * ---------------------------------------------------------------------------
 */

export class CustomerSubscriptionHandler implements ICustomerSubscriptionHandler {
  private readonly subscriptionRepo: SubscriptionRepo | undefined;
  private readonly notifier: OwlBooksWebhookNotifier | undefined;

  constructor(deps?: CustomerSubscriptionHandlerDeps) {
    this.subscriptionRepo = deps?.subscriptionRepo;
    this.notifier = deps?.notifier;
  }

  async handleCreated(
    event: Stripe.CustomerSubscriptionCreatedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    return this.process({
      event,
      ctx,
      type: "subscription.created",
      lookupExisting: true,
    });
  }

  async handleUpdated(
    event: Stripe.CustomerSubscriptionUpdatedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    return this.process({
      event,
      ctx,
      type: "subscription.updated",
      lookupExisting: true,
    });
  }

  async handleDeleted(
    event: Stripe.CustomerSubscriptionDeletedEvent,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    return this.process({
      event,
      ctx,
      type: "subscription.deleted",
      lookupExisting: true,
      /*
       * Force-emit CANCELLED to OwlBooks regardless of Stripe's status —
       * Stripe sometimes sends `customer.subscription.deleted` with the
       * pre-deletion status string still attached to the snapshot.
       */
      statusOverride: "CANCELLED",
    });
  }

  /**
   * Shared pipeline for all three event types.
   */
  private async process(args: {
    event:
      | Stripe.CustomerSubscriptionCreatedEvent
      | Stripe.CustomerSubscriptionUpdatedEvent
      | Stripe.CustomerSubscriptionDeletedEvent;
    ctx: SubscriptionWebhookContext;
    type: OwlBooksWebhookEventType;
    lookupExisting: boolean;
    statusOverride?: OwlBooksSubscriptionStatus;
  }): Promise<Result<CustomerSubscriptionHandlerSuccess, CustomerSubscriptionHandlerError>> {
    const { event, ctx, type } = args;
    const subscription = event.data.object;

    const parseResult = parseSubscription(subscription);

    if (!parseResult.ok) {
      if (parseResult.failure.reason === "missing_fief_user_id") {
        logger.warn(
          `Skipping ${event.type} for sub ${subscription.id} — metadata.fiefUserId missing (likely manual Stripe Dashboard edit)`,
        );

        return ok({
          _tag: "CustomerSubscriptionHandlerSuccess",
          stripeSubscriptionId: subscription.id,
        });
      }

      logger.error(`Malformed Stripe subscription on ${event.type}`, {
        cause: parseResult.failure.cause,
        stripeSubscriptionId: subscription.id,
      });

      return err(
        new BaseError(`Malformed Stripe subscription on ${event.type} for sub ${subscription.id}`, {
          cause: parseResult.failure.cause,
        }),
      );
    }

    const parsed = parseResult.value;

    const access: SubscriptionRepoAccess = {
      saleorApiUrl: ctx.saleorApiUrl,
      appId: ctx.appId,
    };

    if (!this.subscriptionRepo) {
      return err(
        new BaseError("CustomerSubscriptionHandler is missing a `subscriptionRepo` dependency"),
      );
    }
    if (!this.notifier) {
      return err(new BaseError("CustomerSubscriptionHandler is missing an `notifier` dependency"));
    }

    let existing: SubscriptionRecord | null = null;

    if (args.lookupExisting) {
      const lookup = await this.subscriptionRepo.getByCustomerId(access, parsed.stripeCustomerId);

      if (lookup.isErr()) {
        return err(
          new BaseError("Failed to look up subscription cache by customer id", {
            cause: lookup.error,
          }),
        );
      }
      existing = lookup.value;
    }

    const record = buildRecord(parsed, existing);

    const upsertResult = await this.subscriptionRepo.upsert(access, record);

    if (upsertResult.isErr()) {
      return err(
        new BaseError("Failed to upsert subscription cache record", {
          cause: upsertResult.error,
        }),
      );
    }

    const payload = buildPayload({
      type,
      parsed,
      eventCreatedAt: event.created,
      statusOverride: args.statusOverride,
    });

    const notifyResult = await this.notifier.notify(payload);

    if (notifyResult.isErr()) {
      return err(
        new BaseError(
          `Failed to notify OwlBooks for ${event.type} sub ${subscription.id} — Stripe will retry`,
          { cause: notifyResult.error },
        ),
      );
    }

    return ok({
      _tag: "CustomerSubscriptionHandlerSuccess",
      stripeSubscriptionId: subscription.id,
    });
  }
}
