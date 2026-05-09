<!-- cspell:disable -->
# Saleor App — Fief

Saleor App that integrates with [Fief](https://github.com/opensensor/opensensor-fief)
(our hardened OpenSensor fork) for storefront customer SSO and bidirectional
identity sync. Together with the in-process Saleor `BasePlugin` shipped in
`/saleor/plugins/fief/` (this repo's Saleor server tree), it delegates
storefront authentication to Fief and keeps Saleor customers in lockstep with
the Fief user directory.

> Status: in active development on `feat/owlbooks-subscriptions`. The auth
> plane (T18–T21) and the sync plane (T22–T29) are implemented; reconciliation
> wiring (T31 repair use case, T32 cron runner) and the operator runbook (T45)
> are still pending. See [`PRD.md`](./PRD.md) and the architecture ADR
> ([`adr/0003-fief-app-architecture.md`](../../adr/0003-fief-app-architecture.md))
> for context.

---

## What it is

Fief is OpenSensor's authentication platform; Saleor is OpenSensor's commerce
platform. Without integration, customer identities live in both places
independently — and Fief's per-tenant entitlements (plan, role, claims) never
reach Saleor's storefront/checkout logic.

This app makes Fief the source of truth for storefront customer identity. It
provides:

- **Auth plane (Path A — see ADR 0003).** Four HTTPS endpoints
  (`/api/plugin/external-authentication-url`,
  `/api/plugin/external-obtain-access-tokens`,
  `/api/plugin/external-refresh`,
  `/api/plugin/external-logout`) that Saleor's `saleor.plugins.fief.FiefPlugin`
  (Python, in-process in Saleor) calls for every storefront login / refresh /
  logout. Authentication between the two sides is HMAC-SHA256 over a fixed
  signing string ([`src/modules/plugin-auth/hmac-verifier.ts`](./src/modules/plugin-auth/hmac-verifier.ts)
  on the apps/fief side; `saleor/plugins/fief/client.py` on the Saleor side).
- **Sync plane.** Inbound webhooks from Fief (`/api/webhooks/fief`) and the
  four Saleor customer webhooks (`CUSTOMER_CREATED`, `CUSTOMER_UPDATED`,
  `CUSTOMER_METADATA_UPDATED`, `CUSTOMER_DELETED`) keep both sides in sync.
  Loop prevention is enforced via an origin-marker invariant on every
  cross-side write ([`src/modules/sync/loop-guard.ts`](./src/modules/sync/loop-guard.ts)).
- **Claims projection.** Per-install operator-configured mappings project
  Fief claims into Saleor `metadata` (public) or `privateMetadata` (default,
  conservative).
- **Multi-config.** Each Saleor install gets its own per-connection Fief OIDC
  client (auto-provisioned on connection create), per-connection webhook
  signing secret, and per-connection branding signing key.
- **Mongo storage.** APL, connections, identity map, webhook log, DLQ all in
  Mongo (see ADR 0003 for the divergence-from-Dynamo justification).

The PRD is the authoritative product spec — read [`PRD.md`](./PRD.md) for
goals, non-goals, data model, SLOs, and the rollout plan.

---

## Quick start (local dev)

Time budget: a fresh engineer should reach `pnpm dev` + a successful
`/api/manifest` response in under 30 minutes.

### 1. Prerequisites

- Node.js 20+ (see root `package.json#engines`).
- `pnpm` (corepack-managed; the monorepo pins via `packageManager`).
- Docker + Docker Compose for MongoDB and (optionally) Fief.
- A running Saleor instance with the Fief plugin enabled
  (`/saleor/plugins/fief/`, T56/T57). For local dev you can point at the
  Saleor instance under `/home/matteius/mattscoinage/saleor/` — its
  `BUILTIN_PLUGINS` already includes `saleor.plugins.fief.plugin.FiefPlugin`
  (commit `953d310d76` on the saleor fork's `mattd-devops-29` branch).

### 2. Boot Mongo

There is no `apps/fief/docker-compose.yml` yet — Mongo is the only required
local service for the app itself, so:

```bash
docker run -d --name fief-mongo -p 27017:27017 mongo:7
```

Or, if you already have a docker-compose for the wider OpenSensor stack,
reuse that.

### 3. Boot Fief (optional for app boot, required for end-to-end)

Fief lives at `/home/matteius/mattscoinage/opensensor-fief/`. Its own
`docker-compose.yml` brings up Postgres + Redis (the Fief app itself runs
locally via `uv run`). For most apps/fief development you can skip this and
mock the Fief admin client at the use-case boundary; you only need a live
Fief tenant when manually exercising the connection-create flow (T17) or
the auth handlers end-to-end.

### 4. Configure environment

Copy the example and fill in required values:

```bash
cp apps/fief/.env.example apps/fief/.env.local
```

Required for boot (env validation fails fast — see
[`src/lib/env.ts`](./src/lib/env.ts)):

- `SECRET_KEY` — AES-256-CBC key, hex-encoded. Generate with
  `openssl rand -hex 32`.
- `FIEF_PLUGIN_HMAC_SECRET` — shared secret with the Saleor `BasePlugin`
  (T56/T57). Generate with `openssl rand -hex 32` and copy the same value
  into the Saleor plugin's `hmac_secret` configuration field.

Recommended for local dev:

- `APL=file` (the default) — APL writes to `.next/.saleor-app-auth.json`,
  no Mongo required for APL itself. Switch to `APL=mongodb` (and set
  `MONGODB_URL`, `MONGODB_DATABASE`) once you want to test the persistent
  storage path.
- `ALLOWED_DOMAIN_PATTERN=/.*/` for an open allowlist; tighten in
  staging/prod.
- `APP_LOG_LEVEL=debug` for verbose dev logs.

The full env reference is the source itself — see
[`src/lib/env.ts`](./src/lib/env.ts) (each variable has an inline doc-comment
naming the consuming task) and [`.env.example`](./.env.example) (operator-
facing summary).

### 5. Install + run

```bash
# From the saleor-apps repo root:
pnpm install
pnpm --filter saleor-app-fief dev
```

The dev server listens on `http://localhost:3000` (override with `PORT`).
Smoke test:

```bash
curl http://localhost:3000/api/manifest
```

This should return the app manifest (id `saleor.app.fief`, name `Fief`,
`requiredSaleorVersion ">=3.21 <4"`, `permissions: ["MANAGE_USERS"]`, the
configured webhooks, and a `tokenTargetUrl` pointing at `/api/register`).

If you get an `EnvValidationError` at boot, the message lists the missing
or invalid keys — double-check `SECRET_KEY` (hex, 32 bytes) and
`FIEF_PLUGIN_HMAC_SECRET` (non-empty).

---

## Architecture overview

```
                          ┌────────────────────────┐
                          │  Saleor Dashboard      │
                          │  (config iframe)       │
                          └────────────┬───────────┘
                                       │ tRPC
                                       ▼
┌────────────────────┐     ┌────────────────────────┐     ┌──────────────────┐
│ Saleor Core        │     │  apps/fief (Next.js)   │◀───▶│ opensensor-fief  │
│ saleor/plugins/    │HTTPS│                        │ Adm/│  (single tenant, │
│   fief/  (Path A)  │HMAC │  • plugin-auth/        │ OIDC│  domain branding)│
│   ↳ external_*     │◀───▶│  • saleor-auth/ routes │     └──────────────────┘
│     overrides      │     │  • Fief webhook recv   │              ▲
└────────────────────┘     │  • sync use cases      │              │ webhooks
        ▲                  │  • claim projection    │──────────────┘
        │ async            │  • identity map        │
        │ webhooks         │  • config UI / tRPC    │
        │ (CUSTOMER_*)     └──────────┬─────────────┘
        └─────────────────────────────┤
                                      ▼
                          ┌────────────────────────┐
                          │ MongoDB                │
                          │  apl, provider_        │
                          │  connections, identity │
                          │  _map, webhook_log,    │
                          │  dlq, reconciliation_  │
                          │  runs                  │
                          └────────────────────────┘
```

`apps/fief` is the **integration plane**: Mongo storage, Fief admin/OIDC
clients, sync use cases, dashboard UI. The `BasePlugin` at
`/saleor/plugins/fief/` is the **auth plane** (Path A); it intercepts
Saleor's `external_*` mutations in-process and delegates each to the
matching `apps/fief` HTTPS endpoint over HMAC-authenticated requests.

Why the split? Saleor 3.x exposes no `AUTH_*` sync webhooks (verified in
the T2 spike, [`spike-notes.md`](./spike-notes.md)). The `BasePlugin`
pattern is the only delegated-auth mechanism Saleor offers today. Full
context: ADR 0003.

Module layout under [`src/modules/`](./src/modules/):

- `apl/` — Mongo APL (ported from `apps/stripe/src/modules/apl/`).
- `crypto/` — AES-256-CBC at-rest encryption (T4).
- `db/` — Mongo singleton with serverless-safe pool reuse (T3).
- `fief-client/` — Fief admin API + OIDC client wrappers (T5/T6).
- `provider-connections/` — multi-config storage, lifecycle use cases
  (create/update/rotate-secret/delete; T8/T17), and the dashboard UI
  (T35/T36).
- `identity-map/` — `{saleorUserId} ↔ {fiefUserId}` Mongo repo (T10).
- `claims-mapping/` — pure projector (T14) and UI (T36).
- `branding/` — `branding_origin` HMAC signer (T15).
- `sync/` — loop guard (T13) and the cross-side use cases.
- `saleor/` — typed Saleor GraphQL client (T7) and the customer webhook
  handlers (T26–T29).
- `webhook-log/` — health view + DLQ (T11/T37).
- `webhook-management/` — manifest reconciliation runner (T49).
- `reconciliation/` — drift detector (T30); repair use case (T31, pending);
  scheduled runner (T32, pending).
- `plugin-auth/` — HMAC verifier for Path A (T58).
- `token-signing/` — claims-shaping helper consumed by the Saleor plugin
  (T55; deliberately small per T2's JWKS finding).
- `trpc/`, `channel-configuration/`, `queue/`, `dlq/` — supporting modules.

---

## How to install in a Saleor instance

1. **Enable the Fief plugin in Saleor.** In the Saleor server you're
   integrating against, ensure `saleor.plugins.fief.plugin.FiefPlugin` is
   in `BUILTIN_PLUGINS` (already true for the OpenSensor fork — see
   `/saleor/saleor/settings.py`). Configure the plugin in the Saleor
   admin UI:
   - `apps_fief_base_url` — public base URL where this app is reachable
     (e.g. `https://fief-app.opensensor.io` in prod, or
     `http://host.docker.internal:3000` if Saleor runs in Docker locally
     and apps/fief runs on the host).
   - `hmac_secret` — same value as `FIEF_PLUGIN_HMAC_SECRET` in this app's
     env.
   - `default_connection_id` — leave empty for now; T57 adds per-channel
     connection routing in a follow-up.
2. **Install the app via the Saleor dashboard.** From the dashboard's
   "Apps" page → "Install external app" → paste the manifest URL
   (`https://<app-host>/api/manifest`). Saleor will POST to
   `/api/register`, the install allowlist (`ALLOWED_DOMAIN_PATTERN`) is
   checked, and the APL row is written. T49's manifest-reconciliation
   runner fires automatically and registers the customer-side async
   webhooks.
3. **Configure a Fief connection.** Open the app from the Saleor dashboard
   → see "Add a connection" below.

---

## How to add a connection

The dashboard iframe at `src/pages/configuration.tsx` exposes three tabs:
**Connections**, **Channel scope**, **Claims mapping**.

1. **Connections → New Connection.** Fill:
   - **Fief tenant URL** — e.g. `https://auth.opensensor.io`.
   - **Admin API token** — a Fief admin token with permission to create
     OIDC clients and webhook subscribers (per-install scoping is up to
     the operator).
   - **OIDC client name** — display name for the client this app will
     create on Fief's side (e.g. `Saleor — shop.opensensor.io`).
   - **Branding allowed-origins** — list of storefront origins that can
     sign `branding_origin` for this connection (one per line). Fief's
     branding extension verifies this list before applying brand
     overrides (see `opensensor-fief/fief/services/branding/origin_verifier.py`,
     T46).
2. **Save.** The `CreateConnectionUseCase` (T17,
   [`src/modules/provider-connections/use-cases/create-connection.use-case.ts`](./src/modules/provider-connections/use-cases/create-connection.use-case.ts))
   does, in order:
   - Generates a 32-byte branding signing key (lowercase hex; T15
     wire-format).
   - Calls Fief admin API to create the OIDC client (T5).
   - Calls Fief admin API to create the per-install webhook subscriber
     pointing at `/api/webhooks/fief?connectionId=<id>` (T5).
   - Encrypts every secret slot with `SECRET_KEY` (T4).
   - Persists the connection in Mongo (T8).
   - Patches the Fief webhook URL with the real connection id once the
     persist round-trip completes.
   On any failure mid-flow, the use case best-effort-rolls back the Fief
   client + webhook so we don't leak orphans.
3. **Test connection.** The connection form's "Test connection" panel
   calls `connections.testConnection.useMutation` (independent of form
   submit so its loading state doesn't block save). Failures surface
   inline.
4. **Configure claims mapping (optional).** **Claims mapping tab** →
   pick the connection → add rows of
   `{ fiefClaim, saleorMetadataKey, visibility, reverseSyncEnabled }`.
   Defaults: `visibility: "private"`, `reverseSyncEnabled: false`.
   Switching visibility to `"public"` surfaces a PII warning inline.
5. **Configure channel scope (optional).** **Channel scope tab** → pick
   the install-wide default Fief connection, then optionally add
   per-channel overrides (e.g. one channel → connection A, another →
   `disabled`). The disable action holds in a confirm-modal to prevent
   accidental disables.
6. **Rotate secrets (when needed).** **Connections → Rotate** runs a
   two-step rotation
   ([`rotate-connection-secret.use-case.ts`](./src/modules/provider-connections/use-cases/rotate-connection-secret.use-case.ts)):
   - **Stage 1 — initiate.** Provisions a new webhook signing secret on
     Fief, stashes the encrypted ciphertext into `encryptedPendingWebhookSecret`,
     and surfaces the plaintext one-time so the operator can copy it
     into any external monitoring. The OIDC client secret can be
     `operator-supplied` (rolled out-of-band in Fief's admin UI, since
     Fief 0.x has no rotate endpoint) or `locally-generated` (32 random
     bytes hex; primarily for testing the dual-secret window).
   - **Stage 2 — confirm.** Promotes pending → current and revokes the
     old. T6 / T22 keep both secrets accepted between stages so
     in-flight events don't drop.
7. **Soft-delete a connection.** **Connections → Delete.** Revokes the
   Fief OIDC client + webhook subscriber, then soft-deletes the local
   connection record (`softDeletedAt` set; identity_map preserved for
   audit per ADR 0003 §6).

---

## Operational notes

### Environment variables

The single source of truth is [`src/lib/env.ts`](./src/lib/env.ts) — every
variable has a doc-comment naming the consuming task. The operator-facing
copy lives in [`.env.example`](./.env.example). Required at runtime:
`SECRET_KEY`, `FIEF_PLUGIN_HMAC_SECRET`. Optional with sensible defaults:
`APL` (default `file`), `APP_LOG_LEVEL` (default `info`),
`ALLOWED_DOMAIN_PATTERN` (default `/*/`), `MANIFEST_APP_ID`
(default `saleor.app.fief`), `APP_NAME` (default `Fief`).

### Kill switches (T54)

Two env-driven incident-response flags
([`src/lib/kill-switches.ts`](./src/lib/kill-switches.ts)):

- `FIEF_SYNC_DISABLED=true` — short-circuits the inbound Fief webhook
  receiver (T22). Use when a Fief misconfiguration is causing storms
  inbound.
- `FIEF_SALEOR_TO_FIEF_DISABLED=true` — suppresses the four Saleor →
  Fief outbound handlers (T26–T29) and the reconciliation push path
  (T32, when shipped).

Both default `false`. Toggle without redeploy by setting the env on the
hosting platform and restarting the relevant pod/instance. Operator
playbook (matching alerts → which switch → recovery steps) lives in
`RUNBOOK.md` (T45, **pending**).

### Reconciliation cron (T32 — pending)

The plan provisions a reconciliation runner gated by a `CRON_SECRET`
bearer header at `POST /api/cron/reconcile`. Per-connection sequential
walk; per-connection concurrent-run guard; honors the kill switches;
records run history in a `reconciliation_runs` Mongo collection.

T30 (drift detector) and T31's repair-via-existing-sync-use-cases shape
are the planned input/output sides; the HTTP route + scheduler glue is
what T32 still owes. Until T32 lands, drift is not detected automatically
— operators rely on the dashboard's webhook health screen (T37) and the
DLQ for visibility, and trigger reconciliation manually (planned UI
control in T38).

### Logging

Per-request structured logging via
[`src/lib/logger.ts`](./src/lib/logger.ts) +
[`src/lib/logger-context.ts`](./src/lib/logger-context.ts). Every webhook
route and tRPC procedure should be wrapped with
`compose(withLoggerContext, withSaleorApiUrlAttributes)(handler)` so each
log line carries `correlationId`, `saleorApiUrl`, `saleorEvent`, and
`path`. The `appInternalTracer` shim
([`src/lib/tracing.ts`](./src/lib/tracing.ts)) is a no-op stand-in for
OpenTelemetry; if/when the team adopts OTel the swap is a single-file
rewrite (see T47 log).

---

## Pointers

- [`PRD.md`](./PRD.md) — product requirements, data model, SLOs, rollout
  plan, open questions.
- [`spike-notes.md`](./spike-notes.md) — T2 research notes documenting
  why the Path A pivot was needed (no `AUTH_*` webhooks in Saleor 3.x).
- [`../../adr/0003-fief-app-architecture.md`](../../adr/0003-fief-app-architecture.md)
  — Architecture Decision Record covering the eight key decisions.
- `RUNBOOK.md` — operational playbook for Phase 0 deploy and incident
  response. **Pending (T45).**
- The Saleor-side Python plugin lives at `/saleor/saleor/plugins/fief/`
  (commit `953d310d76` on the saleor fork's `mattd-devops-29` branch).
