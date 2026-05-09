<!-- cspell:disable -->
# 3. Fief Saleor App architecture

Date: 2026-05-09

## Status

Accepted

## Context

OpenSensor uses [Fief](https://github.com/opensensor/opensensor-fief) (our
hardened fork) as the authentication platform across all customer-facing
properties. We need Saleor-powered storefronts to authenticate customers
through Fief, project Fief claims into Saleor metadata, and keep both sides
in sync bidirectionally.

The product spec is `apps/fief/PRD.md`. Implementation lives in
`apps/fief/` plus a small Python `BasePlugin` at `/saleor/plugins/fief/`
in the Saleor server tree. This ADR records the architectural decisions
that shaped that split, the storage choice, the loop-prevention scheme,
and several semantic invariants that future contributors would otherwise
re-litigate.

This ADR is the canonical reference for every decision below; the PRD
documents what we're building, this ADR documents why it has the shape it
has.

## Decision

### 1. App-driven auth via the Saleor `BasePlugin` mechanism (Path A)

The auth plane is implemented as a Python `BasePlugin` subclass at
`saleor/plugins/fief/` (Saleor fork, commit `953d310d76` on
`mattd-devops-29`). The plugin overrides Saleor's five
`external_*` hooks (`external_authentication_url`,
`external_obtain_access_tokens`, `external_refresh`, `external_logout`,
`external_verify`) and delegates each to a matching HTTPS endpoint in
this app under `/api/plugin/external-*`. The plugin → app call is
authenticated by a shared HMAC-SHA256 secret
(`FIEF_PLUGIN_HMAC_SECRET`); see decision 1b.

**Why this shape and not the originally-planned `AUTH_*` sync webhooks**:
the T2 spike (`apps/fief/spike-notes.md`) verified — against the local
Saleor 3.23.4 source, the `@saleor/app-sdk@1.7.1` types, the public
`WebhookEventTypeSyncEnum` documentation, and the Saleor server's
`saleor/webhook/event_types.py` — that **no `AUTH_*` sync webhook events
exist in Saleor today**. The plan's premise that this would be a
purely-webhook-driven Saleor App is incompatible with how Saleor delegates
authentication. The `BasePlugin` external-* hooks are the only mechanism
Saleor actually exposes.

**Alternatives considered** (from the T2 spike's §9 recommendation
section):

- **Path B — Use the existing `saleor.plugins.openid_connect` plugin
  pointed at Fief, drop the auth plane from this app entirely, keep only
  the bidirectional sync + claims projection.** Rejected because the OIDC
  plugin is global per-Saleor-install (one OIDC config), which sacrifices
  the per-install branding-origin signing story (PRD §F5.1–F5.2), the
  per-channel connection routing (PRD §6 module: `channel-configuration/`),
  and the per-install OIDC client isolation that decision 2 below gives us.
- **Path C — Stub the auth-plane tasks, ship the rest of the app, wait
  for Saleor to land app-driven auth webhooks upstream.** Rejected:
  indeterminate timeline (no in-flight upstream PR found in the spike's
  GitHub-discussions sweep), and the storefront SSO experience the PRD
  promises doesn't survive the wait.

**Tradeoff accepted**: requires a small Saleor-side plugin in our fork,
not just a self-contained Saleor App. We pay that cost once at install
time (operator enables the plugin and supplies the shared HMAC secret).
The benefit is that we do not depend on Saleor adding a new webhook event
type to ship, and our pivot is internally-consistent with the only
delegated-auth mechanism Saleor has.

### 1b. HMAC-authenticated plugin → app calls

Authentication between the in-process Saleor plugin and the apps/fief
HTTPS endpoints is HMAC-SHA256 over the canonical sign string
`"{METHOD}\n{PATHNAME}\n{TS}\n{BODY_HEX}"`, with a 5-minute timestamp
skew window and constant-time signature comparison
(`crypto.timingSafeEqual`). The wire spec is locked byte-for-byte
between the Python signer (`saleor/plugins/fief/client.py`) and the Node
verifier (`apps/fief/src/modules/plugin-auth/hmac-verifier.ts`); both
sides carry an interoperability fixture that fails CI if the bytes drift.

A single install-level secret is used (not per-connection). Per-connection
HMAC is a deliberate v2: at the entry point of T18–T21 the channel-scope
resolution that picks a connection has not yet run, so per-connection
secrets would require a chicken-and-egg "resolve → re-verify" dance that
v1 trades for operational simplicity (T58 log).

