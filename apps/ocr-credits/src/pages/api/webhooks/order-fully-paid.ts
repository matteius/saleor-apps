import { NextJsWebhookHandler, SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";

import { env } from "@/env";
import {
  OrderDetailsFragment,
  OrderFulfillDocument,
  OrderFullyPaidDocument,
} from "@/generated/graphql";
import { createLogger } from "@/logger";
import { getPagesForSku } from "@/modules/configuration/sku-mapping";
import { DemeteredClient } from "@/modules/demetered/demetered-client";
import { saleorApp } from "@/saleor-app";

// Default warehouse for digital products (Matt's Warehouse OpenSensor.io)
const DEFAULT_WAREHOUSE_ID = "V2FyZWhvdXNlOjgzM2YyNDU0LTU5ZTctNGFjOC04ZGIyLTk2ZTRkZTNmZmQ1Mg==";

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
  const { payload, authData } = context;

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

  // Create GraphQL client for Saleor API
  const client = createGraphQLClient({
    saleorApiUrl: authData.saleorApiUrl,
    token: authData.token,
  });

  // Process each line item
  const demeteredClient = new DemeteredClient({
    apiUrl: env.DEMETERED_API_URL,
    apiKey: env.DEMETERED_ADMIN_API_KEY,
  });

  let totalCreditsAdded = 0;
  const linesToFulfill: Array<{ orderLineId: string; quantity: number }> = [];

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

    // Track line for fulfillment (only if there are items to fulfill)
    if (line.quantityToFulfill && line.quantityToFulfill > 0) {
      linesToFulfill.push({
        orderLineId: line.id,
        quantity: line.quantityToFulfill,
      });
    }
  }

  if (totalCreditsAdded === 0) {
    logger.info("No OCR credit products found in order", { orderId: order.id });
  }

  // Fulfill the order if we added credits and have lines to fulfill
  if (totalCreditsAdded > 0 && linesToFulfill.length > 0) {
    logger.info("Fulfilling order", {
      orderId: order.id,
      linesToFulfill: linesToFulfill.length,
    });

    try {
      const fulfillResult = await client
        .mutation(OrderFulfillDocument, {
          order: order.id,
          input: {
            lines: linesToFulfill.map((line) => ({
              orderLineId: line.orderLineId,
              stocks: [
                {
                  warehouse: DEFAULT_WAREHOUSE_ID,
                  quantity: line.quantity,
                },
              ],
            })),
            notifyCustomer: false, // Don't send shipping notification for digital products
          },
        })
        .toPromise();

      if (fulfillResult.error) {
        logger.error("GraphQL error fulfilling order", {
          orderId: order.id,
          error: fulfillResult.error.message,
        });
      } else if (fulfillResult.data?.orderFulfill?.errors?.length) {
        logger.error("Failed to fulfill order", {
          orderId: order.id,
          errors: fulfillResult.data.orderFulfill.errors,
        });
      } else {
        logger.info("Order fulfilled successfully", {
          orderId: order.id,
          newStatus: fulfillResult.data?.orderFulfill?.order?.status,
        });
      }
    } catch (error) {
      logger.error("Exception fulfilling order", {
        orderId: order.id,
        error: String(error),
      });
      // Don't fail the webhook - credits were already added
    }
  }

  return res.status(200).json({
    success: true,
    creditsAdded: totalCreditsAdded,
    accountId: customerEmail,
    fulfilled: linesToFulfill.length > 0,
  });
};

export default orderFullyPaidAsyncWebhook.createHandler(handler);

export const config = {
  api: {
    bodyParser: false,
  },
};

