import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";
import { wrapWithLoggerContext } from "@saleor/apps-logger/node";
import { withSpanAttributes } from "@saleor/apps-otel/src/with-span-attributes";

import packageJson from "../../../package.json";
import { appWebhooks } from "../../../webhooks";
import { loggerContext } from "../../lib/logger-context";

export default wrapWithLoggerContext(
  withSpanAttributes(
    createManifestHandler({
      async manifestFactory({ appBaseUrl }) {
        const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
        const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

        const manifest: AppManifest = {
          about:
            "Search App is a multi-integration app that connects your Saleor store with search engines.",
          appUrl: iframeBaseUrl,
          brand: {
            logo: {
              default: `${apiBaseURL}/logo.png`,
            },
          },
          dataPrivacyUrl: "https://saleor.io/legal/privacy/",
          extensions: [
            /**
             * Optionally, extend Dashboard with custom UIs
             * https://docs.saleor.io/developer/extending/apps/extending-dashboard-with-apps
             */
          ],
          homepageUrl: "https://github.com/saleor/apps",
          id: "saleor.app.search",
          name: "Search",
          permissions: [
            /**
             * Set permissions for app if needed
             * https://docs.saleor.io/developer/permissions
             */
            "MANAGE_PRODUCTS",
            "MANAGE_PRODUCT_TYPES_AND_ATTRIBUTES",
          ],
          supportUrl: "https://github.com/saleor/apps/discussions",
          tokenTargetUrl: `${apiBaseURL}/api/register`,
          version: packageJson.version,
          webhooks: appWebhooks.map((w) => w.getWebhookManifest(apiBaseURL)),
          author: "Saleor Commerce",
        };

        return manifest;
      },
    }),
  ),
  loggerContext,
);
