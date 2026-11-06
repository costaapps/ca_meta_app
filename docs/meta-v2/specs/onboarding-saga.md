# SPEC · Meta onboarding session and finalization saga

Status: implemented (acceptance gate pending). Issue: [#45](https://github.com/costaapps/ca_meta_app/issues/45). ADR: [ADR-012](../adrs/ADR-012-m4-03-onboarding-saga.md). Contracts: [OpenAPI onboarding routes](../contracts/openapi.yaml); [M4.01 flow configuration](meta-onboarding.md); [M4.02 Graph transport](meta-graph-client.md). Functional owner: Meta integration. Evidence SHA: pending package commit.

## Problem and behavior

Create an onboarding aggregate bound to a verified portal principal, the tenant resolved from that session's active membership, the original portal session, and one exact Meta flow/configuration. The provider callback or code submission only accepts that aggregate's short-lived one-use state. A durable worker exchanges the code once, verifies and persists assets through the credential/catalog boundaries, applies subscriptions, and emits the connection projection. Browser return, callback redirect and HTTP acceptance are not readiness evidence.

Five server flow/auth pairs remain distinct: Facebook Login for Business; Instagram through Facebook Login; Instagram Login; WhatsApp Cloud API Embedded Signup; and WhatsApp Business App Coexistence. Callback route slugs are specific to each exact flow/auth pair.

## Invariants and authorization

- Tenant and principal authority come only from a verified portal session and current server-side membership. `company_uuid`, tenant IDs in callback queries, provider asset IDs and browser state are never authority.
- State is a random opaque HMAC-derived value bound to tenant, tenant-context digest, principal, portal session, idempotency/request digests, onboarding ID and exact config. Persist only its SHA-256 digest; expire after ten minutes and consume once.
- Callback correlation queries by the state digest, then compares the callback slug to the stored flow/auth variants exactly. Callback tenant parameters are ignored. Mismatch, unknown state, replay and expiry cannot accept a code.
- Provider authorization codes are sealed with AES-256-GCM under a derived key and context-bound AAD. The database stores a short-lived encrypted envelope, not cleartext; the worker atomically consumes the envelope and NULLs nonce/ciphertext/tag before the single exchange call. Durable job payloads contain only `codeRef`.
- At callback/code submission, recovery enqueue and immediately before each worker provider effect, the original active portal session and current owner/admin/operator membership are checked. Worker config must exactly match the pinned config/auth/capability-manifest/Graph version.
- Ambiguous effects become `UNKNOWN`/`RECONCILE`; never retry blindly. A typed `NO_EFFECT` can receive at most one bounded automatic retry for downstream stages. `RESUME` is an explicit user action for a downstream stage proven to have no effect. Authorization exchange never reuses a consumed code.
- `READY` requires an authorization reference, at least one verified asset, a subscription reference, a projection reference, and all four successful step checkpoints. Zero assets and failed subscriptions stay partial.
- Cancellation/expiry only updates this onboarding aggregate and safe-redirects to the portal return route. It does not delete prior connections or assets.

## Contract and data

M4.03 extends the persisted onboarding row with pinned M4.01 configuration/auth/manifest/Graph context and a safe saga checkpoint. Migration `202611060014-m4-03-onboarding-saga` (schema 16) adds the composite tenant/session key, recovery `RESUME` next action and `ca_meta_onboarding_codes` encrypted-envelope table.

- `POST /api/v1/onboarding-sessions/{id}/authorization-code` accepts a closed, bounded body and `Idempotency-Key`; it returns only a durable job reference.
- `GET /api/v1/meta/{variant}/callback` accepts the exact route variant, one state and optional provider code/error; raw callback values are neither echoed nor logged by application request logging. Redirect is fixed to `/oauth/return?onboardingRef=...` with no-store/no-referrer headers.
- `POST /api/v1/onboarding-sessions/{id}/actions` accepts `{action, stage}`. `RECONCILE` is only a read-only adapter check for `UNKNOWN`/stale `RUNNING`. `RESUME` is only for `RETRY_PENDING` asset, subscription or projection stages; it cannot resume authorization exchange. The request is transactionally bound to current actor, exact session/config and durable job idempotency.
- `GET /api/v1/onboarding-sessions/{id}` remains the authoritative status response. `nextAction=RECONCILE` and `nextAction=RESUME` are server instructions, not hints to relaunch provider auth.

Provider IDs are resolved from the server-side asset catalog. Credential persistence belongs to M3.07's vault; business projections belong to the connection/asset boundary. The adapter returns only internal references, never raw token values or provider payloads.

## Scenarios and acceptance evidence

| Criterion | Implementation and focused evidence |
|---|---|
| M4.03.AC01 callback with a different tenant/session/flow/config is rejected | State lookup ignores tenant query fields; exact callback flow/auth comparisons; M4.03 callback mismatch tests and recovery actor SQL checks. |
| M4.03.AC02 replay/duplicate does not authorize twice or repeat completed steps | State/code are one-use; encrypted-envelope insert, durable job and idempotency share a transaction; stable job key; M4.03 MariaDB test. |
| M4.03.AC03 empty assets or subscription failure never reaches READY | Asset reference set must be nonempty; READY check is evidence-gated; focused empty-assets and subscription retry tests. |
| M4.03.AC04 partial work has status and a safe next action | Checkpoints report `RECONCILE`, `RESUME`, `REAUTHORIZE` or `CHECK_STATUS`; explicit recovery endpoint queues one safe action; tests cover reconcile NO_EFFECT then resume without another exchange. |
| M4.03.AC05 cancellation returns safely without affecting an earlier connection | Callback cancellation consumes/cancels only matching onboarding state and redirects to the fixed portal return route; no connection deletion path exists here. |

Additional focused cases cover encrypted-code AAD, exact Instagram/WhatsApp variant mismatch, replay protection, pre-effect session/membership revocation, and stable subscription retry. MariaDB fixtures use generated tenant/principal/session IDs and synthetic values; they delete only those fixture rows in `finally`.

## Migrations, rollout and recovery

Run migration 16 only through the established migration runner against the dedicated migration identity. It expands the existing onboarding action enum and adds the code-envelope table. No production DDL or provider credential was used for implementation. Recovery jobs are inserted atomically with the state transition and use the M2.05 durable job idempotency key. Reconciliation never resubmits a code or mutation; an applied result merges only allowlisted internal evidence, `NO_EFFECT` sets `RESUME` for downstream stages or `REAUTHORIZE` for authorization, and unresolved results remain `UNKNOWN`.

## Validation and evidence

Harness: [`tools/m4-03/README.md`](../../../tools/m4-03/README.md). Focused command: `npm run test:m4-03 --workspace=@ca-meta/api`. It compiles to a private temporary directory and runs touched M3.05 onboarding regression, M4.03 saga, MariaDB-gated integration and migration-unit specs sequentially. The database tests run only with the disposable M2.05 MariaDB profile and `M2_DURABLE_WORK_TEST=1`.

Focused tests are authored but have not been run in this package worktree at coordinator request. Final compilation/test evidence must be attached by the coordinator to the exact integrated SHA. Real Meta OAuth, permission grants, app review, account/asset eligibility, provider adapter behavior and production callback routing are **Not confirmed**; no real Meta request or credential was used.
