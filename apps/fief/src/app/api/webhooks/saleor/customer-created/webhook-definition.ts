import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import { verifyWebhookSignature } from "@/app/api/webhooks/saleor/verify-signature";
import {
  FiefCustomerCreatedDocument,
  type FiefCustomerCreatedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

/*
 * T26 — `CUSTOMER_CREATED` async webhook definition.
 *
 * Async because the SDK pattern for Saleor → app event delivery is
 * `SaleorAsyncWebhook`: we receive the (already-verified) payload + auth
 * data, do bounded work, and return a 200. The actual Fief I/O is queued
 * onto T52's outbound queue and dispatched by the worker — the webhook
 * route itself only enqueues + returns 200.
 *
 * Subscription document: `FiefCustomerCreated` from
 * `apps/fief/graphql/subscriptions/fief-customer-created.graphql`.
 *
 * Manifest exposure: `getWebhookManifest()` is the SDK's built-in builder.
 * The follow-up manifest aggregator (T1's `webhooks: []` placeholder) will
 * call this from a single place — until then, this export is the contract.
 *
 * Naming convention re-used by T27/T28/T29:
 *   - file: `apps/fief/src/app/api/webhooks/saleor/<event-kebab>/webhook-definition.ts`
 *   - export: `<eventCamel>WebhookDefinition`
 *   - subscription doc: `Fief<EventPascal>` in
 *     `apps/fief/graphql/subscriptions/fief-<event-kebab>.graphql`
 *   - queue eventType: `saleor.<event_snake>`
 */
export const customerCreatedWebhookDefinition =
  new SaleorAsyncWebhook<FiefCustomerCreatedEventFragment>({
    apl: saleorApp.apl,
    event: "CUSTOMER_CREATED",
    name: "Fief Customer Created",
    isActive: true,
    query: FiefCustomerCreatedDocument,
    webhookPath: "api/webhooks/saleor/customer-created",
    verifySignatureFn: (jwks, signature, rawBody) => {
      return verifyWebhookSignature(jwks, signature, rawBody);
    },
  });
