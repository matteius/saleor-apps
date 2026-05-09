<!-- cspell:disable -->
# Saleor App — Fief operational runbook

On-call playbook for the `saleor-app-fief` integration. Pair with:

- [`PRD.md`](./PRD.md) §11 (rollout plan), §9 (SLOs), §5.6 (operations).
- [`README.md`](./README.md) (env, local dev, "add a connection" walk-through).
- [`adr/0003-fief-app-architecture.md`](../../adr/0003-fief-app-architecture.md)
  for the architectural decisions underlying these procedures.
- The plan tasks referenced inline (e.g. `T22`, `T54`); see
  `/fief-app-plan.md` at the repo root for the full per-task log.

> **Status, 2026-05-09.** T22 (Fief webhook receiver), T17 (connection
> lifecycle + dual-secret rotation), T54 (kill switches), T35 (UI screens),
> T52 (outbound queue), T53 (Mongo migration runner) are merged on
> `feat/owlbooks-subscriptions`. **T31 (reconciliation repair use case),
> T32 (reconciliation cron runner), T37 (webhook health screen + DLQ
> viewer), T38 (reconciliation status UI), T51 (DLQ replay endpoint), T41
> (loop-prevention integration suite), and T42 (E2E SSO + bidirectional
> round trip) are NOT yet merged.** Procedures that depend on those tasks
> are flagged inline; in their absence, the fallback is the equivalent
> Mongo-shell or use-case-direct procedure documented under each scenario.

---

## 1. Rollout phases

Source: PRD §11. Each phase is gated on the prior phase's exit criteria
holding for at least one full business day with no on-call alerts.

### Phase 0 — App scaffold (DONE, T1)

**What ships.** Manifest endpoint (`/api/manifest`), register endpoint
(`/api/register`), Mongo APL (T3), empty webhook handlers, dashboard
skeleton. **Internal install only** — `ALLOWED_DOMAIN_PATTERN` set to a
single internal Saleor host.

**Prerequisites.**

- A Mongo database the app can write to (URL in `MONGODB_URL`, database
  name in `MONGODB_DATABASE`).
- `SECRET_KEY` (32-byte hex) provisioned in the deploy environment.
- `FIEF_PLUGIN_HMAC_SECRET` provisioned in BOTH the app deploy AND the
  Saleor deploy (the Saleor `BasePlugin` reads its copy from Saleor's
  plugin config — same value on both sides). Generate fresh with
  `openssl rand -hex 32`.
- `APL=mongodb` in the deploy environment.
- `ENV=staging` (or `production` for phase 5).

**Deploy command.**

```bash
# CI handles this on push to feat/owlbooks-subscriptions (and later, main).
# Manual fallback only if CI is wedged.
pnpm --filter saleor-app-fief build
# Image is pushed by GitHub Actions; deploy via the OpenSensor saleor-deploy
# helm chart (see infra repo).
```

**Validation.**

1. `curl https://<app-host>/api/manifest` returns the manifest JSON with
   the four auth endpoints declared.
2. Install the app on the staging Saleor instance from the Saleor
   dashboard. Manifest URL: `https://<app-host>/api/manifest`. The app
   should appear in the dashboard apps list with the iframe loading the
   placeholder configuration screen.
3. In Mongo, an `apl` document exists for the staging Saleor's
   `saleorApiUrl`. (`db.apl.findOne({ saleorApiUrl: "..." })`).
