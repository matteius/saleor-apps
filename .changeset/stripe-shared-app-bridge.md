---
"saleor-app-payment-stripe": patch
---

Fix the Stripe app crashing on opening when shared components receive a different App Bridge context from the application.

Update vulnerable redirect and file-matching dependencies, and keep shared-package lint tooling out of production dependencies.
