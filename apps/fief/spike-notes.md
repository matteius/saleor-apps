<!-- cspell:disable -->
# T2 Spike: Saleor App-Driven Auth Webhooks — Findings

**Author**: T2 research agent
**Date**: 2026-05-09
**Saleor version targeted**: 3.23.4 (verified against `git describe --tags` in `/home/matteius/mattscoinage/saleor`, which prints `3.23.4-1-gec1c6cacc4`)
**Target source-of-truth files (cited inline below)**:
- Local schema: `/home/matteius/mattscoinage/saleor-apps/schema.graphql`
- Saleor app SDK: `/home/matteius/mattscoinage/saleor-apps/node_modules/@saleor/app-sdk@1.7.1`
- Saleor server: `/home/matteius/mattscoinage/saleor/saleor/`

---

## TL;DR (read this first — the plan's premise needs revision)

**The four `AUTH_*` sync webhooks the plan provisionally names — `AUTH_AUTHENTICATE_ME`, `AUTH_ISSUE_ACCESS_TOKENS`, `AUTH_REFRESH_ACCESS_TOKENS`, `AUTH_LOGOUT` — DO NOT EXIST in this Saleor version (3.23.4) or in the upstream `@saleor/app-sdk` 1.7.1. They are not in the GraphQL `WebhookEventTypeSyncEnum`, not in the SDK's `SyncWebhookEventType` union, not in the Saleor server's `WebhookEventSyncType` Python enum, and not on the public docs page for `WebhookEventTypeSyncEnum`. Saleor does not currently expose an "app-driven authentication" webhook surface.**

What Saleor *does* expose for delegating authentication is the **legacy plugin-based external-authentication mechanism** — five GraphQL mutations (`externalAuthenticationUrl`, `externalObtainAccessTokens`, `externalRefresh`, `externalLogout`, `externalVerify`), each taking a `pluginId: String!` parameter. These are dispatched by the `PluginManager` to a Python plugin that overrides hook methods. They are not webhooks; the plugin must be in-process Python code (e.g. `saleor.plugins.openid_connect`).

**JWKS answer (critical for T55): Saleor signs all access/refresh tokens INTERNALLY using its own RSA private key (RS256) and exposes them at `/.well-known/jwks.json`. An app does NOT need to expose a JWKS endpoint.** Even when the token claims are sourced from a plugin (e.g. OIDC), Saleor wraps them in its own JWT via `core.jwt.jwt_encode → jwt_manager.encode`. T55 should be sized as the **small** variant: a thin helper that returns user claims, not a token-signing module.

This means the auth-plane wave (T18–T21, T55) cannot be implemented as a Saleor App in this Saleor version. The plan needs to pivot to one of three options — see **§9 Recommendation** below.

---

## 1. Event names — verified-not-found

### 1.1 `WebhookEventTypeSyncEnum` (the GraphQL enum the plan references)

Source: `/home/matteius/mattscoinage/saleor-apps/schema.graphql:2287-2340`

The complete enum body (verbatim values):

```
PAYMENT_LIST_GATEWAYS, PAYMENT_AUTHORIZE, PAYMENT_CAPTURE, PAYMENT_REFUND,
PAYMENT_VOID, PAYMENT_CONFIRM, PAYMENT_PROCESS,
CHECKOUT_CALCULATE_TAXES, ORDER_CALCULATE_TAXES,
TRANSACTION_CHARGE_REQUESTED, TRANSACTION_REFUND_REQUESTED,
TRANSACTION_CANCELATION_REQUESTED,
SHIPPING_LIST_METHODS_FOR_CHECKOUT, CHECKOUT_FILTER_SHIPPING_METHODS,
ORDER_FILTER_SHIPPING_METHODS,
PAYMENT_GATEWAY_INITIALIZE_SESSION, TRANSACTION_INITIALIZE_SESSION,
TRANSACTION_PROCESS_SESSION,
LIST_STORED_PAYMENT_METHODS, STORED_PAYMENT_METHOD_DELETE_REQUESTED,
PAYMENT_GATEWAY_INITIALIZE_TOKENIZATION_SESSION,
PAYMENT_METHOD_INITIALIZE_TOKENIZATION_SESSION,
PAYMENT_METHOD_PROCESS_TOKENIZATION_SESSION
```

