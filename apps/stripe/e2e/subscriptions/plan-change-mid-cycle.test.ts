// cspell:ignore fixmed signup
/**
 * T33 Scenario C — Plan change mid-cycle (proration invoice mints order).
 *
 * TODO — currently fixmed pending these manual gates from the plan PRD:
 *   1. Stripe test mode credentials populated in `.env.test`
 *      (E2E_STRIPE_TEST_SECRET_KEY, E2E_STRIPE_PRICE_BASIC_MONTHLY,
 *       E2E_STRIPE_PRICE_PRO_MONTHLY).
 *   2. Saleor `owlbooks` channel seeded with both Basic + Pro variants
 *      (E2E_SALEOR_VARIANT_BASIC, E2E_SALEOR_VARIANT_PRO).
 *   3. Production `ALTER TYPE SubscriptionStatus ADD VALUE 'PAST_DUE'`
 *      applied (and any other in-flight enum updates).
 *   4. T18a part-2 migration script run against the test environment.
 *
 * When the gates are met, implement using helpers in ./helpers/:
 *   - StripeTestClock + createStripeTestCustomer (cycle-1 setup)
 *   - POST /api/public/subscriptions/create with priceBasic
 *   - POST /api/public/subscriptions/change-plan with priceP ro
 *   - Confirm the proration invoice via stripe.paymentIntents.confirm
 *   - waitForSaleorOrder on the proration invoice id
 *   - Assert: 2 orders (cycle-1 + proration), proration order total matches
 *     invoice.amount_paid for the prorated amount.
 */
import { test } from "@playwright/test";

test.describe("Subscriptions — plan change mid-cycle", () => {
  test.fixme(
    true,
    "Blocked by manual gates: Stripe test creds, Saleor owlbooks channel + Pro variant seeded, ALTER TYPE SubscriptionStatus applied, T18a part 2 migration run.",
  );

  test("plan change generates proration invoice and mints order", () => {
    // intentionally empty — fixmed.
  });
});
