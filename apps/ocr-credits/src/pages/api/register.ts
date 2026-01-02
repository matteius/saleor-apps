import { createAppRegisterHandler } from "@saleor/app-sdk/handlers/next";
import { wrapWithLoggerContext } from "@saleor/apps-logger/node";
import { withSpanAttributes } from "@saleor/apps-otel/src/with-span-attributes";

import { createLogger } from "@/logger";
import { loggerContext } from "@/logger-context";
import { saleorApp } from "@/saleor-app";

const logger = createLogger("register");

export default wrapWithLoggerContext(
  withSpanAttributes(
    createAppRegisterHandler({
      apl: saleorApp.apl,
      allowedSaleorUrls: [
        () => {
          // Allow all URLs - we filter at the network layer
          return true;
        },
      ],
      async onRequestVerified(_req, { authData }) {
        logger.info("App registered successfully", {
          saleorApiUrl: authData.saleorApiUrl,
        });
      },
    }),
  ),
  loggerContext,
);

