<!-- cspell:disable -->
---
"saleor-app-fief": minor
---

Add the new Saleor App for Fief — a single-sign-on and identity-sync bridge between Saleor storefronts and Fief, OpenSensor's authentication platform.

**Before.** Customer accounts existed independently in Saleor and Fief. A shopper signing in to two OpenSensor storefronts had to remember two passwords, and even within one storefront the Saleor customer record and the Fief user record drifted out of lockstep — Fief's per-tenant entitlements (plan, role, claims) never reached Saleor's checkout, and changes made in either system did not propagate to the other. Operators had no way to verify who was logged in, no way to map Fief claims onto Saleor metadata, and no way to roll a leaked secret without breaking in-flight sessions.

**After.** Storefront customers sign in with their Fief identity. The app owns four HTTPS auth-plane endpoints that the new in-process Saleor `BasePlugin` (`/saleor/plugins/fief/`) calls for every login, token refresh, and logout — plugin-to-app calls are HMAC-SHA256 signed end-to-end. Identity-sync runs in both directions: Fief webhooks (`user.created`, `user.updated`, `user.deleted`) project into Saleor customers; Saleor customer webhooks (`CUSTOMER_CREATED`/`UPDATED`/`METADATA_UPDATED`/`DELETED`) push back to Fief. An origin-marker loop guard on every cross-side write means changes never echo back into the system that originated them. Per-install operator-configured claim mappings project Fief claims into Saleor `metadata` (public) or `privateMetadata` (default, conservative). Each connection auto-provisions its own Fief OIDC client, webhook signing secret, and branding signing key from the dashboard, with two-step rotation so secrets can be rolled without dropping in-flight events. Storage is on MongoDB (APL, connections, identity map, webhook log, DLQ); kill-switch env vars (`FIEF_SYNC_DISABLED`, `FIEF_SALEOR_TO_FIEF_DISABLED`) gate inbound and outbound sync independently for incident response. The first release ships in five rollout phases — see `apps/fief/RUNBOOK.md` for the per-phase deploy + rollback procedures.

This is the initial release of `saleor-app-fief`; the package is private and rolled out internally only until phase 5.
