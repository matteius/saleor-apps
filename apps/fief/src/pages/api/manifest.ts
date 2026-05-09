import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { type AppManifest } from "@saleor/app-sdk/types";

import { env } from "@/lib/env";

import packageJson from "../../../package.json";

/*
 * Manifest endpoint — Saleor calls this when an operator clicks "Install".
 *
 * Webhooks list is intentionally empty at T1: concrete sync auth-webhook
 * definitions land in T18-T21 (AUTH_AUTHENTICATE_ME, AUTH_ISSUE_ACCESS_TOKENS,
 * AUTH_REFRESH_ACCESS_TOKENS, AUTH_LOGOUT) and concrete async customer-webhook
 * definitions in T26-T29. This file becomes their registration site:
 *
 *   webhooks: [
 *     authAuthenticateMeWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     authIssueAccessTokensWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     authRefreshAccessTokensWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     authLogoutWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     customerCreatedWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     customerUpdatedWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     customerMetadataUpdatedWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *     customerDeletedWebhookDefinition.getWebhookManifest(apiBaseUrl),
 *   ]
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
      webhooks: [],
    };

    return manifest;
  },
});
