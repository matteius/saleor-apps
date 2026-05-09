import { trace } from "@opentelemetry/api";
import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { compose } from "@saleor/apps-shared/compose";
import { captureException } from "@sentry/nextjs";
import { Result } from "neverthrow";
import { type NextRequest } from "next/server";

import { appContextContainer } from "@/lib/app-context";
import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { loggerContext, withLoggerContext } from "@/lib/logger-context";
import { setObservabilitySaleorApiUrl } from "@/lib/observability-saleor-api-url";
import { saleorApp } from "@/lib/saleor-app";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createStripeProblemReporter } from "@/modules/app-problems";
import { TransactionEventReporter } from "@/modules/saleor/transaction-event-reporter";
import { StripePaymentIntentsApiFactory } from "@/modules/stripe/stripe-payment-intents-api-factory";
import { StripeWebhookManager } from "@/modules/stripe/stripe-webhook-manager";
import { StripeWebhookSignatureValidator } from "@/modules/stripe/stripe-webhook-signature-validator";
import { StripeChargesApiFactory } from "@/modules/subscriptions/api/stripe-charges-api";
import { StripeSubscriptionsApiFactory } from "@/modules/subscriptions/api/stripe-subscriptions-api-factory";
import { HttpOwlBooksWebhookNotifier } from "@/modules/subscriptions/notifiers/owlbooks-notifier";
import { DynamoDbPriceVariantMapRepo } from "@/modules/subscriptions/repositories/dynamodb/dynamodb-price-variant-map-repo";
import { DynamoDbRefundDlqRepo } from "@/modules/subscriptions/repositories/dynamodb/dynamodb-refund-dlq-repo";
import { DynamoDbSubscriptionRepo } from "@/modules/subscriptions/repositories/dynamodb/dynamodb-subscription-repo";
import { SaleorCustomerResolver } from "@/modules/subscriptions/saleor-bridge/saleor-customer-resolver";
import { type ISaleorGraphqlClientFactory } from "@/modules/subscriptions/webhooks/charge-refund-handler";
import { SubscriptionWebhookUseCase } from "@/modules/subscriptions/webhooks/subscription-webhook-use-case";
import { transactionRecorder } from "@/modules/transactions-recording/repositories/transaction-recorder-impl";

import { getAndParseStripeSignatureHeader } from "./stripe-signature-header";
import {
  StripeWebhookMalformedRequestResponse,
  StripeWebhookSeverErrorResponse,
} from "./stripe-webhook-responses";
import { StripeWebhookUseCase } from "./use-case";
import { WebhookParams } from "./webhook-params";

/**
 * T18 — Saleor GraphQL client factory used by `ChargeRefundHandler` to call
 * `orderVoid`. Resolves the per-installation `AuthData` from APL on each call
 * and builds an instrumented urql client.
 */
const saleorGraphqlClientFactory: ISaleorGraphqlClientFactory = {
  async createForInstallation({ saleorApiUrl, appId }) {
    const authData = await saleorApp.apl.get(saleorApiUrl);

    if (!authData || authData.appId !== appId) {
      return null;
    }

    return createInstrumentedGraphqlClient({
      saleorApiUrl: authData.saleorApiUrl,
      token: authData.token,
    });
  },
};

const subscriptionWebhookUseCase = new SubscriptionWebhookUseCase({
  apl: saleorApp.apl,
  appConfigRepo: appConfigRepoImpl,
  subscriptionRepo: new DynamoDbSubscriptionRepo(),
  priceVariantMapRepo: new DynamoDbPriceVariantMapRepo(),
  customerResolver: new SaleorCustomerResolver(),
  stripeSubscriptionsApiFactory: new StripeSubscriptionsApiFactory(),
  stripeChargesApiFactory: new StripeChargesApiFactory(),
  refundDlqRepo: new DynamoDbRefundDlqRepo(),
  saleorGraphqlClientFactory,
  /*
   * `HttpOwlBooksWebhookNotifier` tolerates undefined env vars at construction
   * time and returns `Err(ConfigurationMissingError)` from `notify()` until
   * the env is set. Wave 9+ provisions the OwlBooks endpoint.
   */
  owlbooksWebhookNotifier: new HttpOwlBooksWebhookNotifier({
    url: env.OWLBOOKS_WEBHOOK_URL,
    secret: env.OWLBOOKS_WEBHOOK_SECRET,
  }),
});

const useCase = new StripeWebhookUseCase({
  appConfigRepo: appConfigRepoImpl,
  webhookEventVerifyFactory: (stripeClient) =>
    StripeWebhookSignatureValidator.createFromClient(stripeClient),
  apl: saleorApp.apl,
  transactionRecorder: transactionRecorder,
  transactionEventReporterFactory(authData) {
    return new TransactionEventReporter({
      graphqlClient: createInstrumentedGraphqlClient(authData),
    });
  },
  problemReporterFactory: (authData) => createStripeProblemReporter(authData),
  webhookManager: new StripeWebhookManager(),
  stripePaymentIntentsApiFactory: new StripePaymentIntentsApiFactory(),
  subscriptionWebhookUseCase,
});

const logger = createLogger("StripeWebhookHandler");

const StripeWebhookHandler = async (request: NextRequest): Promise<Response> => {
  /**
   * Has access to first error value
   * Use https://github.com/supermacro/neverthrow#resultcombinewithallerrors-static-class-method to
   * get access to all errors
   */
  const requiredUrlAttributes = Result.combine([
    getAndParseStripeSignatureHeader(request.headers),
    WebhookParams.createFromWebhookUrl(request.url),
  ]);

  if (requiredUrlAttributes.isErr()) {
    logger.info("Received webhook from Stripe with invalid parameters", {
      error: requiredUrlAttributes.error,
    });

    return new StripeWebhookMalformedRequestResponse().getResponse();
  }

  const [stripeSignatureHeader, webhookParams] = requiredUrlAttributes.value;

  /**
   * todo:
   * - improve logger context to accept single record
   */
  setObservabilitySaleorApiUrl(webhookParams.saleorApiUrl);
  loggerContext.set(ObservabilityAttributes.CONFIGURATION_ID, webhookParams.configurationId);

  trace
    .getActiveSpan()
    ?.setAttribute(ObservabilityAttributes.SALEOR_API_URL, webhookParams.saleorApiUrl);

  logger.info("Received webhook from Stripe");

  try {
    const result = await useCase.execute({
      rawBody: await request.text(),
      signatureHeader: stripeSignatureHeader,
      webhookParams,
    });

    /**
     * todo:
     * - attach operations context to Response, so we can print them to logger here (like what was reported)
     */
    return result.match(
      (success) => {
        logger.info("Success processing Stripe webhook", {
          httpsStatusCode: success.statusCode,
        });

        return success.getResponse();
      },
      (error) => {
        logger.warn("Failed to process Stripe webhook", {
          error: error,
          httpsStatusCode: error.statusCode,
        });

        return error.getResponse();
      },
    );
  } catch (e) {
    logger.error("Unhandled error", { error: e });

    const panicError = new BaseError("Unhandled Error processing Stripe webhook UseCase", {
      cause: e,
    });

    captureException(panicError);

    return new StripeWebhookSeverErrorResponse().getResponse();
  }
};

export const POST = compose(
  withLoggerContext,
  appContextContainer.wrapRequest,
)(StripeWebhookHandler);