### 2. Per-connection Fief OIDC clients

Each `ProviderConnection` row owns its own Fief OIDC client and its own
Fief webhook subscriber. `CreateConnectionUseCase`
(`src/modules/provider-connections/use-cases/create-connection.use-case.ts`)
provisions both via Fief's admin API on connection create.
`DeleteConnectionUseCase` revokes both on soft-delete (404 tolerated as
success — idempotent re-delete).

**Why per-connection, not one shared OIDC client per app install or per
Fief tenant**:

- **Audit isolation.** A compromised storefront's client secret only
  unlocks that storefront's customers. PRD §S6.
- **Independent rotation.** Rotating one connection's webhook signing
  secret or OIDC client secret does not require coordinating with
  unrelated storefronts. T17's `RotateConnectionSecretUseCase` runs the
  two-step lifecycle (publish new → confirm → revoke old) per-connection.
- **No shared-secret blast radius.** A misconfiguration on one connection
  cannot suspend the entire app's auth.

**Tradeoff accepted**: more Fief admin API calls during install (one
client + one webhook subscriber per connection). Acceptable since
connection creation is a low-frequency operator action; the Fief admin
client (T5) is a thin pinned wrapper, and the use case includes
best-effort rollback so a partial-failure mid-flow doesn't leak orphans.

### 3. Origin-marker loop guard for bidirectional sync

Every cross-side write tags the target row with two metadata fields,
defined in `src/modules/sync/loop-guard.ts`:

- `metadata.fief_sync_origin ∈ {"fief", "saleor"}` — public bucket so
  cross-side handlers without private-metadata access can still read it.
- `privateMetadata.fief_sync_seq` — monotonic per-identity sequence so
  out-of-order webhooks are discarded.

The opposite-direction handler short-circuits whenever
`incomingMarker.origin === processingSide` (loop) OR
`incomingMarker.seq <= lastSeenSeq` (out-of-order). Constants
`FIEF_SYNC_ORIGIN_KEY`, `FIEF_SYNC_SEQ_KEY` are exported and pinned.

**Why this scheme over alternatives** (timestamp comparison; per-row
locks; idempotency keys alone): timestamps are unreliable across
clock-skewed systems; locks add latency to the auth-hot path;
idempotency keys solve duplicate delivery but not the loop case where
a write *intentionally* generates a new event. The origin marker is
the only solution that's symmetric and stateless.

**Mandatory test coverage**: T13's pure unit suite covers the 4×3
matrix of (origins × seq orderings) plus the explicit
"this-would-have-looped-without-the-guard" case. T41 (integration tests,
**pending**) adds the cross-side end-to-end loop assertion against a
docker-compose Fief + mongodb-memory-server fixture. **Without the loop
test the guard is unverifiable**; T41 is the canary.

### 4. MongoDB over `saleor-apps`' default DynamoDB

The monorepo's CLAUDE.md describes DynamoDB (via
`@saleor/dynamo-config-repository`) as the canonical configuration
storage. We deliberately diverge: this app uses MongoDB throughout (APL,
provider connections, identity map, webhook log, DLQ, reconciliation
runs).

**Why diverge**:

- **OpenSensor uses Mongo across the rest of the stack.** Adopting
  Dynamo here would force a second operational primitive into a stack
  that already has one.
- **Existing prior art in the same monorepo.** `apps/stripe` ports a
  `MongoAPL` from `apps/stripe/src/modules/apl/mongodb-apl.ts` (commit
  `6fb2d449`, "Stripe app 2.6.5 with MongoDB APL ported from fork main").
  Our T3 reuses that pattern, so we're not setting precedent — we're
  following one.
- **Schema flexibility helps the multi-config and reconciliation
  shapes.** Provider connections carry nullable
  `pending*Secret` slots during rotation windows, claim-mapping arrays
  whose schema extends across tasks (T17 added `visibility` and
  `reverseSyncEnabled`), and reconciliation drift rows with
  task-evolving discriminators (`missing_in_saleor` /
  `orphaned_in_saleor` / `field_divergence` / `stale_mapping`). A
  document store accommodates this evolution without a migration per
  field; Dynamo's single-table modeling would force more upfront
  schema-design choices that we don't yet have evidence for.
