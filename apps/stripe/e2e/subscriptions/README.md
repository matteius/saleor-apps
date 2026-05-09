<!-- cspell:ignore signup fixmed HMAC hmac whsec Owlbooks owlbooks Fief fief -->
# Subscription E2E tests (T33)

Playwright scenarios for the OwlBooks subscription flow built on Stripe test
clocks. Two scenarios are active and four are scaffolded as `test.fixme`
stubs pending manual gates.

## Scenarios

| File | Status | Covers |
|------|--------|--------|
| `sign-up-happy-path.test.ts` | active | Cycle-1 sign-up → Stripe charges visa → Saleor order minted |
| `cycle-2-test-clock.test.ts` | active | Advance test clock 32 days → cycle-2 invoice fires → second Saleor order |
| `plan-change-mid-cycle.test.ts` | stubbed | Plan upgrade mid-cycle → proration invoice → order |
| `cancel-at-period-end.test.ts` | stubbed | `atPeriodEnd: true` cancel → status flips, no new order |
| `hard-cancel-immediate.test.ts` | stubbed | `atPeriodEnd: false` cancel → status `CANCELED`, no further invoices |
| `failed-payment-recovery.test.ts` | stubbed | `pm_card_chargeCustomerFail` → `past_due` → swap PM → recover |

## Required env vars

Copy `apps/stripe/.env.test.example` to `apps/stripe/.env.test` and fill in
the `T33` block at the bottom. Active scenarios need:

- `E2E_STRIPE_TEST_SECRET_KEY` (`sk_test_...`)
- `E2E_STRIPE_PUBLISHABLE_KEY` (`pk_test_...`)
- `E2E_STRIPE_WEBHOOK_SECRET` (`whsec_...`)
- `E2E_STRIPE_PRICE_BASIC_MONTHLY` (`price_test_...`)
- `E2E_STRIPE_PRICE_PRO_MONTHLY` (`price_test_...`)
- `E2E_SALEOR_API_URL` (your test Saleor `/graphql/` endpoint)
- `E2E_SALEOR_OWLBOOKS_CHANNEL_SLUG` (default `owlbooks`)
- `E2E_SALEOR_VARIANT_BASIC` / `E2E_SALEOR_VARIANT_PRO` (base64 ProductVariant IDs)
- `E2E_FIEF_TEST_USER_ID` / `E2E_FIEF_TEST_USER_EMAIL`

Plus, to actually call the protected storefront endpoint:

- `STOREFRONT_BRIDGE_SECRET` (or `E2E_STOREFRONT_BRIDGE_SECRET`)
- `E2E_FIEF_TEST_JWT` (a valid Fief-issued JWT for the test user)
- `E2E_BASE_URL` (Stripe app deploy URL, e.g. `https://stripe-app.test.example.com`)

When any of the above are missing, the active scenarios print a clear skip
message and exit cleanly — they do not fail.

## Running

```bash
# All subscription scenarios (active + stubbed)
pnpm test:e2e --project=subscriptions-e2e

# A single scenario
pnpm test:e2e --project=subscriptions-e2e -- sign-up-happy-path

# List without running (sanity-check the test plan)
pnpm test:e2e --list --project=subscriptions-e2e
```

The default `chromium` project ignores `e2e/subscriptions/**` so the
existing `complete-checkout.test.ts` flow is unaffected.

## Stripe test clocks — gotchas

- A test clock + customer + subscription are all linked. **You cannot detach
  a customer from a test clock** — clean up by deleting the test clock
  (cascades to attached customers/subscriptions/invoices). The helpers do
  this in a `try/finally`.
- `clock.advance` is asynchronous on Stripe's side. `StripeTestClock.advance`
  polls the clock until status returns to `ready`; default timeout 120 s.
- Webhooks fire from Stripe to your deployed app. The polling helpers
  (`waitForSaleorOrder`) account for that delivery latency.
- Each scenario creates a fresh test clock with a unique name so parallel
  runs don't collide.

## Cleanup after a failed run

If the `finally` block didn't run (e.g. you Ctrl-C'd a test) you'll have
orphan test clocks in your Stripe account. Clean them up via the Stripe CLI:

```bash
stripe --api-key $E2E_STRIPE_TEST_SECRET_KEY \
  test_helpers test_clocks list --limit 50 | jq -r '.data[].id' \
  | xargs -I{} stripe --api-key $E2E_STRIPE_TEST_SECRET_KEY test_helpers test_clocks delete {}
```

Or scope by name prefix to avoid wiping clocks from other test runs.

## Manual gates blocking the stubbed scenarios

The four stubbed scenarios (plan-change, cancel-at-period-end, hard-cancel,
failed-payment-recovery) are blocked on the same set of manual ops gates
called out in `PRD_OwlBooks_Subscription_Billing-plan.md` (T33):

1. Stripe test mode credentials populated in `.env.test`.
2. Saleor `owlbooks` channel + Basic/Pro variants seeded.
3. Production `ALTER TYPE SubscriptionStatus` enum extension applied.
4. T18a part 2 migration script run against the test environment.

Once those gates are satisfied, replace the `test.fixme(true, ...)` line in
each stub with the real implementation; the helper modules already cover
test clocks, customers, Saleor polling, and signed storefront calls.
