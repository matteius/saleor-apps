/**
 * SubscriptionWebhookUseCase — central dispatcher for subscription /
 * invoice / refund Stripe events.
 *
 * Plan: PRD_OwlBooks_Subscription_Billing-plan.md §T12.
 *
 * ## Why dispatch on `event.type`?
 *
 * `StripeWebhookUseCase` (the existing one-shot dispatcher in
 * `app/api/webhooks/stripe/use-case.ts`) routes by `event.data.object.object`
 * because PaymentIntent events all share that field's value. Subscription
 * events do NOT — a single `Stripe.Subscription` object surfaces under
 * three event types (`customer.subscription.created|updated|deleted`),
 * `Stripe.Invoice` under five (`invoice.created|finalized|paid|payment_failed
 * |voided`), etc. Routing by `event.type` is the only correct dimension here.
 *
 * ## Wave 5 contract
 *
 * The handler classes injected here (T13/T14/T15/T16/T17) are STUBBED in
 * `customer-subscription-handler.ts`, `invoice-handler.ts`, and
 * `charge-refund-handler.ts` — each method body throws a "Implemented in T<n>"
 * error. T13–T17 replace those bodies in Wave 5; T12's dispatch surface stays
 * stable.
 *
 * ## OwlBooks notifier
 *
 * The {@link OwlBooksWebhookNotifier} interface is wired here so handlers
 * depend on the interface — not the concrete HTTP implementation. The default
 * impl lives in `notifiers/owlbooks-notifier.ts`.
 *
 * ## Idempotency / informational events
 *
 * `invoice.created` and `invoice.finalized` are no-ops at the OwlBooks layer:
 * we only mint Saleor orders on `invoice.paid`. They return `Ok(NoOpResponse)`
 * so Stripe sees `200` and doesn't retry.
 *
 * Unsupported event types ALSO return `Ok(NoOpResponse)` — Stripe's webhook
 * subscription model means we may receive types we didn't ask for during
 * Stripe API version drift; logging-and-200ing is the safe default.
 */
import { type APL } from "@saleor/app-sdk/APL";
import { ok, type Result } from "neverthrow";
import type Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type StripeEnv } from "@/modules/stripe/stripe-env";
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

import {
  type IStripeChargesApi,
  type IStripeChargesApiFactory,
  StripeChargesApiFactory,
} from "../api/stripe-charges-api";
import { type IStripeCustomerApi } from "../api/stripe-customer-api";
import { type IStripeSubscriptionsApi } from "../api/stripe-subscriptions-api";
import { type IStripeSubscriptionsApiFactory } from "../api/stripe-subscriptions-api-factory";
import { type OwlBooksWebhookNotifier } from "../notifiers/owlbooks-notifier";
import { type RefundDlqRepo } from "../repositories/refund-dlq-repo";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import { type IPriceVariantMapRepo } from "../saleor-bridge/price-variant-map";
import { type ISaleorCustomerResolver } from "../saleor-bridge/saleor-customer-resolver";
import {
  ChargeRefundHandler,
  type ChargeRefundHandlerError,
  type ChargeRefundHandlerSuccess,
  type IChargeRefundHandler,
  type ISaleorGraphqlClientFactory,
  type PassThroughToOneShotRefundHandlerResponse,
} from "./charge-refund-handler";
import {
  CustomerSubscriptionHandler,
  type CustomerSubscriptionHandlerError,
  type CustomerSubscriptionHandlerSuccess,
  type ICustomerSubscriptionHandler,
} from "./customer-subscription-handler";
import {
  type IInvoiceHandler,
  InvoiceHandler,
  type InvoiceHandlerError,
  type InvoiceHandlerSuccess,
} from "./invoice-handler";

/*
 * ---------------------------------------------------------------------------
 * Public types — context passed to every handler & success/error union
 * ---------------------------------------------------------------------------
 */

/**
 * Per-event dispatch context. Mirrors the parameters
 * `StripeWebhookUseCase.processEvent` derives from APL + AppConfigRepo so that
 * subscription handlers don't have to re-resolve them.
 */
export interface SubscriptionWebhookContext {
  saleorApiUrl: SaleorApiUrl;
  appId: string;
  stripeEnv: StripeEnv;
  restrictedKey: StripeRestrictedKey;
}

/**
 * Marker response used for handler-less events (informational invoice events
 * or unsupported event types). Returns to the caller as `Ok` so Stripe
 * receives a 2xx and does not retry.
 */
