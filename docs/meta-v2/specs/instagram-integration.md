# M4.09 — Instagram onboarding variants

**Issue:** [#51](https://github.com/costaapps/ca_meta_app/issues/51)
**Decision:** [ADR-016](../adrs/ADR-016-m4-09-instagram-variants.md)
**Related contracts:** [onboarding saga](onboarding-saga.md), [credential resolver](credential-resolver.md), [Meta Graph client](meta-graph-client.md), [Meta subscriptions](meta-subscriptions.md)

## Scope and status

This package keeps Instagram as one product journey with two distinct authentication variants. The baseline production choice remains Instagram via Facebook Login. Instagram Login stays an optional, separately configured variant; this decision does not enable or adopt it. The source adds an exact-variant saga adapter seam and offline contract harness. It is not registered in `ApiModule` because the initial authorization credential handle, vault enrollment, confirmed subscription provider and app-specific Meta evidence are not available.

Status: **implementation boundary ready; provider execution and external certification Not confirmed**. Synthetic provider tests do not show that either variant works for this app or any customer account.

## Exact variants

| Product journey | M4.03 callback variant | Onboarding auth variant | Persisted authorization tuple | Page relation |
|---|---|---|---|---|
| Instagram via Facebook Login | `INSTAGRAM_VIA_FACEBOOK_LOGIN` | `INSTAGRAM_VIA_FACEBOOK_LOGIN` | `INSTAGRAM` / `FACEBOOK_LOGIN_FOR_BUSINESS` | Required for every selected professional account |
| Instagram Login | `INSTAGRAM_LOGIN` | `INSTAGRAM_LOGIN` | `INSTAGRAM` / `INSTAGRAM_LOGIN` | Forbidden; direct login must not acquire an invented Page dependency |

The callback/onboarding value and persisted M3.06 credential tuple are different fields at different boundaries. `persistedInstagramAuthorizationVariant` expresses that explicit mapping. Neither string is a browser-selected credential family. The Graph host, app configuration, scopes, token family and grants must be resolved server-side for the exact variant. The adapter rejects known `instagram_business_*` scope examples from Facebook Login results and known `pages_*` / non-business Instagram scope examples from Instagram Login results. This is a cross-variant mixing guard only, not a required-scope list, app grant policy or proof of approval.

The Facebook Login variant's discovery example is Meta's `GET /me/accounts?fields=name,access_token,tasks,instagram_business_account` using a User Access Token. The collection says its result can include a Page Access Token acting on behalf of the linked Page and an Instagram professional-account ID. It excludes consumer Instagram accounts from this API path. This documents a request/response shape, not this application's Login for Business configuration, grants, exact Page-task eligibility or token lifecycle. Source: [Meta-maintained Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), consulted 2026-11-10.

The same collection has a separate Instagram Login section, with distinct `instagram_business_*` permission names and documented limitations such as no ads or tagging in the sample. These names are candidates in that collection, not app-approved scopes. Do not reuse them for Facebook Login. Source: [Meta-maintained Instagram Login folder](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login), consulted 2026-11-10.

The collection uses a version placeholder. Graph API version, app mode, review state, granted scopes, token exchange/refresh response, expiry, Page subscription endpoint/fields and actual webhook delivery are **Not confirmed** for this application.

## Trust and persistence

- M4.03 remains authoritative for the one-use code, state/session/tenant/config binding, retry rules and saga checkpoints. The Instagram adapter rejects any other flow/auth pair before provider access.
- Raw authorization codes and access tokens stay in the vault-owned provider path. The adapter's public saga result contains only an internal authorization UUID or account asset UUIDs. Discovery DTOs contain opaque credential metadata UUIDs, never token values.
- The complete discovery result must be available before `InstagramAccountStore.persistCompleteAccountSet` is called. Partial pagination, malformed IDs, duplicates, an invalid Page relationship or an incomplete store receipt cannot create a successful step.
- A zero-account result returns no asset references, leaving the M4.03 saga partial. A missing or incomplete subscription observation blocks projection and final readiness.
- Facebook Login accounts carry an internal `INSTAGRAM_TO_PAGE` relation to a Page asset owned by the same tenant, app configuration, environment and authorization. Page is a technical parent for this Instagram authorization, not a second Facebook product connection.
- Direct Instagram Login has no Page relation and must use its own Instagram Login credential configuration and grant set.
- Reconciliation is read-only. It never exchanges a code, retries a subscription write or uses a browser-provided provider ID.

The existing resolver needs an internal asset UUID for credential selection. Before any Instagram asset exists, the initial User Access Token cannot currently be resolved through that asset-bound path. M3.07 also has no tenant-scoped atomic credential-enrollment API for the initial token or Page/Instagram credential metadata. The Facebook Login discovery example therefore cannot be enabled by forwarding raw tokens or by reusing the Facebook product flow. Instagram subscriptions are fail-closed in M4.11; the typed port in this package cannot establish real subscription semantics.

## Readiness and recovery

| Observation | Adapter behavior |
|---|---|
| Wrong flow/auth pair | Reject before provider access |
| Authorization code may have been consumed but result is invalid/ambiguous | `UNKNOWN`; never replay the code |
| Discovery is partial, failed, malformed or ambiguous | Do not persist the set; keep the stage recoverable |
| No eligible professional accounts | Return an empty asset set; M4.03 remains partial/actionable |
| Facebook Login account is missing its Page asset relation | Reject before persistence |
| Direct Instagram Login has a Page relation | Reject before persistence |
| Subscription is missing, partial, unknown or covers a different asset set | Do not report subscription success or publish projection |
| Projection fails or is ambiguous | M4.03 remains partial/unknown and uses its existing recovery contract |

No request in this package sends a message, replies to a comment, creates a subscription or mutates another product's assets. Messaging/comment operations stay disabled until the exact operation grants, webhook subscriptions and supported response semantics are confirmed and implemented against the correct variant.

## Criteria and evidence

| Issue criterion | Local implementation/evidence | External status |
|---|---|---|
| AC01 — one production variant end-to-end; document the other | Variant-specific adapter and 14-case synthetic harness; no real provider call | Not met: no authorized Meta app/Sandbox evidence or configured provider adapter |
| AC02 — never exchange tokens, scopes or endpoints between variants | Exact flow/auth guard; explicit persisted-auth mapping; host/scope and Page-link distinction documented | App-specific exchange/grant evidence Not confirmed |
| AC03 — Facebook Login keeps Page relation; direct Login has none | Atomic-store port contract and negative/positive contract fixtures | Runtime persistence/vault integration not registered |
| AC04 — zero accounts or missing webhook is not ready | Zero returns empty refs; partial/unknown subscription fails closed before projection | Instagram subscription semantics and live webhook receipt Not confirmed |
| AC05 — messages/comments use the correct account credential and do not affect other products | This package adds no send/reply route; no cross-product mutation path is introduced | Not met: authorized message/comment Sandbox scenario and operation grants unavailable |

The local harness is `node tools/m4-09/run-focused-test.mjs`; it uses only synthetic data, TypeScript compilation and Node's test runner. Execution evidence must be recorded by the M4 coordinator on the rebased candidate SHA. **Not run by this implementation agent**, per the coordinator's single-gate plan.

## Required enablement evidence

Before registration or release, provide current official/provider evidence and an authorized Sandbox for each enabled variant: exact app configuration and Graph version; callback/exchange contract; initial user credential resolution and atomic vault enrollment; granted scopes and operation-to-grant mapping; verified professional account/Page linkage; token health/expiry/revocation observations; supported subscription target and fields; webhook receipt; and consented message/comment behavior. Until these are available, the adapter remains unregistered and product operations remain unavailable.
