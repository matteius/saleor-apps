import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import { verifyWebhookSignature } from "@/app/api/webhooks/saleor/verify-signature";
import {
  FiefCustomerDeletedDocument,
  type FiefCustomerDeletedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

/*
 * T29 — `CUSTOMER_DELETED` async webhook definition.
 *
 * Async because the SDK pattern for Saleor → app event delivery is
 * `SaleorAsyncWebhook`: we receive the (already-verified) payload + auth
 * data, do bounded work, and return a 200. The actual Fief I/O is queued
 * onto T52's outbound queue and dispatched by the worker — the webhook route
 * itself only enqueues + returns 200.
 *
 * Subscription document: `FiefCustomerDeleted` from
 * `apps/fief/graphql/subscriptions/fief-customer-deleted.graphql`.
 *
 * Schema note: `type CustomerDeleted implements Event` was missing from the
 * checked-in `schema.graphql` (Saleor 3.23 ships the enum
 * `CUSTOMER_DELETED` but had not yet added the typed Event). T29 adds the
 * minimal type definition so this subscription document type-checks; the
 * shape mirrors `CustomerCreated` / `CustomerUpdated` exactly.
 *
 * Manifest exposure: `getWebhookManifest()` is the SDK's built-in builder.
 * The follow-up manifest aggregator (T1's `webhooks: []` placeholder) will
 * call this from a single place.
 *
 * Naming convention shared with T26/T27/T28:
 *   - file: `apps/fief/src/app/api/webhooks/saleor/<event-kebab>/webhook-definition.ts`
 *   - export: `<eventCamel>WebhookDefinition`
 *   - subscription doc: `Fief<EventPascal>` in
 *     `apps/fief/graphql/subscriptions/fief-<event-kebab>.graphql`
 *   - queue eventType: `saleor.<event_snake>`
 */
export const customerDeletedWebhookDefinition =
  new SaleorAsyncWebhook<FiefCustomerDeletedEventFragment>({
    apl: saleorApp.apl,
    event: "CUSTOMER_DELETED",
    name: "Fief Customer Deleted",
    isActive: true,
    query: FiefCustomerDeletedDocument,
    webhookPath: "api/webhooks/saleor/customer-deleted",
    verifySignatureFn: (jwks, signature, rawBody) => {
      return verifyWebhookSignature(jwks, signature, rawBody);
    },
  });