- **Drop-in `mongodb-memory-server` for unit tests.** The pattern
  T3/T8/T10/T11 use boots an in-memory Mongo per test run — there's no
  equivalent in-process DynamoDB Local fixture without a JVM container.

**Tradeoff accepted**: divergence from the upstream `saleor-apps`
default. New contributors used to `@saleor/dynamo-config-repository`
will see a different repository pattern in this app — documented here so
they don't re-litigate the choice. The divergence is encapsulated in
`src/modules/db/`, `src/modules/apl/`, and the per-collection
repositories under `src/modules/{provider-connections, identity-map,
webhook-log, reconciliation}/repositories/mongodb/`; the rest of the
codebase consumes the repository abstractions, not Mongo directly.

### 5. Reconciliation in v1 (not deferred)

Bidirectional sync over webhooks alone has gap risks: Fief webhook
delivery failures, Saleor webhook delivery failures, in-flight
secret-rotation drops, schema drift on either side. Per-event
reconciliation catches drift before users notice it; deferring it past
v1 would mean operators discover drift via support tickets.

The plan therefore commits to reconciliation in v1, split into three
tasks: T30 (drift detector — **completed**), T31 (repair use case —
**pending**), T32 (scheduled runner + on-demand trigger — **pending**).

T31's invariant: it consumes drift rows and dispatches them to the
existing sync use cases (T23, T24, T25, T26, T27, T28, T29) — never
bypassing them. This means loop-guard, claims projection, and origin
marker are applied identically whether the trigger is a webhook or
reconciliation, removing an entire class of "reconciliation does X
slightly differently from sync" bugs.

T32's HTTP route is gated by the `CRON_SECRET` env var bearer header,
runs per connection sequentially with a per-connection concurrent-run
guard, records run history in a `reconciliation_runs` Mongo collection,
and **honors both kill switches** so an incident-response operator can
suspend reconciliation without redeploying.

**Pending caveat**: until T32 lands, drift is not detected automatically.
Until T31 lands, drift is observed but not repaired (T30 is read-only).
The dashboard's webhook health screen (T37) and the DLQ (T11/T51) are
the manual fallback in the interim.

### 6. `user.deleted` from Fief — deactivate, not hard-delete (PRD Q4)

When Fief sends `UserDeleted`, the Saleor handler (T24) deactivates the
Saleor customer (`isActive = false`) — it does NOT hard-delete the row.
The Saleor → Fief direction (T29) is symmetric: `CUSTOMER_DELETED` from
Saleor sends an admin-API patch that deactivates the Fief user, not a
delete.

**Why deactivate**:

- **Saleor side preserves order history.** Hard-deleting a customer who
  has placed orders breaks the order's foreign key in a way that the
  Saleor admin UI handles awkwardly (orders become orphaned of customer
  metadata). Deactivation is the soft-delete that keeps the audit trail.
- **Fief side preserves audit trail.** Same reason — login history,
  webhook-event provenance, and `LoginSession` rows all reference user
  IDs, and a hard-delete would either cascade (data loss) or break
  referential integrity.
- **Reactivation is a one-flag flip.** If the deletion was a mistake,
  the operator flips `isActive` back without re-creating the user.

**Tradeoff accepted**: GDPR-style "right to be forgotten" requests
require a separate operator-driven flow (manual hard-delete with cascade
to identity_map). PRD NG2 (no migration tooling for existing accounts)
defers that workflow; if/when the requirement materializes it should be
its own use case (`HardDeleteIdentityUseCase`) so the audit-friendly
default path stays default.

This was an open question (PRD §13 Q4) — confirmed before T24/T29
shipped.

### 7. Removing a claim mapping does not retroactively strip metadata
(PRD Q5)

When an operator removes a claim from the per-connection mapping
(T17 / T36), already-written `metadata` / `privateMetadata` keys in
Saleor are NOT retroactively deleted. Documented as the projector's
contract in T14:
`projectClaimsToSaleorMetadata(mapping, claims)` is total over the
mapping array — entries not in the mapping produce no Saleor write,
which means previously-written values stay in place.

**Why no retroactive strip**:

- **Simpler invariant.** "The projector only writes; it never deletes."
  is a one-line contract that's easy to test and easy to reason about.
- **Operators can still clean up manually.** If they really do want to
  scrub a previously-projected key, they delete it via Saleor's
  metadata-update mutation — same tool they'd use for any other
  customer-metadata edit.