export class SubscriptionWebhookNoOpResponse {
  readonly _tag = "SubscriptionWebhookNoOpResponse" as const;
  readonly handledEventType: Stripe.Event["type"];
  readonly reason: "informational" | "unsupported";

  constructor(args: {
    handledEventType: Stripe.Event["type"];
    reason: "informational" | "unsupported";
  }) {
    this.handledEventType = args.handledEventType;
    this.reason = args.reason;
  }
}

export type SubscriptionWebhookExecuteSuccess =
  | CustomerSubscriptionHandlerSuccess
  | InvoiceHandlerSuccess
  | ChargeRefundHandlerSuccess
  | PassThroughToOneShotRefundHandlerResponse
  | SubscriptionWebhookNoOpResponse;

export type SubscriptionWebhookExecuteError =
  | CustomerSubscriptionHandlerError
  | InvoiceHandlerError
  | ChargeRefundHandlerError;

/*
 * ---------------------------------------------------------------------------
 * Use-case
 * ---------------------------------------------------------------------------
 */

export interface SubscriptionWebhookUseCaseDeps {
  apl: APL;
  appConfigRepo: AppConfigRepo;
  subscriptionRepo: SubscriptionRepo;
  priceVariantMapRepo: IPriceVariantMapRepo;
  customerResolver: ISaleorCustomerResolver;
  stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  /**
   * Convenience aliases so handler tasks (T13–T17) can pull a per-installation
   * Stripe Subscriptions / Customer client via `restrictedKey` from `ctx`.
   * The default factory implements both via the same class — these are
   * separate fields on the deps for forward-compat with the spec, but the
   * runtime instances are interchangeable.
   */
  stripeCustomerApiFactory?: {
    createCustomerApi(args: { key: StripeRestrictedKey }): IStripeCustomerApi;
  };
  /**
   * Factory for the per-installation Stripe Charges API client (T17). Only
   * used by `ChargeRefundHandler` to expand `charge.invoice` on the hot path.
   * Defaults to {@link StripeChargesApiFactory} when omitted.
   */
  stripeChargesApiFactory?: IStripeChargesApiFactory;
  /**
   * Operational queues for refund handling (T17). Required only if the
   * default `ChargeRefundHandler` is used; if a test injects a mock
   * `chargeRefundHandler`, this can be omitted.
   */
  refundDlqRepo?: RefundDlqRepo;
  /**
   * Saleor GraphQL client factory used by `ChargeRefundHandler.handleFullRefund`
   * to call `orderVoid`. Required for the production wiring; tests typically
   * inject a mock `chargeRefundHandler` instead.
   */
  saleorGraphqlClientFactory?: ISaleorGraphqlClientFactory;
  owlbooksWebhookNotifier: OwlBooksWebhookNotifier;
  /**
   * Optional handler overrides — primarily for unit tests. Production callers
   * leave them undefined and the use-case constructs default
   * (Wave-5-stubbed) instances.
   */
  customerSubscriptionHandler?: ICustomerSubscriptionHandler;
  invoiceHandler?: IInvoiceHandler;
  chargeRefundHandler?: IChargeRefundHandler;
}

const _SUBSCRIPTION_EVENT_TYPES = new Set<Stripe.Event["type"]>([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
]);

/**
 * Returns true when this event type is one that this dispatcher claims —
 * useful for the routing decision in T18 when wiring into the existing
 * dispatcher.
 */
export function isSubscriptionWebhookEventType(eventType: Stripe.Event["type"]): boolean {
  return _SUBSCRIPTION_EVENT_TYPES.has(eventType);
}

/**
 * Hidden re-implementation of {@link IStripeSubscriptionsApi} usage —
 * referenced solely so the type import survives `noUnusedLocals` until T13–T17
 * actually consume it through the factory.
 */
type _UnusedSubsApiTypeReference = IStripeSubscriptionsApi;

export class SubscriptionWebhookUseCase {
  private readonly deps: SubscriptionWebhookUseCaseDeps;
  private readonly customerSubscriptionHandler: ICustomerSubscriptionHandler;
  private readonly invoiceHandler: IInvoiceHandler;
  /**
   * `chargeRefundHandler` may be undefined when no test override is supplied
   * — in that case we lazily build it per `execute` call from
   * `ctx.restrictedKey` (T17), since the underlying Stripe Charges API is
   * scoped to a per-installation restricted key.
   */
  private readonly explicitChargeRefundHandler: IChargeRefundHandler | undefined;
  private readonly stripeChargesApiFactory: IStripeChargesApiFactory;
  private readonly logger = createLogger("SubscriptionWebhookUseCase");

