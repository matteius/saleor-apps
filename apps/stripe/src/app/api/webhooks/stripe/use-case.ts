import { type APL, type AuthData } from "@saleor/app-sdk/APL";
import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { captureException } from "@sentry/nextjs";
import { err, ok, type Result } from "neverthrow";
import { after } from "next/server";
import type Stripe from "stripe";

import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loggerContext } from "@/lib/logger-context";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { type StripeProblemReporter } from "@/modules/app-problems";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  type ITransactionEventReporter,
  TransactionEventReporterErrors,
} from "@/modules/saleor/transaction-event-reporter";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { type StripeEnv } from "@/modules/stripe/stripe-env";
import { type StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";
import { type StripeWebhookManager } from "@/modules/stripe/stripe-webhook-manager";
import {
  type AllowedStripeObjectMetadata,
  type IStripeEventVerify,
  type IStripePaymentIntentsApiFactory,
} from "@/modules/stripe/types";
import {
  type SubscriptionWebhookExecuteError,
  type SubscriptionWebhookExecuteSuccess,
} from "@/modules/subscriptions/webhooks/subscription-webhook-use-case";
import {
  TransactionRecorderError,
  type TransactionRecorderRepo,
} from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { StripePaymentIntentHandler } from "./stripe-object-handlers/stripe-payment-intent-handler";
import { StripeRefundHandler } from "./stripe-object-handlers/stripe-refund-handler";
import {
  ObjectCreatedOutsideOfSaleorResponse,
  type PossibleStripeWebhookErrorResponses,
  type PossibleStripeWebhookSuccessResponses,
  StripeWebhookAppIsNotConfiguredResponse,
  StripeWebhookMalformedRequestResponse,
  StripeWebhookSeverErrorResponse,
  StripeWebhookSuccessResponse,
  StripeWebhookTransactionMissingResponse,
} from "./stripe-webhook-responses";
import { type WebhookParams } from "./webhook-params";

type R = Promise<
  Result<PossibleStripeWebhookSuccessResponses, PossibleStripeWebhookErrorResponses>
>;

type StripeVerifyEventFactory = (stripeClient: StripeClient) => IStripeEventVerify;
type SaleorTransactionEventReporterFactory = (authData: AuthData) => ITransactionEventReporter;
type ProblemReporterFactory = (authData: AuthData) => StripeProblemReporter;

const ObjectMetadataMissingError = BaseError.subclass("ObjectMetadataMissingError");

/**
 * T18 — minimal contract for the subscription dispatcher consumed by
 * `StripeWebhookUseCase`. The real `SubscriptionWebhookUseCase` satisfies
 * this structurally; we accept the structural type so unit tests can supply
 * a tiny mock without instantiating the whole class.
 */
export interface ISubscriptionWebhookUseCase {
  execute(
    event: Stripe.Event,
    ctx: {
      saleorApiUrl: SaleorApiUrl;
      appId: string;
      stripeEnv: StripeEnv;
      restrictedKey: StripeRestrictedKey;
    },
  ): Promise<Result<SubscriptionWebhookExecuteSuccess, SubscriptionWebhookExecuteError>>;
}

/**
 * T18 — sentinel returned from `processEvent` when the subscription dispatcher
 * handled the event. `execute()` short-circuits on this so that the existing
 * one-shot success-path (`reportTransactionEvent` etc.) is skipped.
 */
const SUBSCRIPTION_HANDLED_TAG = "SubscriptionHandledByDispatcher" as const;

interface SubscriptionDispatchedSuccess {
  readonly _tag: typeof SUBSCRIPTION_HANDLED_TAG;
  readonly response: PossibleStripeWebhookSuccessResponses;
}

interface SubscriptionDispatchedError {
  readonly _tag: typeof SUBSCRIPTION_HANDLED_TAG;
  readonly response: PossibleStripeWebhookErrorResponses;
}

export class StripeWebhookUseCase {
  private appConfigRepo: AppConfigRepo;
  private webhookEventVerifyFactory: StripeVerifyEventFactory;
  private apl: APL;
  private logger = createLogger("StripeWebhookUseCase");
  private transactionRecorder: TransactionRecorderRepo;
  private transactionEventReporterFactory: SaleorTransactionEventReporterFactory;
  private problemReporterFactory: ProblemReporterFactory;
  private webhookManager: StripeWebhookManager;
  private stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
  /**
   * T18 — optional dispatcher for subscription / invoice / charge.refunded
   * events. When provided, `processEvent` delegates to it for events that
   * originate from Stripe Billing rather than the existing one-shot Saleor
   * checkout flow.
   *
   * Optional so legacy unit tests / callers that don't care about
   * subscriptions can construct the use-case without wiring all the
   * subscription deps. When undefined, subscription-shaped events are treated
   * as "not from Saleor" (mirrors metadata-missing one-shot behavior →
   * `ObjectCreatedOutsideOfSaleorResponse` 400).
   */
  private subscriptionWebhookUseCase: ISubscriptionWebhookUseCase | undefined;

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    webhookEventVerifyFactory: StripeVerifyEventFactory;
    apl: APL;
    transactionRecorder: TransactionRecorderRepo;
    transactionEventReporterFactory: SaleorTransactionEventReporterFactory;
    problemReporterFactory: ProblemReporterFactory;
    webhookManager: StripeWebhookManager;
    stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
    subscriptionWebhookUseCase?: ISubscriptionWebhookUseCase;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.webhookEventVerifyFactory = deps.webhookEventVerifyFactory;
    this.apl = deps.apl;
    this.transactionRecorder = deps.transactionRecorder;
    this.transactionEventReporterFactory = deps.transactionEventReporterFactory;
    this.problemReporterFactory = deps.problemReporterFactory;
    this.webhookManager = deps.webhookManager;
    this.stripePaymentIntentsApiFactory = deps.stripePaymentIntentsApiFactory;
    this.subscriptionWebhookUseCase = deps.subscriptionWebhookUseCase;
  }

  /**
   * T18 — delegate the event to the subscription dispatcher, then translate
   * its Result into the response shape the outer dispatcher uses.
   *
   * Failures from a wired dispatcher are surfaced as a generic 500
   * server-error response so Stripe retries — handlers that want a different
   * policy should return Ok with a NoOp response.
   *
   * When no dispatcher is wired, returns an `ObjectMetadataMissingError`
   * which `execute()` translates to a 400
   * `ObjectCreatedOutsideOfSaleorResponse` (back-compat with the legacy
   * pre-T18 behavior for non-Saleor events).
   */
  private async dispatchToSubscriptionUseCase(args: {
    event: Stripe.Event;
    ctx: {
      saleorApiUrl: SaleorApiUrl;
      appId: string;
      stripeEnv: StripeEnv;
      restrictedKey: StripeRestrictedKey;
    };
  }): Promise<
    Result<
      SubscriptionDispatchedSuccess,
      SubscriptionDispatchedError | InstanceType<typeof ObjectMetadataMissingError>
    >
  > {
    if (!this.subscriptionWebhookUseCase) {
      this.logger.warn(
        `Received subscription-shaped event ${args.event.type} but no SubscriptionWebhookUseCase is wired; treating as not-from-Saleor.`,
      );

      return err(
        new ObjectMetadataMissingError(
          `No SubscriptionWebhookUseCase wired for event ${args.event.type}; treating as not-from-Saleor`,
          { props: { eventType: args.event.type } },
        ),
      );
    }

    const result = await this.subscriptionWebhookUseCase.execute(args.event, args.ctx);

    if (result.isErr()) {
      this.logger.warn("Subscription dispatcher returned Err", { error: result.error });

      return err({
        _tag: SUBSCRIPTION_HANDLED_TAG,
        response: new StripeWebhookSeverErrorResponse(),
      });
    }

    return ok({
      _tag: SUBSCRIPTION_HANDLED_TAG,
      response: new StripeWebhookSuccessResponse(),
    });
  }

  private async removeStripeWebhook({
    webhookId,
    restrictedKey,
  }: {
    webhookId: string;
    restrictedKey: StripeRestrictedKey;
  }) {
    const result = await this.webhookManager.removeWebhook({ webhookId, restrictedKey });

    if (result.isErr()) {
      this.logger.warn(`Failed to remove webhook ${webhookId}`, result.error);

      return err(new BaseError("Failed to remove webhook", { cause: result.error }));
    }

    this.logger.info(`Webhook ${webhookId} removed successfully`);

    return ok(null);
  }

  private async processEvent({
    event,
    saleorApiUrl,
    appId,
    stripeEnv,
    restrictedKey,
  }: {
    event: Stripe.Event;
    saleorApiUrl: SaleorApiUrl;
    appId: string;
    stripeEnv: StripeEnv;
    restrictedKey: StripeRestrictedKey;
  }) {
    const subscriptionCtx = { saleorApiUrl, appId, stripeEnv, restrictedKey };

    switch (event.data.object.object) {
      case "payment_intent": {
        loggerContext.set(ObservabilityAttributes.PSP_REFERENCE, event.data.object.id);

        const meta = event.data.object.metadata as AllowedStripeObjectMetadata;
        /*
         * Stripe SDK 18 dropped the `invoice` field from the
         * `Stripe.PaymentIntent` type, but the live API still surfaces it on
         * subscription cycle-1 PaymentIntents. Cast to read it.
         */
        const pi = event.data.object as Stripe.PaymentIntent & {
          invoice?: string | Stripe.Invoice | null;
        };

        if (!meta?.saleor_transaction_id) {
          /*
           * T18 — subscription cycle-1 PI: created by `subscriptions.create`,
           * carries no Saleor metadata but always has an `invoice` field.
           * The corresponding `invoice.paid` event mints the Saleor order
           * — the PI events are redundant, so we no-op here.
           */
          if (pi.invoice) {
            this.logger.debug("Subscription cycle-1 PI received, deferring to invoice.paid", {
              paymentIntentId: pi.id,
              invoiceId: pi.invoice,
            });

            return ok({
              _tag: SUBSCRIPTION_HANDLED_TAG,
              response: new StripeWebhookSuccessResponse(),
            });
          }

          return err(
            new ObjectMetadataMissingError(
              "Missing metadata on object, it was not created by Saleor",
              {
                props: {
                  meta,
                },
              },
            ),
          );
        }

        if (meta.saleor_app_id && meta.saleor_app_id !== appId) {
          return err(
            new ObjectMetadataMissingError(
              "PaymentIntent belongs to a different Saleor installation",
              {
                props: {
                  meta,
                  expectedAppId: appId,
                },
              },
            ),
          );
        }

        const handler = new StripePaymentIntentHandler();

        const stripePaymentIntentsApi = this.stripePaymentIntentsApiFactory.create({
          key: restrictedKey,
        });

        return handler.processPaymentIntentEvent({
          event,
          stripeEnv,
          transactionRecorder: this.transactionRecorder,
          appId,
          saleorApiUrl,
          stripePaymentIntentsApi,
        });
      }

      case "refund": {
        loggerContext.set("stripeRefundId", event.data.object.id);

        const meta = event.data.object.metadata as AllowedStripeObjectMetadata;

        if (!meta?.saleor_transaction_id) {
          /*
           * T18 — subscription-origin refund. Stripe normally surfaces these
           * as `charge.refunded` (object: "charge"), but the legacy
           * `refund.*` events without Saleor metadata are also routed
           * through the subscription dispatcher here.
           */
          return this.dispatchToSubscriptionUseCase({ event, ctx: subscriptionCtx });
        }

        if (meta.saleor_app_id && meta.saleor_app_id !== appId) {
          return err(
            new ObjectMetadataMissingError("Refund belongs to a different Saleor installation", {
              props: {
                meta,
                expectedAppId: appId,
              },
            }),
          );
        }

        const handler = new StripeRefundHandler();

        return handler.processRefundEvent({
          event,
          stripeEnv,
          transactionRecorder: this.transactionRecorder,
          appId,
          saleorApiUrl,
        });
      }

      case "charge": {
        loggerContext.set("stripeChargeId", event.data.object.id);

        const meta = event.data.object.metadata as AllowedStripeObjectMetadata;

        /*
         * T18 — `charge.refunded` is the modern Stripe shape for refund
         * webhooks. One-shot Saleor checkout flows tag the underlying
         * PaymentIntent with `saleor_transaction_id` metadata, which Stripe
         * propagates to the Charge. When metadata is present the legacy
         * one-shot path already produced the corresponding refund report
         * via the `refund.*` event, so this `charge.refunded` is treated as
         * a no-op (200) to avoid double-reporting.
         */
        if (meta?.saleor_transaction_id) {
          if (meta.saleor_app_id && meta.saleor_app_id !== appId) {
            return err(
              new ObjectMetadataMissingError("Charge belongs to a different Saleor installation", {
                props: {
                  meta,
                  expectedAppId: appId,
                },
              }),
            );
          }

          return ok({
            _tag: SUBSCRIPTION_HANDLED_TAG,
            response: new StripeWebhookSuccessResponse(),
          });
        }

        return this.dispatchToSubscriptionUseCase({ event, ctx: subscriptionCtx });
      }

      case "subscription":
      case "invoice":
      case "customer": {
        return this.dispatchToSubscriptionUseCase({ event, ctx: subscriptionCtx });
      }

      default: {
        throw new BaseError(`Support for object ${event.data.object.object} not implemented`);
      }
    }
  }

  /**
   * It handles case when
   * 1. App was installed and configured. Webhook exists in Stripe
   * 2. App is removed - webhook is not
   * 3. App is reinstalled and configured again
   * 4. There are now 2 webhooks - old and new. Old one will always fail.
   *
   * At this point we detect an old webhook because it has different appId in URL (from previous installation).
   * Now we can use that to fetch old config from DB and remove the webhook.
   */
  private async processLegacyWebhook(webhookParams: WebhookParams) {
    const legacyConfig = await this.appConfigRepo.getStripeConfig({
      configId: webhookParams.configurationId,
      // Use app ID from webhook, not AuthData, so we have it frozen in time
      appId: webhookParams.appId,
      saleorApiUrl: webhookParams.saleorApiUrl,
    });

    if (legacyConfig.isErr()) {
      captureException(
        new BaseError(
          "Failed to fetch config attached to legacy Webhook, this requires manual cleanup",
          {
            cause: legacyConfig.error,
          },
        ),
      );

      return err(
        new BaseError("Failed to fetch legacy config", {
          cause: legacyConfig.error,
        }),
      );
    }

    if (!legacyConfig.value) {
      this.logger.error("Legacy config is empty, this requires manual cleanup");

      return err(new BaseError("Legacy config is empty"));
    }

    const removalResult = await this.removeStripeWebhook({
      webhookId: legacyConfig.value.webhookId,
      restrictedKey: legacyConfig.value.restrictedKey,
    });

    if (removalResult.isErr()) {
      return err(new BaseError("Failed to remove legacy webhook", { cause: removalResult.error }));
    }

    return ok(null);
  }

  async execute({
    rawBody,
    signatureHeader,
    webhookParams,
  }: {
    /**
     * Raw request body for signature verification
     */
    rawBody: string;
    /**
     * Header that Stripe sends with webhook
     */
    signatureHeader: string;
    /**
     * Parsed params that come from Stripe Webhook
     */
    webhookParams: WebhookParams;
  }): R {
    this.logger.debug("Executing");
    const authData = await this.apl.get(webhookParams.saleorApiUrl);

    if (!authData) {
      captureException(
        new BaseError("AuthData from APL is empty, installation may be broken"),
        (s) => s.setLevel("warning"),
      );

      return err(new StripeWebhookAppIsNotConfiguredResponse());
    }

    if (authData.appId !== webhookParams.appId) {
      this.logger.warn(
        "Received webhook with different appId than expected. There may be old webhook from uninstalled app. Will try to remove it now.",
      );

      const processingResult = await this.processLegacyWebhook(webhookParams);

      if (processingResult.isErr()) {
        this.logger.warn("Received legacy webhook but failed to handle removing it", {
          error: processingResult.error,
        });

        return err(new StripeWebhookAppIsNotConfiguredResponse());
      } else {
        return ok(new StripeWebhookSuccessResponse());
      }
    }

    const transactionEventReporter = this.transactionEventReporterFactory(authData);
    const problemReporter = this.problemReporterFactory(authData);

    const config = await this.appConfigRepo.getStripeConfig({
      configId: webhookParams.configurationId,
      appId: authData.appId,
      saleorApiUrl: webhookParams.saleorApiUrl,
    });

    this.logger.debug("Configuration for config resolved");

    if (config.isErr()) {
      this.logger.error("Failed to fetch config from database", {
        error: config.error,
      });

      captureException(config.error);

      return err(new StripeWebhookAppIsNotConfiguredResponse());
    }

    if (!config.value) {
      this.logger.error("Config for given webhook is missing");

      after(() => problemReporter.reportConfigMissing(webhookParams.configurationId));

      return err(new StripeWebhookAppIsNotConfiguredResponse());
    }

    appContextContainer.set({
      stripeEnv: config.value.getStripeEnvValue(),
    });

    const stripeClient = StripeClient.createFromRestrictedKey(config.value.restrictedKey);
    const eventVerifier = this.webhookEventVerifyFactory(stripeClient);

    const event = eventVerifier.verifyEvent({
      rawBody,
      webhookSecret: config.value.webhookSecret,
      signatureHeader,
    });

    this.logger.debug("Event verified");

    if (event.isErr()) {
      this.logger.error("Failed to verify event", {
        error: event.error,
      });

      const configName = config.value.name;

      after(() =>
        problemReporter.reportWebhookSecretMismatch(webhookParams.configurationId, configName),
      );

      return err(new StripeWebhookMalformedRequestResponse());
    }

    this.logger.debug(`Resolved event type: ${event.value.type}`);

    const processingResult = await this.processEvent({
      event: event.value,
      saleorApiUrl: webhookParams.saleorApiUrl,
      appId: authData.appId,
      stripeEnv: config.value.getStripeEnvValue(),
      restrictedKey: config.value.restrictedKey,
    });

    if (processingResult.isErr()) {
      /**
       * T18 — subscription dispatcher already produced a typed response.
       * Surface it directly without reporting through the transaction-event
       * pipeline (subscription events have no Saleor transaction to report
       * against).
       */
      const subErr = processingResult.error as { _tag?: string; response?: unknown };

      if (subErr._tag === SUBSCRIPTION_HANDLED_TAG && subErr.response) {
        return err(subErr.response as PossibleStripeWebhookErrorResponses);
      }

      /**
       * This is technically not an error, so we catch it here without the error log.
       */
      if (processingResult.error instanceof ObjectMetadataMissingError) {
        return err(new ObjectCreatedOutsideOfSaleorResponse());
      }

      this.logger.error("Failed to process event", {
        error: processingResult.error,
      });

      if (processingResult.error instanceof TransactionRecorderError.TransactionMissingError) {
        return err(new StripeWebhookTransactionMissingResponse());
      }

      return err(new StripeWebhookSeverErrorResponse());
    }

    /*
     * T18 — subscription dispatcher succeeded; short-circuit before the
     * Saleor transaction-event pipeline. There's nothing to report.
     */
    const processingValue = processingResult.value;
    const maybeSubOk = processingValue as { _tag?: string; response?: unknown };

    if (maybeSubOk._tag === SUBSCRIPTION_HANDLED_TAG && maybeSubOk.response) {
      return ok(maybeSubOk.response as PossibleStripeWebhookSuccessResponses);
    }

    /* Narrow back to the legacy event-report-variables resolver. */
    const oneShotValue = processingValue as Exclude<
      typeof processingValue,
      SubscriptionDispatchedSuccess
    >;

    loggerContext.set(ObservabilityAttributes.TRANSACTION_ID, oneShotValue.saleorTransactionId);
    loggerContext.set("amount", oneShotValue.saleorMoney.amount);
    loggerContext.set("result", oneShotValue.transactionResult.result);

    const reportResult = await transactionEventReporter.reportTransactionEvent(
      oneShotValue.resolveEventReportVariables(),
    );

    if (reportResult.isErr()) {
      if (reportResult.error instanceof TransactionEventReporterErrors.AlreadyReportedError) {
        this.logger.info("Transaction event already reported");

        return ok(new StripeWebhookSuccessResponse());
      }

      this.logger.error("Failed to report transaction event", {
        error: reportResult.error,
      });

      return err(new StripeWebhookSeverErrorResponse());
    }

    this.logger.info("Transaction event reported");

    return ok(new StripeWebhookSuccessResponse());
  }
}
