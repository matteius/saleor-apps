/** Resolve Saleor-installation services for public subscription routes. */

import { TRPCError } from "@trpc/server";

import { env } from "@/lib/env";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { saleorApp } from "@/lib/saleor-app";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { StripeSubscriptionsApiFactory } from "./api/stripe-subscriptions-api-factory";
import { priceVariantMapRepo } from "./repositories/price-variant-map-repo-impl";
import { subscriptionRepo } from "./repositories/subscription-repo-impl";
import { SaleorCustomerResolver } from "./saleor-bridge/saleor-customer-resolver";
import { selectSubscriptionStripeConfig } from "./subscription-stripe-config-selector";

export const resolveInternalSubscriptionRuntime = async () => {
  if (!env.SUBSCRIPTIONS_SALEOR_API_URL) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "SUBSCRIPTIONS_SALEOR_API_URL is not configured",
    });
  }

  const saleorApiUrlResult = createSaleorApiUrl(env.SUBSCRIPTIONS_SALEOR_API_URL);

  if (saleorApiUrlResult.isErr()) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Invalid Saleor API URL" });
  }

  const saleorApiUrl = saleorApiUrlResult.value;
  const authData = await saleorApp.apl.get(saleorApiUrl);

  if (!authData) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Saleor app installation is not available",
    });
  }

  const rootConfigResult = await appConfigRepoImpl.getRootConfig({
    saleorApiUrl,
    appId: authData.appId,
  });

  if (rootConfigResult.isErr()) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stripe app configuration could not be loaded",
    });
  }

  const stripeConfig = selectSubscriptionStripeConfig(
    rootConfigResult.value.getAllConfigsAsList(),
    env.SUBSCRIPTIONS_STRIPE_CONFIG_ID,
  );

  const factory = new StripeSubscriptionsApiFactory();

  return {
    accessPattern: { saleorApiUrl, appId: authData.appId },
    graphqlClient: createInstrumentedGraphqlClient(authData),
    stripeSubscriptionsApi: factory.createSubscriptionsApi({ key: stripeConfig.restrictedKey }),
    stripeCustomerApi: factory.createCustomerApi({ key: stripeConfig.restrictedKey }),
    customerResolver: new SaleorCustomerResolver(),
    subscriptionRepo,
    priceVariantMapRepo,
    publishableKey: stripeConfig.publishableKey,
  };
};
