import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import { verifyWebhookSignature } from "@/app/api/webhooks/saleor/verify-signature";
import {
  FiefCustomerMetadataUpdatedDocument,
  type FiefCustomerMetadataUpdatedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

/*
 * T28 — `CUSTOMER_METADATA_UPDATED` async webhook definition.
 *
 * Async because the SDK pattern for Saleor → app event delivery is
 * `SaleorAsyncWebhook`. The route handler enqueues onto T52's outbound
 * queue and the worker dispatches the use case which applies the
 * **reverse-sync gate** (per-claim `reverseSyncEnabled` flag from T17's
 * extended `ClaimMappingEntry` schema).
 *
 * Subscription document: `FiefCustomerMetadataUpdated` from
 * `apps/fief/graphql/subscriptions/fief-customer-metadata-updated.graphql`.
 *
 * Naming convention re-used by T29:
 *   - file: `apps/fief/src/app/api/webhooks/saleor/<event-kebab>/webhook-definition.ts`
 *   - export: `<eventCamel>WebhookDefinition`
 *   - subscription doc: `Fief<EventPascal>` in
 *     `apps/fief/graphql/subscriptions/fief-<event-kebab>.graphql`
 *   - queue eventType: `saleor.<event_snake>`
 */
export const customerMetadataUpdatedWebhookDefinition =
  new SaleorAsyncWebhook<FiefCustomerMetadataUpdatedEventFragment>({
    apl: saleorApp.apl,
    event: "CUSTOMER_METADATA_UPDATED",
    name: "Fief Customer Metadata Updated",
    isActive: true,
    query: FiefCustomerMetadataUpdatedDocument,
    webhookPath: "api/webhooks/saleor/customer-metadata-updated",
    verifySignatureFn: (jwks, signature, rawBody) => {
      return verifyWebhookSignature(jwks, signature, rawBody);
    },
  });