  constructor(deps: SubscriptionWebhookUseCaseDeps) {
    this.deps = deps;
    this.customerSubscriptionHandler =
      deps.customerSubscriptionHandler ?? new CustomerSubscriptionHandler();
    this.invoiceHandler = deps.invoiceHandler ?? new InvoiceHandler();
    this.explicitChargeRefundHandler = deps.chargeRefundHandler;
    this.stripeChargesApiFactory = deps.stripeChargesApiFactory ?? new StripeChargesApiFactory();
  }

  /**
   * Build a default {@link ChargeRefundHandler} for the current installation.
   * The Stripe Charges API client is keyed by `ctx.restrictedKey`, so we
   * construct it per-call rather than at use-case construction time.
   *
   * Throws (caller surfaces as Err) if the production wiring is missing
   * `refundDlqRepo` or `saleorGraphqlClientFactory`.
   */
  private getChargeRefundHandler(ctx: SubscriptionWebhookContext): IChargeRefundHandler {
    if (this.explicitChargeRefundHandler) {
      return this.explicitChargeRefundHandler;
    }

    if (!this.deps.refundDlqRepo || !this.deps.saleorGraphqlClientFactory) {
      throw new BaseError(
        "Default ChargeRefundHandler requires `refundDlqRepo` and `saleorGraphqlClientFactory` deps; provide them or inject `chargeRefundHandler`.",
      );
    }

    const chargesApi: IStripeChargesApi = this.stripeChargesApiFactory.createChargesApi({
      key: ctx.restrictedKey,
    });

    return new ChargeRefundHandler({
      stripeChargesApi: chargesApi,
      subscriptionRepo: this.deps.subscriptionRepo,
      refundDlqRepo: this.deps.refundDlqRepo,
      notifier: this.deps.owlbooksWebhookNotifier,
      graphqlClientFactory: this.deps.saleorGraphqlClientFactory,
    });
  }

  /**
   * Reference deps so the field stays live for handler tasks (T13–T17) that
   * will read from it in their own implementations. Returning `void` keeps
   * `noUnusedLocals` quiet without leaking the deps shape.
   */

  private _materializeDeps(): SubscriptionWebhookUseCaseDeps {
    return this.deps;
  }

  async execute(
    event: Stripe.Event,
    ctx: SubscriptionWebhookContext,
  ): Promise<Result<SubscriptionWebhookExecuteSuccess, SubscriptionWebhookExecuteError>> {
    void this._materializeDeps();

    this.logger.debug(`Dispatching subscription webhook for type=${event.type}`);

    switch (event.type) {
      case "customer.subscription.created":
        return this.customerSubscriptionHandler.handleCreated(
          event as Stripe.CustomerSubscriptionCreatedEvent,
          ctx,
        );

      case "customer.subscription.updated":
        return this.customerSubscriptionHandler.handleUpdated(
          event as Stripe.CustomerSubscriptionUpdatedEvent,
          ctx,
        );

      case "customer.subscription.deleted":
        return this.customerSubscriptionHandler.handleDeleted(
          event as Stripe.CustomerSubscriptionDeletedEvent,
          ctx,
        );

      case "invoice.paid":
        return this.invoiceHandler.handlePaid(event as Stripe.InvoicePaidEvent, ctx);

      case "invoice.payment_failed":
        return this.invoiceHandler.handleFailed(event as Stripe.InvoicePaymentFailedEvent, ctx);

      case "charge.refunded":
        return this.getChargeRefundHandler(ctx).handle(event as Stripe.ChargeRefundedEvent, ctx);

      /*
       * Informational invoice events — Stripe Tax / Stripe Billing emit these
       * before the corresponding `invoice.paid`. We don't act on them.
       */
      case "invoice.created":
      case "invoice.finalized":
        this.logger.debug(`No-op for informational invoice event ${event.type}`);

        return ok(
          new SubscriptionWebhookNoOpResponse({
            handledEventType: event.type,
            reason: "informational",
          }),
        );

      default:
        this.logger.warn(`Unsupported subscription webhook event type: ${event.type}`);

        return ok(
          new SubscriptionWebhookNoOpResponse({
            handledEventType: event.type,
            reason: "unsupported",
          }),
        );
    }
  }
}

/**
 * Re-export so consumers can switch on the typed error union.
 */
export { BaseError as SubscriptionWebhookBaseError };
