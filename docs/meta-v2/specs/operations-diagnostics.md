# Operational diagnostics — M5.10 / #65

**State:** implemented locally on `desktop/m5-10`; release and production evidence are **Not confirmed**.
**Contract:** [`openapi.yaml`](../contracts/openapi.yaml), operations endpoints and schemas.
**Portal:** `/status` shows a tenant-scoped status summary and one plain-language next step.

## Read model

The API derives the tenant only from the verified portal session and the server-issued tenant context. It accepts no tenant ID, account ID, provider URL, or request filter. Each repository query binds the authorized tenant in SQL and selects only status, fixed reason codes, aggregate counts, and timestamps. Unknown, stale, unavailable, or unconfigured adapter evidence stays `UNKNOWN`; missing rows are not reported as healthy.

The read model covers onboarding, credential health, grant counts, the latest observed subscription state, the latest routed webhook state, tenant job counts, and projection checkpoints. Projection lag remains `UNKNOWN` with `PROJECTION_RUNTIME_NOT_CONFIGURED` and a null lag because M5.08 has no registered destination consumer. Subscription status is separate from asset status and webhook receipt. The export uses the same DTO and the existing recursive redactor.

## Access and actions

`GET /api/v1/operations/diagnostics` requires an active portal session, current tenant context, and a current membership with read permission. `GET /api/v1/support/diagnostics/export` additionally requires a trusted `SUPPORT` grant bound to the actor, tenant, target and one of the fixed reason codes, with a lifetime no longer than 15 minutes. It writes a support audit event before reading and sends `Cache-Control: no-store`. The production support grant adapter is absent, so export is denied by default.

`POST /api/v1/operations/actions` requires an idempotency key, fixed reason code, current tenant context and the action's current membership permission. It accepts only these typed action names:

| Action | Current outcome |
|---|---|
| `REVALIDATE` | Requires trusted company identity and a configured asset-refresh adapter. |
| `RESUME_STAGE` | Requires trusted company identity and an available onboarding recovery adapter. |
| `REQUEST_REAUTH` | Requires trusted company identity and an available lifecycle adapter. |
| `RECONCILE_SUBSCRIPTION` | Requires a current support grant; remains unavailable until provider permissions and reconciliation semantics are confirmed. |
| `REPLAY_JOB` | Requires a support grant and exact tenant-owned dead-letter/scope. M2 enqueues only `SAFE_RETRY` or `IDEMPOTENT` jobs with a deterministic tenant/dead-letter key; ambiguous work is rejected. |

The current portal session has no trusted company display label; M1.08 therefore keeps all tenant writes unavailable. The operations module also defaults support grants to deny. No adapter is enabled by this issue, no production replay was requested or executed, and an accepted queue result never means that a provider effect completed.

## Privacy and user copy

The DTO excludes tokens, credentials, Graph URLs/IDs, provider payloads, raw errors, message bodies, phone numbers and email addresses. The portal displays status labels, timestamps and the safe next step; it does not render raw reason codes or endpoint names. Unknown states say they have not been confirmed. The `Atualizar status` control performs a read only.

## Gates remaining — Not confirmed

- Suite4 issuer, support identity and role-grant adapter, including short-lived grant lifecycle.
- Trusted server-owned company display label / authenticated host context for portal writes.
- Meta permission grants, subscription remote semantics, and production provider response interpretation.
- Configured projection worker/destination runtime, business DDL/catalog, deployed PHP equivalence and tenant mappings.
- Real browser/iframe, staging, support workflow, and production access/audit retention evidence.

No live Meta request, message send, subscription mutation, replay, import of real credentials, production data change or deployment is part of this package.