- **Avoids an "uninstall" footgun.** A retroactive-strip default would
  mean removing a claim mapping silently mutates every customer's
  metadata in Saleor; an operator who intended to disable projection
  for *new* customers would get unexpected reads-without-keys for old
  ones. T14's "explicit removed-mapping test" pins this invariant.

**Tradeoff accepted**: an operator who specifically wants the
"remove-mapping → strip-existing-metadata" semantics has to do it as
two operations (remove the mapping, then run a one-off cleanup). T36's
UI could grow an opt-in cleanup affordance later — not in v1.

This was an open question (PRD §13 Q5) — provisional answer documented
here, may be revisited if operator feedback during the soak period
(PRD §11 Phase 5) shows surprise.

### 8. Path A is the pivot — alternatives B and C documented for
posterity

Decision 1 covered the headline pivot (Path A: BasePlugin + HTTPS
delegation) and named B and C as alternatives. Capturing the full
shape of all three here so future re-evaluation has the full menu:

| | **Path A (chosen)** | Path B | Path C |
|---|---|---|---|
| **Scope** | apps/fief = sync + UI; auth plane = Saleor `BasePlugin` (Python) calling apps/fief over HMAC HTTPS | apps/fief = sync + UI ONLY; auth = global `saleor.plugins.openid_connect` pointed at Fief | apps/fief = full PRD scope, but auth-plane handlers stubbed/disabled until Saleor ships `AUTH_*` webhooks |
| **Per-install OIDC client** | Yes (decision 2) | No — one global plugin instance per Saleor install | Yes (planned) |
| **Per-storefront branding** | Yes — signed `branding_origin` per connection (T15) | No — Fief sees one upstream OIDC client, brand from `Host` header | Yes (planned) |
| **Saleor-side code** | Small Python plugin in our fork (`saleor/plugins/fief/`) | None new (existing OIDC plugin) | None |
| **Upstream dependency** | None | None | Indeterminate — waits on Saleor product roadmap |
| **Time to ship** | Now | Now (but reduced scope) | Indefinite |

Path A wins because Path B sacrifices the per-storefront branding +
multi-config story (PRD §F5), and Path C is open-ended on time. Path A
keeps the architectural shape PRD §6 calls for while acknowledging the
dispatch surface is plugin hooks not webhooks.

If Saleor later ships `AUTH_*` sync webhook events, the migration from
Path A is mechanical: each Path A HTTPS endpoint becomes a webhook
handler, the Saleor plugin disappears, the HMAC verifier becomes a
Saleor-signature verifier (T48 already implements that for the customer
async webhooks). Identity-map, claims projection, sync, reconciliation,
and storage are all unaffected.

## Consequences

- **For new contributors**: this app diverges from the `saleor-apps`
  monorepo defaults in three places — Mongo (decision 4), an
  out-of-tree Saleor-side Python plugin (decision 1), and a
  not-Saleor-signed-but-our-own HMAC scheme between the plugin and
  this app (decision 1b). Read this ADR before changing any of them.
- **For Saleor upgrades**: track upstream for the introduction of
  `AUTH_*` sync webhook events. When they land, decision 1 should be
  revisited (the migration cost is bounded — see decision 8's last
  paragraph).
- **For operators**: secrets management is per-connection (decision 2)
  and rotation is two-step (T17). The kill switches (T54) are the
  incident-response surface; the runbook (T45, **pending**) documents
  which alert maps to which switch.
- **For PRD changes**: open questions Q4 (decisions 6) and Q5 (decision
  7) are now answered; future PRD revisions should update those
  sections in line with this ADR rather than re-opening the
  questions.

## References

- T2 spike — `apps/fief/spike-notes.md` (the verified-not-found
  finding for `AUTH_*` webhooks; the JWKS answer; the recommendation
  for Path A)
- PRD — `apps/fief/PRD.md` (especially §6 architecture, §13 open
  questions Q4 + Q5)
- README — `apps/fief/README.md` (operator-facing companion to this
  ADR)
- The plan — `fief-app-plan.md` (T1–T58 with logs of every
  implementation decision)
- Existing prior art for Mongo storage in this monorepo —
  `apps/stripe/src/modules/apl/mongodb-apl.ts` (commit `6fb2d449`)
- Saleor-side Python plugin —
  `/saleor/saleor/plugins/fief/` (saleor fork commit `953d310d76` on
  `mattd-devops-29`)