**No `AUTH_*` member exists.** Cross-checked against:
- `@saleor/app-sdk@1.7.1` `types.d.ts:34` (`SyncWebhookEventType`) — same list, no AUTH events.
- Saleor server `saleor/webhook/event_types.py:844-974` (`class WebhookEventSyncType`) — same list, no AUTH events.
- Public docs: <https://docs.saleor.io/api-reference/webhooks/enums/webhook-event-type-sync-enum> (verified via WebFetch on 2026-05-09) — same list, no AUTH events.

### 1.2 `WebhookEventTypeAsyncEnum` — also no app-driven auth events

Searched (`/home/matteius/mattscoinage/saleor-apps/schema.graphql:2352+`) — only the lifecycle async events the plan already calls out (`CUSTOMER_CREATED`, `CUSTOMER_UPDATED`, `CUSTOMER_DELETED`, `CUSTOMER_METADATA_UPDATED`, `ACCOUNT_*`, etc.). The `ACCOUNT_*` async events (`ACCOUNT_CONFIRMATION_REQUESTED`, `ACCOUNT_DELETE_REQUESTED`, etc.) are **outbound notifications** — they fire after Saleor performs an operation; they are not a hand-off point where the app issues tokens.

### 1.3 What Saleor *does* offer for auth delegation

Source: `/home/matteius/mattscoinage/saleor-apps/schema.graphql:21586-21628` (Mutation root) and `/home/matteius/mattscoinage/saleor/saleor/plugins/base_plugin.py:332,636-664`.

| GraphQL Mutation | Plugin hook method | Purpose |
|---|---|---|
| `externalAuthenticationUrl(pluginId, input: JSONString!)` | `external_authentication_url(data, request, previous_value) -> dict` | Build IdP authorize URL |
| `externalObtainAccessTokens(pluginId, input: JSONString!)` | `external_obtain_access_tokens(data, request, previous_value) -> ExternalAccessTokens` | Code exchange → Saleor tokens |
| `externalRefresh(pluginId, input: JSONString!)` | `external_refresh(data, request, previous_value) -> ExternalAccessTokens` | Refresh access token |
| `externalLogout(pluginId, input: JSONString!)` | `external_logout(data, request, previous_value) -> Any` | Revoke / sign out |
| `externalVerify(pluginId, input: JSONString!)` | `external_verify(data, request, previous_value) -> (User, dict)` | Validate inbound token |

These are **plugin hooks**, not webhooks. They run **in-process** in the Saleor Python server. The reference implementation is `saleor/plugins/openid_connect/plugin.py`.

There is **no** webhook-equivalent registered against these mutation paths in the schema. (Confirmed by grepping `webhookEventsInfo` directives near each mutation in the schema — none reference auth events.)

---

## 2. Per-event request/response details

Because the four named events do not exist as webhooks, sections 2.1–2.4 below document **the closest existing mechanism** (the plugin hooks) so the auth-plane tasks can be re-scoped. Anything labelled `(unverified — does not exist as a webhook)` must NOT be used as if it were authoritative.

### 2.1 `AUTH_AUTHENTICATE_ME` — DOES NOT EXIST (unverified)

- Closest analog: **no GraphQL-mutation analog exists** for an "is this user still authenticated?" sync webhook. Saleor authenticates each request itself by decoding the JWT bearer token (`saleor/core/auth.py` + `saleor/core/jwt.py`); validation is purely cryptographic against Saleor's own JWKS. The `me` query simply returns `info.context.user`.
- The `externalVerify` mutation is closest in spirit (`(User, dict) -> (User, dict)` plugin signature) but is **not invoked on every API request** — it is an explicit verify operation a client must call.
- **Open question** logged in §10.

### 2.2 `AUTH_ISSUE_ACCESS_TOKENS` — closest analog is `external_obtain_access_tokens` plugin hook

**GraphQL fragment / mutation**:
```graphql
mutation ExternalObtainAccessTokens($pluginId: String!, $input: JSONString!) {
  externalObtainAccessTokens(pluginId: $pluginId, input: $input) {
    token
    refreshToken
    csrfToken
    user { id email isStaff isActive metadata { key value } }
    errors { field message code }
  }
}
```
Source: `/home/matteius/mattscoinage/saleor-apps/schema.graphql:21595-21601`, `:32666-32680`.

