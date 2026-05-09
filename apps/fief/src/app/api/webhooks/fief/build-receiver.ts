import { getProductionDeps } from "@/lib/composition-root";
import { eventRouter } from "@/modules/sync/fief-to-saleor/event-router";
import { FiefReceiver, type FindConnectionById } from "@/modules/sync/fief-to-saleor/receiver";

/*
 * T22 — Fief receiver factory.
 *
 * Extracted out of `route.ts` so tests can import it without violating
 * Next.js' Route export contract (App Router rejects any non-standard
 * exports from `route.ts` and would fail `next build` with
 * "buildReceiver is not a valid Route export field.")
 *
 * Production wiring sources every dependency from `@/lib/composition-root`
 * (T40), including the cross-tenant `findConnectionById` lookup that walks
 * `provider_connections` by `id` only (Fief webhook URLs only carry the
 * connectionId — tenant scope is recovered downstream after lookup).
 */

/**
 * Build the production receiver. Exported for tests so they can build
 * an isolated receiver with stubbed deps and exercise the full
 * route-level translation table without standing up Mongo.
 */
export const buildReceiver = (overrides?: { findConnectionById?: FindConnectionById }) => {
  const deps = getProductionDeps();

  const findConnectionById: FindConnectionById =
    overrides?.findConnectionById ?? deps.findConnectionById;

  return new FiefReceiver({
    providerConnectionRepo: deps.connectionRepo,
    findConnectionById,
    webhookLogRepo: deps.webhookLogRepo,
    encryptor: deps.encryptor,
    eventRouter,
  });
};
