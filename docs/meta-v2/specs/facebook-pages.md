# Facebook Pages via Login for Business

**Issue:** [#50](https://github.com/costaapps/ca_meta_app/issues/50)

**Decision:** [ADR-014](../adrs/ADR-014-m4-08-facebook-pages.md)

**Related contracts:** [onboarding saga](onboarding-saga.md), [Meta subscriptions](meta-subscriptions.md), [credential vault](credential-vault.md)

## Scope and exact variant

This flow is `FACEBOOK_LOGIN` / `FACEBOOK_LOGIN_FOR_BUSINESS`, persisted as `FACEBOOK` / `FACEBOOK_LOGIN_FOR_BUSINESS`. It is an independent Facebook journey. It does not reuse Instagram direct login, Instagram via Facebook, WhatsApp Embedded Signup, or WhatsApp Coexistence credentials or scopes.

The M4.03 callback and saga own one-use state/code checks, tenant/session/config binding, replay protection and recoverable stage checkpoints. `FacebookPagesOnboardingAdapter` rejects a context outside the exact Facebook pair before calling its provider port.

## Page discovery and credential boundary

The Meta-maintained [Facebook API collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api) documents `GET /me/accounts?fields=name,access_token,tasks` with a User Access Token and cursor pagination. Its response includes Page IDs, names, Page Access Tokens and tasks; its Page-token examples describe acting on behalf of a Page the user may manage. M4.04's typed MetaGraph method follows every cursor with bounded memory and only invokes its vault callback after the full result is known. The callback atomically enrolls per-Page credentials and returns opaque credential UUIDs; the M4.08 provider result contains only safe Page metadata and those refs. It never treats `debug_token.target_ids` as the Page catalog. This collection confirms the discovery shape only; it does not confirm this app's Login for Business grants or Page webhook subscription semantics.

Page IDs and tokens are provider-side values. Only server-created asset UUIDs are returned to the onboarding saga or accepted for selection. Page tokens are seen only by the typed Graph callback and a vault-owned atomic enrollment port; the asset store receives credential UUIDs to bind to the corresponding Page and exact tenant/authorization/configuration. Tokens must not enter results, audit events, logs or read models. OAuth token expiry, data-access expiry, token-health observations and scopes not returned by an authoritative provider observation stay `UNKNOWN`; no value is interpreted as “Never”.

The current M3.07 vault API stores secrets only after matching `ca_meta_credentials` metadata exists and has no tenant-scoped credential-enrollment API. The existing credential resolver also requires a verified internal asset authorization; it cannot resolve an initial user credential from an authorization UUID alone. `MetaGraphFacebookPagesProvider` therefore requires a server-owned resolver context plus the shared atomic vault enrollment primitive and is not registered in `ApiModule`. Missing context or enrollment returns a safe failure; no token or provider ID is returned to the caller.

Page `tasks` are retained only as role observations. They do not imply permissions or operation capability. `facebookPageCapabilitySnapshot` keeps page status, comments, and messages disabled with `PERMISSION_MAPPING_NOT_CONFIRMED` until M4.01 has an app-specific verified mapping and current grant evidence.

## Page selection and subscription

`PUT /api/v1/facebook/pages/authorizations/{authorizationId}/selection` and `GET` on the same route are guarded by the portal session and current tenant context. The GET path requires `RESOURCE_READ`; PUT also requires CSRF and `CONNECT`. PUT accepts only internal Page asset UUIDs in its body. The exact M4.11 catalog verifies tenant, app, environment, authorization, current Page grant and credential binding before it writes or removes desired bindings. The response returns internal asset UUIDs and readiness only. No schema migration is added.

The M4.11 provider explicitly returns `PAGE_SUBSCRIPTION_NOT_CONFIRMED` for Facebook Pages before making a Graph request. Exact Page subscription endpoint behavior, Page permission grants, subscribed fields, Graph-version support, and subscribe/unsubscribe semantics are **Not confirmed**. The desired binding remains recoverable in schema v18 and readiness remains `PARTIAL`; a desired binding is not provider evidence. Reconcile or disconnect affects only that Page authorization binding and cannot change WhatsApp templates or numbers.

## Readiness and failure behavior

| Condition | Persisted/result behavior |
|---|---|
| OAuth context is not the exact Facebook variant | Reject before provider access |
| Zero Pages | Return zero asset refs; M4.03 records a partial asset-verification stage and never reports success |
| Pagination is partial, malformed or repeats a cursor/ID | Do not persist the partial Page set; leave the stage recoverable |
| Page metadata or opaque credential mapping is malformed | Fail closed before Page asset persistence |
| Page enrollment lacks the tenant-scoped vault implementation | Remain partial; no raw SQL or synthetic credential metadata is created |
| User credential resolver cannot produce a verified server-owned handle | Fail closed with a safe provider error; do not call Graph or echo tokens |
| No Pages selected | Subscription stage remains partial; discovery never opts a Page in implicitly |
| Subscription permissions/fields are unconfirmed | Persist desired Page binding through M4.11, return `PARTIAL`, and make no Graph mutation |
| Projection port is unavailable | M4.03 projection stage remains partial |

The M4.03 onboarding status API still provides generic `PARTIAL`/`RESUME` or `RECONCILE` state. The separate Page selection/status endpoint reports `ACTION_REQUIRED` for an empty selection and `PARTIAL` while subscription evidence is unconfirmed.

## Evidence and external gates

- **Official source:** Meta's Facebook API collection documents `/me/accounts`, Page tokens, `tasks` and pagination. This does not confirm the current app's exact OAuth scopes, permission grants, Page eligibility, token expiry or data-access expiry.
- **Local contract:** `apps/api/src/meta-facebook/` supplies exact-variant orchestration, a token-safe typed Graph adapter, tenant/CSRF/session-guarded selection/status routes, and bounded all-pages-before-enrollment behavior. M4.11 stores Page selection/reconciliation intents in its existing generic tables.
- **Not confirmed:** App-specific Login for Business configuration, version, granted scopes, App Review, Page role requirements, token lifecycle, Page webhook endpoint/fields, external subscription behavior, live callback routing, and runtime tenant-scoped credential enrollment.
- No real Graph call, Meta credential, production subscription, customer asset or template/number was used.
