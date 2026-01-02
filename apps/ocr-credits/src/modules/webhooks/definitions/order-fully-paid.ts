import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";

import { OrderFullyPaidDocument, OrderFullyPaidSubscription } from "@/generated/graphql";
import { saleorApp } from "@/saleor-app";

export type OrderFullyPaidPayload = NonNullable<OrderFullyPaidSubscription["event"]>;

export const orderFullyPaidAsyncWebhook = new SaleorAsyncWebhook<OrderFullyPaidPayload>({
  name: "Order Fully Paid - OCR Credits",
  webhookPath: "api/webhooks/order-fully-paid",
  event: "ORDER_FULLY_PAID",
  apl: saleorApp.apl,
  query: OrderFullyPaidDocument,
  /**
   * Webhook is active by default - we always want to provision credits when orders are paid
   */
  isActive: true,
});

