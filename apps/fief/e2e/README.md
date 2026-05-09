<!-- cspell:disable -->

# T42 — Full SSO + bidirectional sync E2E

Two run modes:

## Mocked mode (CI gate)

Runs on every PR via `pnpm --filter saleor-app-fief e2e`.

- `mongodb-memory-server` for storage.
- msw intercepts the Fief OIDC + admin endpoints.
- An in-memory `SaleorFake` implements the narrow `SaleorCustomerClient`
  surface the use cases consume.

This run exercises:

- T18 (`/api/auth/external-authentication-url`) → asserts the authorize URL
  embeds a signed `branding_origin` the verifier accepts.
- T19 (`/api/auth/external-obtain-access-tokens`) → asserts a Saleor customer
  is created, identity_map is bound, and Fief claims project into Saleor
  metadata + privateMetadata.
- T27 (`CustomerUpdatedUseCase`) → asserts a Saleor mutation patches the Fief
  user via T5's admin client (msw-observed PATCH `/admin/api/users/{id}`).
- T23 (`UserUpsertUseCase`) → asserts a Fief user mutation propagates back
  into Saleor's metadata + privateMetadata.
- T11 DLQ — final assertion that no entries land in the DLQ across the full
  flow.
- T13 loop guard — final assertion that `lastSyncSeq` is strictly monotonic
  across the round trip (proxy for "no loop events").
- T46 branding — final assertion that the verifier accepts the
  authorize-URL `branding_origin`.

## Live mode (manual run; production-rollout gate)

Not automated. Run before each Phase rollout per RUNBOOK (T45):

1. Bring up an opensensor-fief instance with the T46 branding extension
   live, and a Saleor staging tenant with the BasePlugin + apps/fief
   installed.
2. Provision a `ProviderConnection` via the dashboard tRPC `connections.create`
   procedure (or via the apps/fief admin tab — same use case wiring).
3. Drive a real storefront login through Saleor's `external_authentication_url`
   plugin hook → asserts the storefront ends up on Fief's branded `/authorize`
   page.
4. Complete authentication in Fief, return to the storefront, and confirm
   `external_obtain_access_tokens` succeeds — the Saleor customer should
   exist and bear the projected `fief_*` metadata keys.
5. Mutate the Saleor customer via dashboard → confirm the Fief admin sees
   the change (within T52's queue cycle, ≤ 1s).
6. Mutate the Fief user via Fief admin → confirm the Saleor customer's
   metadata reflects the change.
7. Inspect the DLQ tab in the apps/fief dashboard (T37) — no entries
   should appear.

The mocked-mode run is the architectural gate; the live run is the
operational gate.
