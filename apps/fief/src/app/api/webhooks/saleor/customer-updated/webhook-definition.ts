import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import { verifyWebhookSignature } from "@/app/api/webhooks/saleor/verify-signature";
import {
  FiefCustomerUpdatedDocument,
  type FiefCustomerUpdatedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

/*
 * T27 — `CUSTOMER_UPDATED` async webhook definition.
 *
 * Async because the SDK pattern for Saleor → app event delivery is
 * `SaleorAsyncWebhook`: we receive the (already-verified) payload + auth
 * data, do bounded work, and return a 200. The actual Fief I/O is queued
 * onto T52's outbound queue and dispatched by the worker — the webhook route
 * itself only enqueues + returns 200.
 *
 * Subscription document: `FiefCustomerUpdated` from
 * `apps/fief/graphql/subscriptions/fief-customer-updated.graphql`.
 *
 * Manifest exposure: `getWebhookManifest()` is the SDK's built-in builder.
 * The follow-up manifest aggregator (T1's `webhooks: []` placeholder) will
 * call this from a single place.
 *
 * Naming convention shared with T26/T28/T29:
 *   - file: `apps/fief/src/app/api/webhooks/saleor/<event-kebab>/webhook-definition.ts`
 *   - export: `<eventCamel>WebhookDefinition`
 *   - subscription doc: `Fief<EventPascal>` in
 *     `apps/fief/graphql/subscriptions/fief-<event-kebab>.graphql`
 *   - queue eventType: `saleor.<event_snake>`
 */
export const customerUpdatedWebhookDefinition =
  new SaleorAsyncWebhook<FiefCustomerUpdatedEventFragment>({
    apl: saleorApp.apl,
    event: "CUSTOMER_UPDATED",
    name: "Fief Customer Updated",
    isActive: true,
    query: FiefCustomerUpdatedDocument,
    webhookPath: "api/webhooks/saleor/customer-updated",
    verifySignatureFn: (jwks, signature, rawBody) => {
      return verifyWebhookSignature(jwks, signature, rawBody);
    },
  });
