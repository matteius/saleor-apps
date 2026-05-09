// cspell:ignore fixmed signup
/**
 * T33 Scenario E — Hard cancel (immediate, status -> CANCELLED).
 *
 * TODO — currently fixmed pending these manual gates from the plan PRD:
 *   1. Stripe test mode credentials populated in `.env.test`
 *      (E2E_STRIPE_TEST_SECRET_KEY, E2E_STRIPE_PRICE_BASIC_MONTHLY).
 *   2. Saleor `owlbooks` channel seeded with the Basic subscription variant.
 *   3. Production `ALTER TYPE SubscriptionStatus` applied (CANCELED state).
 *   4. T18a part 2 migration script run against the test environment.
 *
 * When the gates are met, implement using helpers in ./helpers/:
 *   - Cycle-1 sign-up via storefront request helper.
 *   - POST /api/public/subscriptions/cancel with `{ atPeriodEnd: false }`.
 *   - Assert Stripe subscription status === "canceled" immediately.
 *   - Assert OwlBooks UserSubscription.status -> CANCELED.
 *   - Assert no new Saleor orders are minted (count stays at 1).
 *   - Optionally: advance clock and assert no further invoices fire.
 */
import { test } from "@playwright/test";

test.describe("Subscriptions — hard cancel", () => {
  test.fixme(
    true,
    "Blocked by manual gates: Stripe test creds, Saleor owlbooks channel seeded, ALTER TYPE SubscriptionStatus applied, T18a part 2 migration run.",
  );

  test("hard cancel sets status to CANCELED immediately", () => {
    // intentionally empty — fixmed.
  });
});
