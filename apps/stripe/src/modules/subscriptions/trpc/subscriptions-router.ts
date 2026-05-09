/**
 * Subscriptions tRPC router.
 *
 * Mirrors the pattern from `modules/app-config/trpc-handlers/app-config-router.ts`
 * — handler stubs use `protectedClientProcedure` so the router gets the same
 * Saleor JWT + APL auth as the rest of the dashboard surface. Each procedure
 * delegates to the corresponding handler class (T20-T23). All five handlers
 * follow the same `new XHandler().getTrpcProcedure()` shape; per-handler
 * schemas + execution logic live in the handler files.
 *
 * Public storefront-facing entry points live separately under
 * `src/app/api/public/subscriptions/*` (T19a) and thin-wrap these procedures
 * via the parallel internal caller (`modules/trpc/internal-caller.ts`).
 */
import { router } from "@/modules/trpc/trpc-server";

import { BillingPortalTrpcHandler } from "./billing-portal";
import { CancelSubscriptionHandler } from "./cancel-subscription";
import { ChangePlanHandler } from "./change-plan";
import { CreateSubscriptionHandler } from "./create-subscription";
import { DeleteMappingHandler } from "./delete-mapping";
import { GetStatusTrpcHandler } from "./get-status";
import { ListMappingsHandler } from "./list-mappings";
import { UpsertMappingHandler } from "./upsert-mapping";

export const subscriptionsRouter = router({
  /**
   * Create a subscription for a Fief user against a Stripe price.
   * Body implemented in T20 — delegates to {@link CreateSubscriptionHandler}.
   */
  create: new CreateSubscriptionHandler().getTrpcProcedure(),

  /**
   * Cancel a subscription. Default behavior sets `cancel_at_period_end`;
   * `immediate=true` calls `stripe.subscriptions.cancel`.
   * Body implemented in T21 — delegates to {@link CancelSubscriptionHandler}.
   */
  cancel: new CancelSubscriptionHandler().getTrpcProcedure(),

  /**
   * Switch a subscription to a new Stripe price.
   * Body implemented in T21 — delegates to {@link ChangePlanHandler}.
   */
  changePlan: new ChangePlanHandler().getTrpcProcedure(),

  /**
   * Mint a Stripe Customer Portal session URL.
   * Body implemented in T22 — delegates to {@link BillingPortalTrpcHandler}.
   */
  createBillingPortalSession: new BillingPortalTrpcHandler().getTrpcProcedure(),

  /**
   * Read subscription state from the DynamoDB cache.
   * Body implemented in T23 — delegates to {@link GetStatusTrpcHandler}.
   */
  getStatus: new GetStatusTrpcHandler().getTrpcProcedure(),

  /**
   * List all Stripe-price ↔ Saleor-variant mappings for the current installation.
   * Powers the dashboard config UI (T25). Delegates to {@link ListMappingsHandler}.
   */
  listMappings: new ListMappingsHandler().getTrpcProcedure(),

  /**
   * Upsert a Stripe-price ↔ Saleor-variant mapping. Validates the
   * `stripePriceId` against Stripe before persisting. T25 dashboard mutation.
   * Delegates to {@link UpsertMappingHandler}.
   */
  upsertMapping: new UpsertMappingHandler().getTrpcProcedure(),

  /**
   * Hard-delete a Stripe-price ↔ Saleor-variant mapping by `stripePriceId`.
   * T25 dashboard mutation. Delegates to {@link DeleteMappingHandler}.
   */
  deleteMapping: new DeleteMappingHandler().getTrpcProcedure(),
});
