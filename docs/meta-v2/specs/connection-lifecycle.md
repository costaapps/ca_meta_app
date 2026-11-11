# SPEC — Meta connection lifecycle

Status: M4.13 local lifecycle implementation candidate; issue [#55](https://github.com/costaapps/ca_meta_app/issues/55). Contract: [OpenAPI](../contracts/openapi.yaml). Dependencies: M4.10 signed inbox, M4.11 subscriptions, M4.12 asset observations, M3.09 credential lifecycle, and M3.10 privacy governance.

## Evidence boundary

Current Meta deauthorization/data-deletion callback bodies, signature rules, event identity, replay behavior, subject mapping, and WhatsApp Coexistence offboarding effects are **Not confirmed**. The official Meta pages were attempted on 2026-11-10 but returned HTTP 429. References: [Data deletion callback](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/), [Facebook Login manual flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [WhatsApp Coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users), [WhatsApp changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog). Historical PHP and archived SDK behavior are not used as current protocol evidence.

The runtime therefore installs a fail-closed callback verifier and target resolver. No Meta cleanup/subscription adapter is registered. A callback adapter may be enabled only after its exact flow/app signature format, replay/idempotency rule, and server-side subject mapping are verified. A local test fixture is not provider evidence.

## Local disconnect

- `DELETE /api/v1/connections/{connectionId}` is authorization-scoped and requires owner/admin membership plus CSRF. It returns `409` when more than one active verified asset binding exists; a broad request cannot silently disconnect sibling resources.
- `DELETE /api/v1/connections/{connectionId}/assets/{assetId}` resolves tenant, authorization, and asset together, disables only the selected asset-authorization binding, and leaves sibling assets, shared credential metadata, and subscriptions unchanged.
- A whole-authorization request may proceed when the catalog has at most one active verified asset binding. The local authorization and its exact bindings become unavailable to the resolver immediately. Credential bytes are retained; no provider request is made.
- Every command is idempotent by tenant, actor digest, idempotency-key digest, and request hash. The command ledger stores a local state and cleanup state. Cleanup starts `BLOCKED` with `PROVIDER_OFFBOARDING_NOT_CONFIRMED`; this is not a claim of Meta disconnection. No hidden deregister/delete/register action is allowed for Coexistence.
- The worker execution boundary and credential resolver re-read persisted authorization/resource state before a job claim and before issuing a one-use credential handle; no in-process token cache is introduced by this package. A provider request that already crossed its final authorization check cannot be recalled. M4.13 does not replay such ambiguous in-flight effects; a future adapter must reconcile them before retrying. No provider worker is currently configured, so live in-flight behavior is **Not confirmed**.

## Reauthorization

`POST /api/v1/connections/{connectionId}/reauthorizations` derives the exact public flow from the persisted `(flow_variant, auth_variant)` pair. Unknown, mismatched, revoked, or disconnected pairs fail closed. It creates a new onboarding session using a connection-bound idempotency value and records a link from that session to the prior authorization. The prior authorization and credential stay unchanged until a later trusted provider completion has been correlated and validated. If the current flow configuration or launch adapter is unavailable, the endpoint returns service unavailable and does not revoke the old grant.

## Provider callbacks

`POST /api/v1/webhooks/meta-lifecycle/{appConfigRef}` keeps the raw body isolated behind a provider-specific verifier. The verifier returns a branded normalized capability containing only an app-config reference, callback kind, server-validated event digest, subject digest, and verification time. A separate server-owned target resolver maps the digest to exactly one tenant/app/authorization; callback fields never select a tenant directly.

Receipts are keyed by app-config-reference digest and event digest. Exact repeats return `DUPLICATE`; changed content under a repeated event identity is rejected; unmapped receipts remain `UNMAPPED` and can be retried after mapping is corrected. A verified deauthorization revokes credentials, lifecycle observations, queued inspection jobs, and asset bindings for the exact mapped authorization, with audit evidence. A verified data-deletion callback creates a M3.10 authorization-scope deletion request and tombstone in `RECEIVED`; it does not purge data or declare completion. The default verifier returns no trusted event, so callbacks currently fail closed with `403`; infrastructure/processor failure returns `503`.

## Persistence and recovery

Schema version 20 adds a tenant-bound lifecycle command ledger and hash-only callback receipts. Raw callback bodies, provider IDs, token bytes, and callback payloads are not persisted. Existing M3.10 deletion tombstones preserve minimal target digests and deletion progress. Provider cleanup remains blocked without a reviewed, flow-specific adapter. Deletion confirmation/purge is not implemented by this package; no rollback/import path may restore a revoked credential.

## Acceptance evidence map

| Issue #55 criterion | Local implementation evidence | Current result / limit |
|---|---|---|
| Removing one connection preserves other Pages/numbers under a shared authorization | Broad disconnect rejects multiple active verified asset bindings; asset-scoped transaction changes only the selected binding | Local path implemented; database race/production behavior not exercised in this candidate |
| Revoked tokens are not selected | Signed deauthorization processor marks credentials and exact authorization REVOKED; resolver checks persisted states | Synthetic capability and unit behavior only; real callback mapping and cache behavior **Not confirmed** |
| Forged callback cannot delete; duplicate callback cannot repeat cleanup | Default verifier rejects; receipt key and payload digest fence repeated events; deletion callback writes only a tombstone request | Synthetic tests are not a Meta signature or replay certification |
| External cleanup failure stays visible/reprocessable | Command ledger retains BLOCKED/PENDING/FAILED/UNKNOWN/CONFIRMED and a safe reason | No external worker/adapter or status poller is configured; external cleanup remains **Not confirmed** |
| Local deletion does not implicitly perform destructive provider actions | No provider port is invoked; Coexistence path contains no register/deregister/delete operation | Locally enforced; live Coexistence offboarding is **Not confirmed** |

## Focused local harness

After the workspace dependencies are already present, run from repository root:

```powershell
npm run test:m4-13 --workspace=@ca-meta/api
```

The harness strictly compiles the focused lifecycle slice and runs only `apps/api/test/m4-13-connection-lifecycle.spec.ts` in an OS temporary directory. It does not install dependencies, start a provider session, or access a real Meta account. The coordinator recorded 11/11 on candidate `9c5fe20c8a294aa6a3c8f50bc84df089a3ef7915`; migration, contract, review and applicable CI evidence is summarized in the M4 progress record. External offboarding and cleanup behavior remain **Not confirmed**.
