# Stripe app marketplace readiness

<!-- cspell:words Mattscoinage chargebacks -->

**Date:** 2026-10-25  
**Related product requirements:** [Mattscoinage curated marketplace PRD](https://github.com/matteius/mattscoinage/blob/main/docs/marketplace-prd.md)

## Current state

The fork includes upstream Stripe app 2.12.0, plus custom Fief-linked subscription billing and MongoDB-backed app persistence. `APL=mongodb` is the Saleor **Auth Persistence Layer** setting. The MongoDB repositories scope configuration and transaction records by Saleor installation and app ID; APL is not a seller authorization system. The app handles buyer payment intents, captures, cancellations, refunds, and Stripe webhooks. It does not create Stripe Connect accounts, transfers, or seller payouts.

The curated marketplace pilot does not need Connect transfers: Mattscoinage collects the buyer payment, keeps an auditable seller settlement ledger, and executes operator-approved settlements manually. The existing Stripe app must continue to treat the buyer payment as one Saleor transaction; the marketplace service attributes order lines to sellers.

## Next payment capabilities

1. **Pilot reconciliation:** Link the existing Saleor order and Stripe payment references to seller-attributed order lines. Record refunds, disputes, fees, commission, and settlement adjustments in a separate marketplace ledger. Reconcile from confirmed server-side events; never infer settlement from a browser redirect.
2. **Connect onboarding:** Add a connected account link to each approved seller only after merchant-of-record and regional eligibility decisions. Keep seller bank and identity data in Stripe, not Saleor product attributes or Fief tokens.
3. **Transfer orchestration:** If a cart can contain multiple sellers, evaluate Stripe's [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers). Use one buyer charge, explicit per-seller transfer amounts, stable idempotency keys, and a reconciliation record for each transfer. Transfer only after payment success and the configured operator approval/hold policy.
4. **Exceptions:** Handle asynchronous payment failure, partial and full refunds, disputes, seller suspension, unavailable balance, failed transfers, and transfer reversals. Stripe says a refund of the platform charge does not automatically reverse associated transfers.
5. **Operations:** Give operators a review queue and immutable audit history before enabling automated payouts. Alert on any order, refund, transfer, or settlement imbalance.

## Release gates for Connect

- Product decision on merchant of record, seller custody/shipping, supported countries and currencies, commission, and settlement timing.
- Stripe Connect account and payout capabilities verified for the chosen regions; legal and tax review completed.
- Tests for multi-seller orders, single-seller orders, duplicate/out-of-order webhooks, partial refunds, disputes, transfer failure, retry, and suspension.
- Staging reconciliation across Saleor, Stripe, and the seller ledger; no live transfer until an operator has reviewed the first cohort.

Saleor's [marketplace recipe](https://docs.saleor.io/recipes/marketplace) treats seller payouts as an asynchronous service after buyer payment. Stripe's [Connect guide](https://docs.stripe.com/connect/separate-charges-and-transfers) documents the platform's responsibility for fees, refunds, and chargebacks with separate charges and transfers. This document is an implementation direction, not a statement that the current Stripe app already supports those flows.
