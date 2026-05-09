// cspell:ignore fixmed signup
/**
 * T33 Scenario D — Cancellation at period end (status flips, no immediate order).
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
 *   - POST /api/public/subscriptions/cancel with `{ atPeriodEnd: true }`.
 *   - Assert OwlBooks UserSubscription.status flips to CANCEL_AT_PERIOD_END
 *     (poll via /api/public/subscriptions/status).
 *   - Assert NO new Saleor order is minted (countOrdersForSubscription
 *     stays at 1).
 *   - Advance clock past period end → assert status -> CANCELED, still 1
 *     order, no cycle-2 invoice fired.
 */
import { test } from "@playwright/test";

test.describe("Subscriptions — cancel at period end", () => {
  test.fixme(
    true,
    "Blocked by manual gates: Stripe test creds, Saleor owlbooks channel seeded, ALTER TYPE SubscriptionStatus applied, T18a part 2 migration run.",
  );

  test("cancel-at-period-end flips status without minting an order", () => {
    // intentionally empty — fixmed.
  });
});
