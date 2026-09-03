---
"saleor-app-payment-stripe": minor
---

Add a service-authenticated Stripe Billing Meter bridge restricted to LightNVR's configured meter and Price, support SetupIntent client secrets and idempotent retries for zero-upfront and trial subscriptions, and wire the public subscription create, status, and billing-portal routes to an explicitly selected installed Saleor/Stripe configuration.