**Request payload (what Saleor passes to the plugin hook `external_obtain_access_tokens(data, request, previous_value)`)**:
- `data`: a `dict` parsed from the client's `input: JSONString!`. Its shape is **plugin-defined**. The OIDC plugin expects `{"code": <oauth_code>, "state": <signed_state>}` (`/home/matteius/mattscoinage/saleor/saleor/plugins/openid_connect/plugin.py:284-321`).
- `request`: the Django/Saleor `SaleorContext` (HTTP request).
- `previous_value`: an `ExternalAccessTokens` dataclass passed through the plugin chain.

**Response shape** (`saleor/plugins/base_plugin.py:92-97`):
```python
@dataclass
class ExternalAccessTokens:
    token: str | None = None          # JWT access token, SALEOR-signed
    refresh_token: str | None = None  # JWT refresh token, SALEOR-signed
    csrf_token: str | None = None     # opaque CSRF for cookie-based refresh
    user: User | None = None          # ORM User instance (must exist in Saleor DB)
```

**Token format / claim structure**:
- `token` is a **Saleor-issued JWT**, RS256-signed with the server's private key. The OIDC plugin builds it via `create_jwt_token` (`saleor/plugins/openid_connect/utils.py:329-350`), which calls `jwt_user_payload(user, JWT_ACCESS_TYPE, exp_delta=None, additional_payload={"exp": id_payload["exp"], "oauth_access_key": access_token, ...}, token_owner=owner)` then `jwt_encode`.
- Mandatory claims (`saleor/core/jwt.py:32-66`):
  - `iat` (issued-at)
  - `iss` (issuer, from `jwt_manager.get_issuer()`)
  - `owner` (string identifying signer; `"saleor"` for native, plugin id for plugin-issued — e.g. `"mirumee.authentication.openidconnect"`)
  - `exp` (expiry — for OIDC pulled from upstream id-token; for native `settings.JWT_TTL_ACCESS`)
  - `token` (the Saleor-side `user.jwt_token_key`; must match user row at decode time — `saleor/core/jwt.py:125-137`)
  - `email`
  - `type` (`"access"` / `"refresh"` / `"thirdparty"` / `"confirm-email-change"`)
  - `user_id` (graphene global id, e.g. `VXNlcjox`)
  - `is_staff`
- Optional: `permissions` (list of permission codenames), `oauth_access_key` (kept by OIDC plugin so `externalVerify` can introspect upstream).

**Expiry semantics**:
- Plugin may set `additional_payload["exp"]` to the upstream IdP's expiry (OIDC plugin does this).
- Without `exp`, `jwt_encode` produces a token without expiry — clients still must refresh, but the JWT itself never expires cryptographically. **Recommendation: always set `exp`.**
- Saleor's `jwt_decode` does NOT verify `aud` by default (`saleor/core/jwt.py:81-83`).

**Error contract**:
- The plugin **raises `django.core.exceptions.ValidationError`** (`saleor/plugins/openid_connect/plugin.py:296-298, 312-313, 327-333, 344-346`).
- Saleor's `BaseMutation` machinery converts those to `errors: [AccountError!]!` on the response (`error_type_class = AccountError`, `error_type_field = "account_errors"` — `saleor/graphql/account/mutations/authentication/external_obtain_access_tokens.py:34-38`). `AccountError` has fields `field`, `message`, `code` (an `AccountErrorCode` enum value).
- Returning `ExternalAccessTokens(user=None, token=None, ...)` with empty errors is technically allowed by the type but logically meaningless — clients will treat absence-of-token as failure.

### 2.3 `AUTH_REFRESH_ACCESS_TOKENS` — closest analog is `external_refresh` plugin hook

**GraphQL fragment / mutation**:
```graphql
mutation ExternalRefresh($pluginId: String!, $input: JSONString!) {
  externalRefresh(pluginId: $pluginId, input: $input) {
    token refreshToken csrfToken
    user { id email }
    errors { field message code }
  }
}
```
Source: `/home/matteius/mattscoinage/saleor-apps/schema.graphql:21604-21610`, `:32683-32696`.