4. `/api/manifest` p50 latency < 50 ms (it's a static JSON serve).

**Rollback.**

- Uninstall the app from the Saleor dashboard. The `apl` row stays — that
  is intentional (re-install replays through the same row).
- For a hard reset: `db.apl.deleteOne({ saleorApiUrl: "..." })` then
  re-install.

### Phase 1 — Auth plane only (no sync)

**What ships.** The four auth endpoints (T18–T21), the Saleor `BasePlugin`
(T56–T57), HMAC verifier (T58). **No sync webhooks live**: Fief webhook
receiver (T22) is reachable but the sync handlers (T23/T24/T25/T26–T29)
are explicitly disabled via `FIEF_SYNC_DISABLED=true` and
`FIEF_SALEOR_TO_FIEF_DISABLED=true`.

**Prerequisites.**

- Phase 0 in production for at least 1 business day.
- One staging storefront connected to the staging Saleor (`react-storefront`).
- A small allowlist of Fief users (~5 internal accounts) on the staging
  Fief tenant. Allowlist is enforced at the Fief side (only these users
  can complete the OIDC consent screen).
- A `ProviderConnection` configured in the dashboard (T35 UI) with the
  Fief tenant URL and a freshly-rotated webhook signing secret.
- Both kill-switch env vars set to `true`. Confirm:
  ```bash
  # In the app pod
  echo "$FIEF_SYNC_DISABLED $FIEF_SALEOR_TO_FIEF_DISABLED"
  # → "true true"
  ```

**Deploy command.** Same as phase 0; the gating change is the env-var
flip.

**Validation.**

1. Storefront login for one allowlisted Fief user completes end-to-end
   (browser opens Fief consent screen → returns to storefront → Saleor
   GraphQL `me` query returns the customer).
2. Latency budgets hold against PRD §9. The reference benchmarks from
   T40's integration suite (`mongodb-memory-server` + msw OIDC) sit
   far inside budget — they are not production numbers but they prove
   the code path itself is fast enough that any production p95 miss
   points at the Fief tenant or network, not the app:

   | Endpoint                              | T40 p95 (in-mem) | PRD §9 budget |
   | ------------------------------------- | ---------------- | ------------- |
   | `/api/plugin/external-authentication-url`   | 0.81 ms          | 200 ms        |
   | `/api/plugin/external-obtain-access-tokens` | 2.50 ms          | 600 ms        |
   | `/api/plugin/external-refresh`              | 1.07 ms          | 300 ms        |
   | `/api/plugin/external-logout`               | 1.18 ms          | 200 ms        |

   The in-memory benchmarks beat budget by ~100–250×; production p95
   should land in the 20–80 ms range against a co-located staging Fief.
   If production p95 exceeds the budget, the cause is upstream
   (Fief / Mongo / network), NOT this app's code path — investigate the
   Fief tenant first.
3. Connection-pool invariant: `getConnectCallCount()` test in T40
   passes; in production, the Mongo client metric `connections.current`
   plateaus rather than ramps over a 24-hour window.
4. The `webhook_log` collection contains zero `fief_to_saleor` rows
   (sync is gated off).

**Rollback.**

1. Disable the plugin in the Saleor dashboard (Plugins → Fief → toggle
   off). Storefront falls back to native Saleor auth.
2. App pods can stay running; auth-plane endpoints will return 503 once
   `FIEF_SYNC_DISABLED=true` is set globally (defense in depth) but
   they do not need to be torn down.

### Phase 2 — Fief→Saleor sync + claim projection

**What ships.** T22 receiver dispatching to T23/T24/T25 sync handlers,
T13 origin-marker loop guard, T14 claims projection.

**Prerequisites.**

- Phase 1 in production for at least 1 business day with zero
  auth-webhook errors.
- T41 loop-prevention integration suite green on `main` (currently
  pending — see "Open dependencies" below).
- Per-connection claim-mapping rules configured in the dashboard
  (T36).
- `FIEF_SYNC_DISABLED=false` (clear the env var or set to `false`).
  `FIEF_SALEOR_TO_FIEF_DISABLED` stays `true` for this phase.

**Deploy command.** Same as phase 0; gating change is the env-var flip.

**Validation.**

1. Fief admin → modify a test user's profile → corresponding Saleor
   customer updates within PRD §9's 5-second budget. Inspect via
   `db.identity_map.findOne({ fiefUserId: "..." })` to confirm the row
   updated.
2. `webhook_log` shows the inbound `fief_to_saleor` events with
   `status: "ok"`.
3. **Loop-guard canary.** The T41 suite includes a test that fails
   immediately if the origin marker is missing from any handler's
   write path. CI on `main` must be green. If T41 is not yet on `main`
   when this phase deploys, run the canary manually: in staging, push
   one Saleor change (via the Saleor UI), wait 10 seconds, then assert
   the resulting Fief webhook was DROPPED (not re-applied) by querying
   `webhook_log`: the row should have `status: "loop-suppressed"`. If
   the count of inbound Fief events grows monotonically while you do
   nothing, you have a loop — kill-switch immediately (see "Sync loop
   detected" below).

**Rollback.**

1. Set `FIEF_SYNC_DISABLED=true`, redeploy. The receiver returns 503;
   queued inbound work drains naturally.
2. Re-enable phase 1's env-var gate on
   `FIEF_SALEOR_TO_FIEF_DISABLED` (still `true` for this phase, so no
   action).
3. Reconcile via T32 once root cause is fixed (see scenario playbooks).

### Phase 3 — Saleor→Fief sync (bidirectional in staging)

**What ships.** T26–T29 Saleor webhook handlers writing to T52's
outbound queue; T31 reconciliation repair use case (currently pending).

**Prerequisites.**

- Phase 2 in production for at least 1 business day with zero loop
  detections.
- T26–T29 + T52 worker booted via `instrumentation.ts`. (See
  `src/modules/queue/worker.ts` for the boot contract.)
- `FIEF_SALEOR_TO_FIEF_DISABLED=false`.

**Deploy command.** Same as phase 0; the env-var flip and the
`instrumentation.ts` worker boot are the gating changes.

**Validation.**

1. Saleor dashboard → modify a customer's email → the Fief user's
   email updates within 5 seconds. Inspect Fief admin to confirm.
2. `db.outbound_queue.find()` shows enqueued + drained jobs; no rows
   stuck > 5 minutes.
3. DLQ count (`db.webhook_log.count({ status: "dead" })`) holds at 0
   over a 4-hour soak.

**Rollback.**

1. `FIEF_SALEOR_TO_FIEF_DISABLED=true`, redeploy. T26–T29 return early
   without enqueueing; the worker drains the existing queue. Wait
   for `db.outbound_queue.estimatedDocumentCount() === 0` before
   considering the rollback complete.
2. If the DLQ has been growing during the incident, leave the
   rollback in place and triage the DLQ before re-enabling.

### Phase 4 — Per-install client provisioning, branding-origin signing, webhook health dashboard

**What ships.** T17's full provision flow (Fief OIDC client +
webhook subscriber per connection), T15 branding-origin signing,
T46 (Fief-side branding verifier — already merged in opensensor-fief),
T37 webhook health UI + DLQ viewer (currently pending).

**Prerequisites.**

- Phase 3 in production for at least 1 business day with zero DLQ
  growth.
- `opensensor-fief` deployed at a tag that includes T46 (commit on or
  after `1c88a67` for the audit + the impl follow-up).
- T37 health dashboard tested in staging.

**Deploy command.** Same as phase 0. T37 is a UI-only deploy; T15/T17
are already in code paths that previous phases exercised.

**Validation.**

1. Create a new connection from the dashboard → confirm a fresh Fief
   OIDC client AND a fresh webhook subscriber appear on the Fief side
   (`db.fief_clients.findOne(...)` on the Fief Postgres; webhooks via
   the Fief admin UI).
2. Storefront login renders the correct brand (verifies T15 signer +
   T46 verifier wire up). Tamper with the `branding_origin` query
   string → storefront falls back to default brand (silent failure;
   confirm via Fief logs).
3. T37 dashboard renders the last 50 webhook events for the test
   connection and decrypts payloads on click.

**Rollback.**

- T37 is a read-only UI; rolling back is "deploy the previous image"
  with no data implications.
- T15/T17 are already in code; no rollback needed for branding-origin
  signing — silent fallback to default brand on the Fief side means a
  malformed signing key never breaks login.

### Phase 5 — Production rollout to first storefront

**What ships.** `ALLOWED_DOMAIN_PATTERN` widened to include the first
production storefront's Saleor host. Allowlist on the Fief side is
removed (or expanded to all production users).

**Prerequisites.**

- Phase 4 in staging for at least 1 business week with zero P0/P1
  alerts.
- Operator runbook (this file) exercised at least once on staging
  with a fresh on-call engineer.
- T37 dashboard wired and bookmarked by on-call.
- T41 + T42 suites green on `main`.
- A documented incident-response Slack channel + paging rotation.

**Deploy command.** Same as phase 0. The change is environmental
(`ALLOWED_DOMAIN_PATTERN`) and Fief-side allowlist policy.

**Validation.**

1. Install the app on the production Saleor instance.
2. Soak window: 1 calendar week. Watch the four PRD §14 success
   metrics (logins-served, error rate, loops, propagation latency).
3. NO second-storefront rollout until soak is clean.

**Rollback.**

- `ALLOWED_DOMAIN_PATTERN` revert to the previous (staging-only)
  value. Production storefront falls back to native Saleor auth.
- Note that customers who logged in via Fief during the production
  window have their `identity_map` rows preserved — re-enabling the
  app picks up where it left off.

---

## 2. Incident playbooks

> **Naming convention.** Each scenario has the same four sections:
> **Symptoms** (what alerts you), **Verify** (how to confirm the
> diagnosis), **Stop the bleeding** (kill switch / circuit breaker
> step you take FIRST, before you understand the root cause), and
> **Recover** (how to bring the system back to health).

### 2.1 Fief unreachable

**Symptoms.**

- Auth-webhook error rate alert fires (PRD §9: `< 0.1%` budget).
- Storefront login spinner times out.
- 5xx rate on the Fief OIDC discovery / token endpoints.

**Verify.**

1. Hit Fief health: `curl https://<fief-host>/health` (Fief exposes a
   liveness probe — non-200 = Fief is down).
2. Check Fief status page (if maintained — link from the on-call
   wiki).
3. From the app pod: `curl https://<fief-host>/.well-known/openid-configuration`
   should return the discovery doc within 5 s. A timeout or 5xx
   confirms Fief is unreachable from the app's network position.

**Stop the bleeding.**

```bash
# Set in your secret manager / k8s env, then redeploy (or use a
# rolling restart that picks up the new env).
FIEF_SYNC_DISABLED=true
FIEF_SALEOR_TO_FIEF_DISABLED=true
```

This makes T22 (inbound) return 503 and T26–T29 (outbound) skip the
enqueue step. The Saleor `BasePlugin` (T56–T57) cannot be killed via
this app — disable it from the Saleor dashboard (Plugins → Fief →
toggle off) so storefront falls back to native auth. **The two flags
are independent — flipping `FIEF_SYNC_DISABLED` alone does NOT stop
outbound work.** Always flip both during a Fief outage.

**Recover.**

1. Wait for Fief health to return (`/health` 200 over 5 consecutive
   probes).
2. Clear (unset, or set to `false`) `FIEF_SYNC_DISABLED` and
   `FIEF_SALEOR_TO_FIEF_DISABLED`. Redeploy.
3. **Replay the DLQ via T51** (currently pending — see fallback
   below):
   ```bash
   # When T51 ships:
   curl -X POST https://<app-host>/api/dlq/replay \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -d '{ "connectionId": "...", "since": "<incident-start-iso>" }'
   ```
   **Fallback while T51 is pending.** Open a Mongo shell and triage
   manually: `db.webhook_log.find({ status: "dead", "metadata.lastError": /Fief/i })`.
   For each row, validate the connection is not soft-deleted
   (`db.app_config.connections.findOne({ id: row.connectionId, softDeletedAt: null })`),
   then either replay by hand (re-call the use case via a one-shot
   tRPC call from a dev shell) or accept the loss and document.
4. Run reconciliation via T32 (currently pending — see fallback) to
   re-converge any state that drifted while sync was disabled:
   ```bash
   # When T32 ships:
   curl -X POST https://<app-host>/api/cron/reconcile \
     -H "Authorization: Bearer $CRON_SECRET" \
     -d '{ "connectionId": "..." }'
   ```
   **Fallback while T32 is pending.** No automated reconciliation —
   accept that any Saleor changes made during the outage did not
   propagate to Fief, AND that Fief changes did not propagate to
   Saleor. If propagation is critical, replay the affected events
   from the Saleor / Fief audit logs by hand. Document in the
   post-mortem.

### 2.2 Mongo down

**Symptoms.**

- App pods report 5xx on every endpoint that touches the repo layer
  (i.e. all of T18–T22, T26–T29).
- `MongoClient` connect errors in the logs (`MongoNetworkError`).
- Saleor dashboard iframe shows a generic error.

**Verify.**

1. From the app pod (or any host with mongosh installed):
   ```bash
   mongosh "$MONGODB_URL" --eval 'db.adminCommand({ ping: 1 })'
   ```
   Non-`{ ok: 1 }` confirms Mongo is unreachable.
2. Cluster-side: check the managed-Mongo provider's status console.
3. App-side: `db.runCommand({ serverStatus: 1 }).connections.current`
   trend over the last hour — a sudden drop to 0 or rejection on
   connect = the cluster fell over.

**Stop the bleeding.**

```bash
FIEF_SYNC_DISABLED=true
FIEF_SALEOR_TO_FIEF_DISABLED=true
```

Flip both, redeploy. Without Mongo, the kill switches are the only
defense — every other path will throw a `MongoNetworkError` and get
captured in logs without any clean error response. The app will return
500s on the auth-plane endpoints regardless of the kill switches
(those endpoints need Mongo to load the connection). Disable the
Saleor `BasePlugin` from the dashboard so storefront falls back to
native auth. **Disable scheduled jobs**: the T32 cron (when shipped)
hammers Mongo — pause its schedule from the deploy platform until
Mongo is back.

**Recover.**

1. Wait for the Mongo cluster to recover (`mongosh ... db.adminCommand({ ping: 1 })`
   returns `{ ok: 1 }`).
2. Verify the indexes are present:
   ```js
   db.app_config.connections.getIndexes()
   db.identity_map.getIndexes()
   db.webhook_log.getIndexes()
   ```
   If any are missing (e.g. cluster restored from a backup that
   pre-dates the migration), restart one app pod — the T53 migration
   runner will re-apply on boot. The runner is idempotent and
   distributed-lock-protected; a parallel restart of all pods is
   safe.
3. Clear `FIEF_SYNC_DISABLED` and `FIEF_SALEOR_TO_FIEF_DISABLED`.
   Redeploy.
4. Re-enable the T32 cron (when shipped). **Run reconciliation
   immediately** (don't wait for the next scheduled tick) to catch
   anything that drifted during the outage:
   ```bash
   # When T32 ships, for each connection:
   curl -X POST https://<app-host>/api/cron/reconcile \
     -H "Authorization: Bearer $CRON_SECRET" \
     -d '{ "connectionId": "..." }'
   ```
5. Re-enable the Saleor `BasePlugin`.

### 2.3 Sync loop detected

The most dangerous failure mode. Identity-sync loops are silent — they
don't produce errors, they produce work. Without intervention they
saturate the Fief webhook subscriber, the app's outbound queue, and
the Saleor webhook delivery system.

**Symptoms.**

- `db.outbound_queue.estimatedDocumentCount()` ramping monotonically
  (alert: > 100 jobs pending for > 5 minutes).
- `db.webhook_log.count({ direction: "fief_to_saleor", status: "ok" })`
  growing at > 10/sec without operator activity.
- DLQ growing slowly (loops eventually exhaust retries on whatever
  field they're flapping).
- Identity-map rows (`db.identity_map.findOne({...})`) showing the
  same `updatedAt` timestamp advancing every few seconds without a
  user touching either side.

**Verify.**

1. Pick one suspect identity row:
   ```js
   db.identity_map.findOne({ fiefUserId: "<id>" })
   ```
   Check `lastOriginMarker.origin` and `lastOriginMarker.seq` — if
   the origin alternates between `fief` and `saleor` and `seq`
   increments faster than once per second, it's a loop.
2. Cross-check `webhook_log` for the same connection:
   ```js
   db.webhook_log.find({ connectionId: "...", direction: { $in: ["fief_to_saleor", "saleor_to_fief"] } })
     .sort({ receivedAt: -1 }).limit(20)
   ```
   Alternating directions on the same `(saleorUserId, fiefUserId)`
   pair = loop confirmed.

**Stop the bleeding.**

```bash
FIEF_SYNC_DISABLED=true
FIEF_SALEOR_TO_FIEF_DISABLED=true
```

Flip BOTH (one at a time will re-flap as soon as the queue drains).
Redeploy. The loop stops within seconds because both sides refuse
new sync work.

**Recover.**

1. Find the missing origin marker. Loops are caused by EXACTLY ONE
   of:
   - A new code path writes to one side without calling the
     loop-guard helper (`src/modules/sync/loop-guard.ts`) — every
     cross-side write must stamp the origin marker.
     `git log -p src/modules/sync/` for the last 7 days; look for
     write paths that bypass `withLoopGuard(...)`.
   - The origin marker is being stripped by an intermediate
     transform (e.g. an over-eager `redactProviderConnection` or a
     metadata-projection bug that drops keys).
   - Time-skew between app pods causes the `seq` comparison to flap
     (rare; only if `Date.now()` is wildly out of sync). Check pod
     clocks via `kubectl exec ... -- date`.
2. Fix the offending write path. Add a unit test in `src/modules/sync/`
   that proves the new path stamps the marker.
3. Redeploy.
4. Reset the affected identity rows so reconciliation has a clean
   baseline:
   ```js
   db.identity_map.updateMany(
     { /* affected rows */ },
     { $set: { lastOriginMarker: null } }
   )
   ```
5. Clear `FIEF_SYNC_DISABLED` and `FIEF_SALEOR_TO_FIEF_DISABLED`.
   Redeploy.
6. Run reconciliation (T32, when shipped) to re-converge. **Watch
   the queue depth for the next 10 minutes** — if it ramps again,
   the fix didn't work, kill-switch immediately and re-investigate.

### 2.4 DLQ overflow

**Symptoms.**

- Alert: `db.webhook_log.count({ status: "dead" })` > 100.
- T37 dashboard's DLQ viewer (when shipped) shows a backlog growing
  faster than operators are clearing it.
- Customers report stale state ("I changed my email and Saleor still
  shows the old one") — DLQ entries are events that ran out of
  retries.

**Verify.**

1. T37 dashboard (when shipped): Webhook health → DLQ tab. Filter by
   `connectionId` to scope.
2. Direct Mongo (always available, T37-independent):
   ```js
   db.webhook_log.aggregate([
     { $match: { status: "dead" } },
     { $group: { _id: "$metadata.lastErrorClass", count: { $sum: 1 } } },
     { $sort: { count: -1 } }
   ])
   ```
   Buckets the failures by error class (e.g.
   `RotateConnectionSecretFiefSyncFailedError`,
   `MongoNetworkError`, `FiefHttpError(404)`).

**Stop the bleeding.**

If the DLQ is growing because of a dependent system (Fief, Mongo,
Saleor GraphQL), stop the bleeding via that system's playbook above.
The DLQ itself is a buffer — it won't OOM the app — but a runaway
DLQ blocks the operator UI (T37 paginates over the collection) and
hides the signal in noise.

If the DLQ is growing because of a code bug, the kill switches are
your friend:

```bash
# Inbound failures (Fief webhooks dying):
FIEF_SYNC_DISABLED=true
# Outbound failures (Saleor → Fief queue dying):
FIEF_SALEOR_TO_FIEF_DISABLED=true
```

**Recover.**

1. **Triage by error class.** Group as in the verify step. Each
   class typically has ONE root cause:
   - `FiefHttpError(404)` — the connection's Fief client was deleted
     out from under us. Check `db.app_config.connections.findOne(...)`;
     if the connection itself is gone, these are orphan events and
     can be dropped (don't replay).
   - `MongoNetworkError` — was a Mongo blip; safe to bulk-replay
     once Mongo is healthy.
   - `LoopGuardRefusedError` — the loop guard correctly refused.
     Do NOT replay — replaying would re-introduce the loop. Mark as
     "intentionally suppressed" and drop.
   - `HmacVerifyFailedError` — Fief's webhook signing secret was
     rotated without a corresponding rotation on this side. Check
     T17's rotation state on the connection; if `pending` is set,
     promote it (call `confirmRotation`); otherwise initiate a fresh
     rotation. **Then replay** the affected DLQ entries — they were
     legit events that this side mis-rejected.
   - Any other class — a code bug. Open a hotfix PR; once merged,
     bulk-replay.
2. **Bulk-replay via T51** (currently pending — see fallback):
   ```bash
   # When T51 ships:
   curl -X POST https://<app-host>/api/dlq/replay \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -d '{ "filter": { "metadata.lastErrorClass": "MongoNetworkError" } }'
   ```
   **Fallback while T51 is pending.** Replay individual entries by
   re-calling the use case from a dev shell, or by re-POSTing the
   payload to the receiver endpoint with the original HMAC headers.
   T51 also enforces the "refuse replay against soft-deleted
   connection" guard — without T51, that guard is your responsibility
   to apply manually (check `softDeletedAt` before each replay).
3. **Document.** Post-incident, write up the bucket counts + which
   classes were replayed vs. dropped. Trend the DLQ depth back to 0
   over a 24-hour window.

### 2.5 Secret rotation aborted mid-flight

T17's rotation is a two-step:

1. `initiateRotation(...)` — provisions a NEW webhook secret +
   OIDC client secret on the Fief side, writes them to
   `encryptedPendingWebhookSecret` / `encryptedPendingClientSecret`
   on the connection record, and returns the new webhook secret in
   plaintext ONCE for the operator to copy (so they can configure
   any external system that signs with it).
2. `confirmRotation(...)` — promotes pending → current and revokes
   the old secret on the Fief side.

In the window between step 1 and step 2, BOTH the old and the new
webhook secret are accepted by T22 (the receiver tries pending first,
falls back to current). This is by design — Fief itself signs new
webhooks with the new secret as soon as `initiateRotation` returns,
and the dual-secret window means we accept those new-signed webhooks
while the operator finishes verification.

**Symptoms.**

- Operator started a rotation, then was interrupted (browser closed,
  pager went off).
- The connection record has `encryptedPendingWebhookSecret` set but
  `confirmRotation` was never called.
- Worse: the new secret was already configured into a downstream
  system (a CI job that signs test webhooks; an external integration)
  — and that downstream is now using a secret we haven't promoted.

**Verify.**

1. Check the connection state:
   ```js
   db.app_config.connections.findOne(
     { id: "<connection-id>" },
     {
       encryptedWebhookSecret: 1,
       encryptedPendingWebhookSecret: 1,
       encryptedClientSecret: 1,
       encryptedPendingClientSecret: 1,
       updatedAt: 1
     }
   )
   ```
   `encryptedPending*` set + `updatedAt` more than ~1 hour old =
   stalled rotation.
2. T35 UI shows "Pending rotation" badge on the connection.

**Stop the bleeding.**

The dual-secret window is itself the safety mechanism — webhooks
keep flowing because T22 accepts both secrets. **There is nothing to
"stop"** unless a downstream system started using the new secret
exclusively, in which case it's the legitimate signer and you must
either complete the rotation or accept a brief auth outage.

**Recover.** Two paths:

- **Complete the rotation.** From T35 UI, click "Confirm rotation"
  on the connection. This calls `confirmRotation`, which promotes
  pending → current and revokes the old secret on the Fief side.
  Webhooks signed with the old secret will now be rejected. This is
  the correct path if the new secret is already in use.
- **Discard the pending rotation.** **T17 does NOT currently
  expose a `cancelRotation` method.** The plan logs this as a known
  gap (search for "explicitly cancel; not modeled yet" in
  `rotate-connection-secret.use-case.ts`). Two workarounds:
  1. **If pending was NOT yet in production use** — clear the slot
     directly in Mongo, then revoke the unused new secret on the
     Fief side via the Fief admin UI. Pending is just data; nothing
     downstream depended on it yet:
     ```js
     db.app_config.connections.updateOne(
       { id: "<connection-id>" },
       {
         $unset: {
           encryptedPendingWebhookSecret: "",
           encryptedPendingClientSecret: "",
           pendingRotationStartedAt: ""
         }
       }
     )
     ```
     Then in the Fief admin: revoke the new OIDC client secret and
     delete the new webhook subscriber that `initiateRotation`
     provisioned. Revert the connection state back to single-secret
     operation.
  2. **If pending was already in production use** — you cannot
     safely discard. **Force-revoke via the Fief admin** (delete the
     new webhook subscriber and revoke the new OIDC client secret on
     the Fief side), then accept the brief auth outage as
     downstream systems re-authenticate against the old (still
     promoted) secret. Clear the pending slot in Mongo as in option
     1. Notify any operators who configured the new secret that
     they must re-fetch via a fresh `initiateRotation` cycle. This
     is the worst-case path; prefer "complete the rotation" if the
     new secret is in legitimate use.

A future task should land an explicit `cancelRotation` use case
that does the Fief revoke + Mongo clear atomically. Until then,
follow the manual procedure above.

---

## 3. Open dependencies (read me before you go on call)

These tasks are not yet on `main`. Procedures that depend on them
have a documented manual fallback above; if you trip a scenario that
requires one of them, expect the response to take longer.

| Task | What it gives you                          | Manual fallback                                                                 |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| T31  | Reconciliation repair use case             | Replay events from Saleor / Fief audit logs by hand; document drift in post-mortem. |
| T32  | Reconciliation cron + on-demand HTTP route | Same as T31 — no auto-reconciliation; document and accept drift.                |
| T37  | Webhook health screen + DLQ viewer         | Mongo aggregation queries (examples in §2.4).                                   |
| T38  | Reconciliation status UI                   | Read `reconciliation_runs` collection directly (when T32 lands).                |
| T41  | Loop-prevention integration suite          | Run the §2.3 manual canary on staging before promoting any sync code.           |
| T42  | E2E SSO + bidirectional round trip         | Phase 5 prerequisite — phase 5 cannot ship until T42 is green.                  |
| T51  | DLQ replay endpoint                        | Manual one-shot replay from a dev shell (examples in §2.1, §2.4).               |

Update this table as tasks land on `main`.

---

## 4. Self-review checklist (T45 acceptance)

Before this runbook is considered "ready for on-call", a fresh
engineer (someone who didn't write the integration) must walk through
each of the four §2 incident scenarios on staging:

- [ ] §2.1 Fief unreachable — flip both kill switches, observe receiver
  503s, replay one DLQ entry by hand, clear flags, confirm green.
- [ ] §2.2 Mongo down — kill staging Mongo, observe app behavior,
  flip kill switches, restore Mongo, observe migration runner re-applies,
  confirm green.
- [ ] §2.3 Sync loop detected — induce an artificial loop in staging
  (remove the loop-guard call from one handler in a feature branch,
  deploy, observe `outbound_queue` ramp, kill-switch, revert, replay).
- [ ] §2.4 DLQ overflow — push 200 synthetic dead entries via direct
  Mongo writes, run the §2.4 aggregation triage, replay the
  recoverable bucket.
- [ ] §2.5 Secret rotation aborted mid-flight — initiate a rotation,
  walk away, return after 1 hour, complete via the "Confirm rotation"
  UI path; separately, initiate then discard via the Mongo manual
  procedure.

Each walk-through that uncovers a step that's wrong / missing /
outdated should result in an edit to this file before the next
phase ships.
