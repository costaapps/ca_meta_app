# Facebook Pages via Login for Business

**Issue:** [#50](https://github.com/costaapps/ca_meta_app/issues/50)

**Decision:** [ADR-014](../adrs/ADR-014-m4-08-facebook-pages.md)

**Related contracts:** [onboarding saga](onboarding-saga.md), [Meta subscriptions](meta-subscriptions.md), [credential vault](credential-vault.md)

## Scope and exact variant

This flow is `FACEBOOK_LOGIN` / `FACEBOOK_LOGIN_FOR_BUSINESS`, persisted as `FACEBOOK` / `FACEBOOK_LOGIN_FOR_BUSINESS`. It is an independent Facebook journey. It does not reuse Instagram direct login, Instagram via Facebook, WhatsApp Embedded Signup, or WhatsApp Coexistence credentials or scopes.

The M4.03 callback and saga own one-use state/code checks, tenant/session/config binding, replay protection and recoverable stage checkpoints. `FacebookPagesOnboardingAdapter` rejects a context outside the exact Facebook pair before calling its provider port.

## Page discovery and credential boundary

The Meta-maintained [Facebook API collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api) documents `GET /me/accounts` with `name,access_token,tasks`, a User Access Token, and cursor pagination. The collection describes the response as managed Pages and their Page Access Tokens. M4.08 uses a bounded collector that follows every cursor, rejects duplicate IDs/cursors and incomplete pages, and persists nothing until the full result is known. It never treats `debug_token.target_ids` as the Page catalog.

Page IDs and tokens are provider-side values. Only server-created asset UUIDs are returned to the onboarding saga or accepted for selection. The `FacebookPageAssetStore` port must persist each Page Access Token against that Page and exact tenant/authorization/configuration, with vault encryption, idempotent enrollment and authorization/asset binding. It must not put token values in results, audit events, logs or read models. OAuth token expiry, data-access expiry, token-health observations and scopes not returned by an authoritative provider observation stay `UNKNOWN`; no value is interpreted as “Never”.

The current M3.07 vault API stores secrets only after matching `ca_meta_credentials` metadata exists and has no tenant-scoped credential-enrollment API. Therefore no production Facebook credential store is registered by this package. The provider and asset-store ports have fail-closed defaults. Their integration and module registration require the shared enrollment primitive; synthetic ports are test-only.

Page `tasks` are retained only as role observations. They do not imply permissions or operation capability. `facebookPageCapabilitySnapshot` keeps page status, comments, and messages disabled with `PERMISSION_MAPPING_NOT_CONFIRMED` until M4.01 has an app-specific verified mapping and current grant evidence.

## Page selection and subscription

`FacebookPageSelectionService.replaceSelection` accepts only internal asset UUIDs and the M4.11 service verifies that each belongs to the exact tenant, app, environment and selected authorization. It writes desired state through the existing M4.11 target/binding tables. The generic catalog now recognizes only the exact tuple `FACEBOOK` + `FACEBOOK_LOGIN_FOR_BUSINESS` + `FACEBOOK_PAGE`; it resolves the Page object ID from the server catalog. No schema migration is added.

The M4.11 provider explicitly returns `PAGE_SUBSCRIPTION_NOT_CONFIRMED` for Facebook Pages before making a Graph request. Exact Page subscription endpoint behavior, Page permission grants, subscribed fields, Graph-version support, and subscribe/unsubscribe semantics are **Not confirmed**. The desired binding remains recoverable in schema v18 and readiness remains `PARTIAL`; a desired binding is not provider evidence. Reconcile or disconnect affects only that Page authorization binding and cannot change WhatsApp templates or numbers.

## Readiness and failure behavior

| Condition | Persisted/result behavior |
|---|---|
| OAuth context is not the exact Facebook variant | Reject before provider access |
| Zero Pages | Return zero asset refs; M4.03 records a partial asset-verification stage and never reports success |
| Pagination is partial, malformed or repeats a cursor/ID | Do not persist the partial Page set; leave the stage recoverable |
| Page token or task shape is invalid | Fail closed before asset enrollment |
| Page enrollment lacks the tenant-scoped vault implementation | Remain partial; no raw SQL or synthetic credential metadata is created |
| No Pages selected | Subscription stage remains partial; discovery never opts a Page in implicitly |
| Subscription permissions/fields are unconfirmed | Persist desired Page binding through M4.11, return `PARTIAL`, and make no Graph mutation |
| Projection port is unavailable | M4.03 projection stage remains partial |

The M4.03 status API currently provides generic `PARTIAL`/`RESUME` or `RECONCILE` state. It does not yet surface a Page-specific zero-results explanation or a Page-selection action. The Page selection service is an internal application service and has no HTTP controller in this package.

## Evidence and external gates

- **Official source:** Meta's Facebook API collection documents `/me/accounts`, Page tokens, `tasks` and pagination. This does not confirm the current app's exact OAuth scopes, permission grants, Page eligibility, token expiry or data-access expiry.
- **Local contract:** `apps/api/src/meta-facebook/` supplies exact-variant orchestration and bounded, all-pages-before-persist discovery. M4.11 stores Page selection/reconciliation intents in its existing generic tables.
- **Not confirmed:** App-specific Login for Business configuration, version, granted scopes, App Review, Page role requirements, token lifecycle, Page webhook endpoint/fields, external subscription behavior, live callback routing, and runtime tenant-scoped credential enrollment.
- No real Graph call, Meta credential, production subscription, customer asset or template/number was used.