- **Plugin signature**: `external_refresh(data: dict, request: SaleorContext, previous_value: ExternalAccessTokens) -> ExternalAccessTokens` (`saleor/plugins/base_plugin.py:654-656`).
- **Request payload**: plugin-defined `data`. OIDC plugin reads `data["refreshToken"]` (or falls back to the `refreshToken` cookie) plus `data["csrfToken"]` (mandatory if cookie path used) — `saleor/plugins/openid_connect/plugin.py:435-440` and validation in `validate_refresh_token` (`utils.py:601+`).
- **Response shape**: same `ExternalAccessTokens` dataclass.
- **Error contract**: same `ValidationError` → `AccountError` mapping.

### 2.4 `AUTH_LOGOUT` — closest analog is `external_logout` plugin hook

**GraphQL fragment / mutation**:
```graphql
mutation ExternalLogout($pluginId: String!, $input: JSONString!) {
  externalLogout(pluginId: $pluginId, input: $input) {
    logoutData
    errors { field message code }
  }
}
```
Source: `/home/matteius/mattscoinage/saleor-apps/schema.graphql:21612-21619`, `:32700-32704`.

- **Plugin signature**: `external_logout(data: dict, request: SaleorContext, previous_value: dict) -> Any` (`saleor/plugins/base_plugin.py:641`).
- **Request payload**: plugin-defined `data`. OIDC plugin uses it to construct an end-session URL.
- **Response shape**: returns a `dict` (the `logoutData` field, JSON-encoded).
- Best-effort revoke; clients ignore the `dict`.

---

## 3. Sync webhook timeout (still relevant for the eight async customer webhooks the plan keeps)

**Saleor's sync-webhook deadline is `(2 s connect, 18 s read) = 20 s total`.**

