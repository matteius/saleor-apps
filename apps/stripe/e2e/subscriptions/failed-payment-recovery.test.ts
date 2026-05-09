// cspell:ignore fixmed signup
/**
 * T33 Scenario F — Failed payment → past_due → recovered.
 *
 * TODO — currently fixmed pending these manual gates from the plan PRD:
 *   1. Stripe test mode credentials populated in `.env.test`
 *      (E2E_STRIPE_TEST_SECRET_KEY, E2E_STRIPE_PRICE_BASIC_MONTHLY).
 *   2. Saleor `owlbooks` channel seeded with the Basic subscription variant.
 *   3. Production `ALTER TYPE SubscriptionStatus` applied (PAST_DUE state).
 *   4. T18a part 2 migration script run against the test environment.
 *   5. Stripe Smart Retries / dunning settings configured for the test mode
 *      account so failed payments transition through `past_due`.
 *
 * When the gates are met, implement using helpers in ./helpers/:
 *   - Use `pm_card_chargeCustomerFail` for cycle-1 instead of pm_card_visa.
 *   - Sign up; assert cycle-1 invoice goes `payment_failed`.
 *   - Assert OwlBooks UserSubscription.status -> PAST_DUE.
 *   - Assert NO Saleor order is minted (count == 0).
 *   - Update default PM to pm_card_visa via Stripe SDK.
 *   - Trigger invoice retry via stripe.invoices.pay.
 *   - Assert status -> ACTIVE, Saleor order minted (count == 1).
 */
import { test } from "@playwright/test";

test.describe("Subscriptions — failed payment recovery", () => {
  test.fixme(
    true,
    "Blocked by manual gates: Stripe test creds, Saleor owlbooks channel seeded, ALTER TYPE SubscriptionStatus applied, T18a part 2 migration run, Stripe dunning configured.",
  );

  test("failed payment then PM swap recovers subscription and mints order", () => {
    // intentionally empty — fixmed.
  });
});
