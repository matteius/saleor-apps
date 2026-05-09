/**
 * Subscriptions tRPC router.
 *
 * Mirrors the pattern from `modules/app-config/trpc-handlers/app-config-router.ts`.
 * Handlers (`create`, `cancel`, `changePlan`, `createBillingPortalSession`,
 * `getStatus`) are added in T20–T23 and the router is wired into the root
 * `modules/trpc/trpc-router.ts` in T19.
 *
 * To be fully implemented in T19.
 */
import { router } from "@/modules/trpc/trpc-server";

export const TODO_T19_SUBSCRIPTIONS_ROUTER = "implement in T19";

export const subscriptionsRouter = router({});