Source (verified): `/home/matteius/mattscoinage/saleor/saleor/settings.py:1121-1129`:
```python
REQUESTS_CONN_EST_TIMEOUT = 2
WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT = 18
WEBHOOK_TIMEOUT = (REQUESTS_CONN_EST_TIMEOUT, WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT)
WEBHOOK_SYNC_TIMEOUT = (REQUESTS_CONN_EST_TIMEOUT, WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT)
```
And public docs (<https://docs.saleor.io/developer/extending/webhooks/troubleshooting>): "Saleor will wait a maximum of 20 seconds for the complete HTTP request round trip."

(This timeout would have applied to AUTH_* sync webhooks if they existed — and *does* apply if Saleor adopts them in a future version.)

---

## 4. JWKS / signing-key question — definitively answered

**Q (the T55 sizing question): "Does Saleor verify access tokens issued by the app against an app-exposed JWKS, or does Saleor sign internally?"**

**A: Saleor signs internally. The app does NOT need to expose a JWKS endpoint.**

Verification trail:

1. Saleor's `JWTManager` loads / generates an RSA private key (RS256) on boot — `/home/matteius/mattscoinage/saleor/saleor/core/jwt_manager.py:70-130`. `_ALG = "RS256"`.
2. `jwt_manager.encode(payload)` (called from `core.jwt.jwt_encode`) is the only path used to mint tokens; it always uses Saleor's own private key.
3. Saleor exposes the corresponding **public key** at `/.well-known/jwks.json` — `saleor/core/views.py:24-25` (`def jwks(request): return JsonResponse(get_jwt_manager().get_jwks())`) and `saleor/urls.py:52` (`re_path(r"^\.well-known/jwks.json$", jwks, name="jwks")`).
4. The OIDC plugin's `external_obtain_access_tokens` impl calls `create_tokens_from_oauth_payload(...)` which internally uses `create_jwt_token` → `jwt_encode` (`saleor/plugins/openid_connect/utils.py:579-598`, `:329-350`). The token returned is therefore Saleor-signed; the upstream IdP's JWKS is only used to **verify the inbound id_token from the IdP**, never to sign anything Saleor accepts.
5. `is_saleor_token()` (`saleor/core/jwt.py:140-149`) explicitly checks the `owner` claim equals `"saleor"`; tokens from plugins use a different `owner` value but are still RS256-signed by the *same* Saleor key.

**Implication for T55**: No JWKS endpoint, no key generation/persistence, no rotation. T55 collapses to a thin helper that maps Fief claims → an `ExternalAccessTokens`-shaped object (or, post-pivot, raw user payload — see §9). This is the **small** variant.

---

## 5. Worked example — `external_obtain_access_tokens` from a Fief code-exchange

This is what an analogous **plugin** implementation (NOT a webhook) would have to return. Treat as the worked example for the closest existing mechanism.

**Client → Saleor request:**
```graphql
mutation {
  externalObtainAccessTokens(
    pluginId: "opensensor.fief"
    input: "{\"code\":\"<auth_code_from_fief>\",\"state\":\"<state_from_authorize>\"}"
  ) {
    token
    refreshToken
    csrfToken
    user { id email isActive }
    errors { field message code }
  }
}
```

**Plugin (Python) does internally:**
```python
# 1. Parse code + state from `data` arg.
# 2. POST to Fief's /api/token (code exchange) -> { access_token, refresh_token, id_token, expires_in }
# 3. Fetch & verify Fief id_token against Fief JWKS -> claims.
# 4. get_or_create_user_from_payload(claims) -> Saleor User row (creates if absent).
# 5. tokens = create_tokens_from_oauth_payload(token_data, user, parsed_id_token, permissions, owner="opensensor.fief")
# 6. return ExternalAccessTokens(user=user, **tokens)
```

**Saleor → client response (success):**
```json
{
  "data": {
    "externalObtainAccessTokens": {
      "token": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJpYXQiOjE3MTUyMjAwMDAsImlzcyI6Imh0dHBzOi8vc2FsZW9yLmV4YW1wbGUuY29tIiwib3duZXIiOiJvcGVuc2Vuc29yLmZpZWYiLCJleHAiOjE3MTUyMjM2MDAsInR5cGUiOiJhY2Nlc3MiLCJ1c2VyX2lkIjoiVlhObGNqb3giLCJlbWFpbCI6ImpAZXhhbXBsZS5jb20iLCJpc19zdGFmZiI6ZmFsc2UsInRva2VuIjoiYWJjMTIzIiwib2F1dGhfYWNjZXNzX2tleSI6Ii4uLiJ9.<RS256-signature-by-Saleor>",
      "refreshToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.<...refresh-payload...>.<RS256-signature-by-Saleor>",
      "csrfToken": "f8a7b6c5d4e3...",
      "user": { "id": "VXNlcjox", "email": "j@example.com", "isActive": true },
      "errors": []
    }
  }
}
```

**Saleor → client response (failure path, e.g. bad code):**
```json
{
  "data": {
    "externalObtainAccessTokens": {
      "token": null,
      "refreshToken": null,
      "csrfToken": null,
      "user": null,
      "errors": [
        { "field": "code", "message": "Invalid grant", "code": "INVALID" }
      ]
    }
  }
}
```

`AccountErrorCode` enum values usable by the plugin: `INVALID`, `NOT_FOUND`, `REQUIRED`, `UNIQUE`, `OUT_OF_SCOPE_USER`, etc. (see `saleor/graphql/core/types/error_codes.py` if pivoting to plugin path).

---

## 6. Why webhook-driven auth doesn't exist yet — context

- Saleor has a stated direction of moving plugin functionality to webhooks (per multiple docs notes; see e.g. the deprecation banner on `WebhookPlugin`: "all webhook-related functionality will be moved from plugin to core modules"). However, the **auth plugin hooks have not been migrated** as of 3.23.4.
- We searched: schema, SDK types, server `event_types.py`, public docs page for `WebhookEventTypeSyncEnum`, Saleor CHANGELOG, Saleor GitHub discussions/issues — nothing that flips auth to webhook-mode.
- The PRD's premise that this is a "Saleor App" (i.e. webhook-driven, hosted as a Next.js service) is **incompatible** with how Saleor currently delegates authentication.

---

## 7. What this means for downstream tasks (auth-plane wave)

| Task | Original premise | Reality |
|---|---|---|
| T18 `AUTH_AUTHENTICATE_ME` handler | Sync webhook on every request | **No such webhook.** No drop-in Saleor mechanism for "validate every request via the app" — Saleor uses its own JWT machinery (`/.well-known/jwks.json`) for this. |
| T19 `AUTH_ISSUE_ACCESS_TOKENS` handler | Sync webhook for first-login | **No such webhook.** Closest is `externalObtainAccessTokens` mutation → `external_obtain_access_tokens` plugin hook (Python in-process). |
| T20 `AUTH_REFRESH_ACCESS_TOKENS` handler | Sync webhook for refresh | **No such webhook.** Closest is `externalRefresh` mutation → `external_refresh` plugin hook. |
| T21 `AUTH_LOGOUT` handler | Sync webhook for logout | **No such webhook.** Closest is `externalLogout` mutation → `external_logout` plugin hook. |
| T55 JWKS endpoint | "Maybe needed depending on T2" | **Not needed.** Saleor signs all tokens itself using its own JWKS. T55 collapses to a tiny claims-shaping helper. |

The four async customer-side webhooks the plan also depends on (`CUSTOMER_CREATED`, `CUSTOMER_UPDATED`, `CUSTOMER_DELETED`, `CUSTOMER_METADATA_UPDATED`) **do exist** in `WebhookEventTypeAsyncEnum` (verified in `schema.graphql:2588-2598`). The Saleor → Fief sync plane (T26-T29) is unaffected by this finding.

---

## 8. GraphQL fragment names (for codegen — once a path is chosen)

If we pivot to the existing plugin path, T7 (codegen) should generate these fragments/documents:

```graphql
# Fragment shared by external auth responses
fragment ExternalAccessTokensFields on ExternalObtainAccessTokens {
  token
  refreshToken
  csrfToken
  user { ...CustomerFields }
  errors { field message code }
}

fragment CustomerFields on User {
  id
  email
  firstName
  lastName
  isActive
  isStaff
  metadata { key value }
  privateMetadata { key value }
}

mutation ExternalObtainAccessTokens($pluginId: String!, $input: JSONString!) {
  externalObtainAccessTokens(pluginId: $pluginId, input: $input) {
    ...ExternalAccessTokensFields
  }
}

mutation ExternalRefresh($pluginId: String!, $input: JSONString!) {
  externalRefresh(pluginId: $pluginId, input: $input) {
    token refreshToken csrfToken
    user { ...CustomerFields }
    errors { field message code }
  }
}

mutation ExternalLogout($pluginId: String!, $input: JSONString!) {
  externalLogout(pluginId: $pluginId, input: $input) {
    logoutData
    errors { field message code }
  }
}

mutation ExternalVerify($pluginId: String!, $input: JSONString!) {
  externalVerify(pluginId: $pluginId, input: $input) {
    user { ...CustomerFields }
    isValid
    verifyData
    errors { field message code }
  }
}

mutation ExternalAuthenticationUrl($pluginId: String!, $input: JSONString!) {
  externalAuthenticationUrl(pluginId: $pluginId, input: $input) {
    authenticationData
    errors { field message code }
  }
}
```

These are what a *client* sends Saleor — they are not what an *app* receives.

---

## 9. Recommendation — three viable paths forward

This section is the spike's deliverable for plan-revision. **Pick one before unblocking T18-T21, T55.**

### Path A (preferred — matches plan intent best, requires Saleor-side change)

**Build the auth plane as a Python plugin in `opensensor-fief`-aware Saleor fork**, not as a Saleor App. Plugin lives in `saleor/plugins/fief/` (in this repo's `/saleor/`), implements `external_obtain_access_tokens`, `external_refresh`, `external_logout`, `external_verify`, and `external_authentication_url`. The plugin makes HTTPS calls out to a small Next.js app (this `apps/fief`) for **claim mapping & the customer/identity-map sync plane**, but the token exchange flow itself runs in the Saleor process.

Pros: Uses the only mechanism Saleor actually exposes today; no upstream changes.
Cons: Diverges from "this is a Saleor App"; requires shipping a Saleor patch alongside the app; auth plane runs in Python.

### Path B (idiomatic-app, narrower scope)

**Drop the auth plane from the app entirely.** Use the existing `saleor.plugins.openid_connect` plugin pointed at Fief (it already supports OIDC code-flow + JWKS verification). The app `apps/fief` then ONLY handles bidirectional user/claim sync (T22-T29, T30-T32) plus configuration UI.

Pros: Pure Saleor App, no Python coupling, no plan-blocking unknowns.
Cons: We lose the per-channel branding-origin / multi-config OIDC-client story the PRD calls out for the auth side; OIDC config becomes one global plugin instance.

### Path C (defer until upstream lands it)

**Wait for Saleor to ship app-driven auth webhooks.** Implement T18-T21 + T55 stubs, leave them off the manifest, ship the rest of the app, revisit when the webhooks materialize upstream.

Pros: Plan body untouched.
Cons: Indeterminate timeline; auth plane stays in plugin land indefinitely; the storefront-side branding story is blocked.

**My recommendation: Path A.** Path B sacrifices the per-config branding requirement; Path C is open-ended. Path A keeps the architectural shape but acknowledges the dispatch surface is plugin-hooks not webhooks. The downstream task list would change like this:

- **T18-T21**: re-scoped from Next.js sync-webhook handlers to Python `BasePlugin` method overrides in a new `saleor/plugins/fief/` plugin (in `/home/matteius/mattscoinage/saleor/`). Each plugin method delegates HTTP call-out to `apps/fief` for connection lookup + claim projection + identity-map binding, then assembles the Saleor `ExternalAccessTokens` locally.
- **T55**: collapses to a ~50-line "claim shaper" inside the plugin (no signing).
- **T7 codegen**: still useful — for the **internal** call-out from plugin → app, where Mongo + claim mapping + identity_map live.
- **All async sync-plane tasks (T22-T32) are unaffected.**

---

## 10. Open Questions

- **OQ1**: Has Saleor 3.24+ or any unreleased branch added the `AUTH_*` webhook events? My searches against docs.saleor.io and the Saleor GitHub repo showed no RFC or in-flight PR for app-driven auth. Worth filing a question on `saleor/saleor` discussions before path-decision.
- **OQ2**: For Path A (plugin), how does the plugin authenticate its outbound HTTPS call to `apps/fief`? (Mutual TLS? Shared HMAC? Saleor doesn't have a built-in mechanism for this — it's a new design point.)
- **OQ3**: For Path A, the plugin would need access to the storefront's `branding_origin` query param. The OIDC plugin already plumbs `data` from the GraphQL `input` arg through; storefront would need to pass `branding_origin` inside that JSON. Verify storefront flexibility before committing.
- **OQ4**: `AUTH_AUTHENTICATE_ME` analog — there is no per-request hook a plugin or app can intercept (the closest is `BasePlugin.authenticate_user`, `saleor/plugins/base_plugin.py:332`, but that runs on every request and only provides a way to *replace* the resolved user, not to call out per-request). PRD §A.2's "live identity check on every me query" is not feasible without per-request plugin overhead — discuss with PRD author whether this requirement can be relaxed to "verified at issue time + checked on refresh".
- **OQ5**: The PRD refers to "p95 < 200ms for AUTH_AUTHENTICATE_ME". With no such webhook the budget is moot; if implementing OQ4 via a custom plugin hook, the per-request budget needs to be re-examined relative to Saleor's own per-request overhead (~5-15 ms baseline).

---

## 11. Sources

- Local Saleor 3.23.4 source — `/home/matteius/mattscoinage/saleor/`
- Local Saleor schema dump — `/home/matteius/mattscoinage/saleor-apps/schema.graphql` (38032 lines)
- `@saleor/app-sdk@1.7.1` — `/home/matteius/mattscoinage/saleor-apps/node_modules/@saleor/app-sdk/types.d.ts`
- Public docs (verified 2026-05-09):
  - <https://docs.saleor.io/api-reference/webhooks/enums/webhook-event-type-sync-enum>
  - <https://docs.saleor.io/api-usage/authentication>
  - <https://docs.saleor.io/api-reference/authentication/objects/external-obtain-access-tokens>
  - <https://docs.saleor.io/developer/extending/webhooks/synchronous-events/overview>
  - <https://docs.saleor.io/developer/extending/webhooks/troubleshooting>
- GitHub discussions reviewed: `saleor/saleor#10522` (external auth + sync), `saleor/saleor#11048` (M2M tokens), `saleor/saleor#11258` (payment-app RFC, mentioned plugin → webhook trajectory) — none describe app-driven auth webhooks.
