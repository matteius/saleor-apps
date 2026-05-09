import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { type AppManifest } from "@saleor/app-sdk/types";

import { customerCreatedWebhookDefinition } from "@/app/api/webhooks/saleor/customer-created/webhook-definition";
import { customerDeletedWebhookDefinition } from "@/app/api/webhooks/saleor/customer-deleted/webhook-definition";
import { customerMetadataUpdatedWebhookDefinition } from "@/app/api/webhooks/saleor/customer-metadata-updated/webhook-definition";
import { customerUpdatedWebhookDefinition } from "@/app/api/webhooks/saleor/customer-updated/webhook-definition";
import { env } from "@/lib/env";

import packageJson from "../../../package.json";

/*
 * Manifest endpoint — Saleor calls this when an operator clicks "Install".
 *
 * Aggregates the four async customer webhook definitions (T26-T29) so the
 * Saleor backend learns the app wants `CUSTOMER_*` events at install time.
 * Each definition exposes the SDK's `getWebhookManifest(apiBaseUrl)` builder
 * which renders the webhook into Saleor's manifest shape.
 *
 * The four sync auth webhooks the original T1 plan envisioned (T18-T21)
 * pivoted to a Saleor `BasePlugin` (Path A — see T2 spike): Saleor 3.x has
 * NO `AUTH_*` sync-webhook event names, so the auth plane is delivered via a
 * Python plugin calling our HTTPS endpoints directly. There is therefore no
 * auth-webhook entry to aggregate here.
 */
export default createManifestHandler({
  async manifestFactory({ appBaseUrl }) {
    const iframeBaseUrl = env.APP_IFRAME_BASE_URL ?? appBaseUrl;
    const apiBaseUrl = env.APP_API_BASE_URL ?? appBaseUrl;

    const manifest: AppManifest = {
      about:
        "Makes Fief the source of truth for storefront customer identity. Implements app-driven Saleor auth webhooks, bidirectional Fief<->Saleor user sync, and projection of Fief claims into Saleor metadata.",
      appUrl: iframeBaseUrl,
      author: "OpenSensor",
      brand: {
        logo: {
          default: `${apiBaseUrl}/logo.png`,
        },
      },
      dataPrivacyUrl: "https://saleor.io/legal/privacy/",
      extensions: [],
      homepageUrl: "https://github.com/saleor/apps",
      id: env.MANIFEST_APP_ID,
      name: env.APP_NAME,
      permissions: ["MANAGE_USERS"],
      requiredSaleorVersion: ">=3.21 <4",
      supportUrl: "https://saleor.io/discord",
      tokenTargetUrl: `${apiBaseUrl}/api/register`,
      version: packageJson.version,
      webhooks: [
        customerCreatedWebhookDefinition.getWebhookManifest(apiBaseUrl),
        customerUpdatedWebhookDefinition.getWebhookManifest(apiBaseUrl),
        customerMetadataUpdatedWebhookDefinition.getWebhookManifest(apiBaseUrl),
        customerDeletedWebhookDefinition.getWebhookManifest(apiBaseUrl),
      ],
    };

    return manifest;
  },
});
