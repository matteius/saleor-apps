import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";
import { wrapWithLoggerContext } from "@saleor/apps-logger/node";
import { withSpanAttributes } from "@saleor/apps-otel/src/with-span-attributes";

import { env } from "@/env";
import { loggerContext } from "@/logger-context";
import { appWebhooks } from "@/modules/webhooks/webhooks";

import packageJson from "../../../package.json";

export default wrapWithLoggerContext(
  withSpanAttributes(
    createManifestHandler({
      async manifestFactory({ appBaseUrl }) {
        const iframeBaseUrl = env.APP_IFRAME_BASE_URL ?? appBaseUrl;
        const apiBaseURL = env.APP_API_BASE_URL ?? appBaseUrl;

        const manifest: AppManifest = {
          about: "Provisions OCR credits to Demetered when orders are paid",
          appUrl: iframeBaseUrl,
          author: "OpenSensor",
          brand: {
            logo: {
              default: `${apiBaseURL}/logo.png`,
            },
          },
          dataPrivacyUrl: "https://opensensor.io/legal/privacy/",
          extensions: [],
          homepageUrl: "https://ocr.opensensor.io",
          id: env.MANIFEST_APP_ID,
          name: "OCR Credits",
          permissions: ["MANAGE_ORDERS"],
          requiredSaleorVersion: ">=3.21 <4",
          supportUrl: "https://opensensor.io/support",
          tokenTargetUrl: `${apiBaseURL}/api/register`,
          version: packageJson.version,
          webhooks: appWebhooks.map((w) => w.getWebhookManifest(apiBaseURL)),
        };

        return manifest;
      },
    }),
  ),
  loggerContext,
);

