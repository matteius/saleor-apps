import { NextJsWebhookHandler, SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";

import { env } from "@/env";
import { OrderDetailsFragment, OrderFullyPaidDocument } from "@/generated/graphql";
import { createLogger } from "@/logger";
import { getPagesForSku } from "@/modules/configuration/sku-mapping";
import { DemeteredClient } from "@/modules/demetered/demetered-client";
import { saleorApp } from "@/saleor-app";

/**
 * The webhook payload is typed as the OrderFullyPaid event which contains the order.
 */
interface OrderFullyPaidPayload {
  order?: OrderDetailsFragment | null;
}

export const orderFullyPaidAsyncWebhook = new SaleorAsyncWebhook<OrderFullyPaidPayload>({
  name: "Order Fully Paid - OCR Credits",
  webhookPath: "api/webhooks/order-fully-paid",
  event: "ORDER_FULLY_PAID",
  apl: saleorApp.apl,
  query: OrderFullyPaidDocument,
  isActive: true,
});

const logger = createLogger("orderFullyPaidHandler");

const handler: NextJsWebhookHandler<OrderFullyPaidPayload> = async (_req, res, context) => {
  const { payload } = context;

  logger.info("Received ORDER_FULLY_PAID webhook", {
    orderId: payload.order?.id,
    orderNumber: payload.order?.number,
  });

  if (!payload.order) {
    logger.error("No order in payload");

    return res.status(400).json({ error: "No order in payload" });
  }

  const order = payload.order;
  const customerEmail = order.userEmail;

  if (!customerEmail) {
    logger.error("No customer email in order", { orderId: order.id });

    return res.status(400).json({ error: "No customer email in order" });
  }

  // Process each line item
  const demeteredClient = new DemeteredClient({
    apiUrl: env.DEMETERED_API_URL,
    apiKey: env.DEMETERED_ADMIN_API_KEY,
  });

  let totalCreditsAdded = 0;

  for (const line of order.lines) {
    const sku = line.productSku;

    if (!sku) {
      logger.warn("Line item has no SKU", { lineId: line.id });
      continue;
    }

    const pageCredits = getPagesForSku(sku);

    if (!pageCredits) {
      logger.info("SKU not recognized as OCR credits product", { sku });
      continue;
    }

    const creditsToAdd = pageCredits * line.quantity;

    logger.info("Adding OCR credits for line item", {
      sku,
      quantity: line.quantity,
      pageCredits,
      totalCredits: creditsToAdd,
    });

    // Use email as account ID (Demetered will create/get account)
    const result = await demeteredClient.addCredits({
      accountId: customerEmail,
      pages: creditsToAdd,
      orderId: order.id,
      source: "saleor-ocr-credits",
    });

    if (result.isErr()) {
      logger.error("Failed to add credits", {
        error: result.error.message,
        sku,
        accountId: customerEmail,
      });

      return res.status(500).json({ error: "Failed to provision credits" });
    }

    const creditResult = result.value;

    logger.info("Successfully added credits", {
      accountId: customerEmail,
      pagesAdded: creditResult.pages_added,
      newBalance: creditResult.new_credit_balance,
    });

    totalCreditsAdded += creditsToAdd;
  }

  if (totalCreditsAdded === 0) {
    logger.info("No OCR credit products found in order", { orderId: order.id });
  }

  return res.status(200).json({
    success: true,
    creditsAdded: totalCreditsAdded,
    accountId: customerEmail,
  });
};

export default orderFullyPaidAsyncWebhook.createHandler(handler);

export const config = {
  api: {
    bodyParser: false,
  },
};

