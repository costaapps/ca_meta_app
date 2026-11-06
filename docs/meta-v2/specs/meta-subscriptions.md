# M4.11 — subscription reconciliation

**State:** Implemented candidate; awaiting integrated review and gate evidence
**Issue:** [#47](https://github.com/costaapps/ca_meta_app/issues/47)
**Decision:** [ADR-012](../adrs/ADR-012-m4-11-subscription-reconciliation.md)

## Scope

Persist subscription desired state separately from provider observations for each tenant, Meta app configuration, environment, target and field set. Keep application-level Webhooks configuration separate from per-asset/WABA `subscribed_apps` bindings. Resolve credentials only for the server-persisted operation context. Serialize reconciliation per WABA, retain recoverable partial outcomes, audit state changes, and preserve shared WABA subscriptions when one phone is disconnected.

## Acceptance criteria and evidence mapping

| Criterion | Implementation evidence | Synthetic proof |
|---|---|---|
| AC01 — Desired/observed state and fields remain separate; WABA targets persist attempt time, last verified time, error/retry state and version. App-level desired fields remain distinct. | `ca_meta_app_webhook_configs`, `ca_meta_subscription_targets`, `ca_meta_subscription_bindings` in the M4.11 migration and MySQL store; target snapshots expose `lastAttemptAt`, `lastVerifiedAt`, `lastErrorCode`, and `nextAttemptAt`. | Synthetic success captures attempt/verification times; transient failures persist safe error and retry state; app-level fields remain `NOT_CONFIRMED` and do not invoke the WABA provider. |
| AC02 — Provider object ID is resolved from the server catalog by tenant/app/environment and internal asset UUID. A browser supplied provider ID cannot select the target. | Catalog resolves verified active WhatsApp phone → verified WABA relation; service DTO rejects unknown properties; Graph adapter uses catalog `providerObjectId`. | Forged browser ID is rejected before catalog/provider; adapter asserts `resourceId` equals its server target ID. |
| AC03 — Only an eligible `SUBSCRIBE_WEBHOOKS` credential for the exact server-owned flow/auth/environment and WABA asset can execute the operation. | Graph adapter creates a one-use resolver handle for the internal WABA asset and uses M4.02 `MetaGraphClient.withCredentialForContext` validation. | Adapter fixture asserts resolver context uses the WABA UUID and `SUBSCRIBE_WEBHOOKS`; raw service scope test fails closed. |
| AC04 — Same target reconciliation is idempotent and cross-process serialized with target version and expiring lease. | Unique target context key; target-row `SELECT ... FOR UPDATE`; per-target lease token; outcome update compares the claim version and token. Binding-only changes that do not change target desired state do not stale an in-flight WABA claim. | Four concurrent phone assets under one synthetic WABA share a lease and produce one subscription write. |
| AC05 — Reconciliation reads before writing, verifies a successful/ambiguous POST with a new read, persists partial/unknown outcomes, and backs off transient errors. | Graph adapter GET→optional POST→GET; ambiguous POST is never blindly repeated. Store gates claims on `next_attempt_at`; service persists exponential retry time. | Fake provider proves one write under four concurrent requests and retry is blocked until due. |
| AC06 — App-level Webhooks fields are not inferred from asset-level WABA subscriptions. | Separate app webhook table and `setAppWebhookDesired`; app adapter stays `NOT_CONFIRMED`. | App fields test verifies no asset provider call and empty observed fields. |
| AC07 — Disconnect updates only the selected asset/grant binding; it does not remove the shared WABA subscription while another authorized binding remains. | Removed binding stays as history; each binding includes the authorization/grant ID and target desired state remains subscribed while any binding is active. No Graph DELETE route is introduced. With zero bindings, remote removal is marked `MANUAL_ACTION_REQUIRED` because its exact semantics are not confirmed. | Tests cover disconnect with three phone consumers remaining and two grants for the same asset without removing the other grant. |
| AC08 — Four numbers sharing one WABA do not race or lose desired bindings. | One unique target row is keyed by internal WABA asset UUID; all bindings update under its row lock. | Concurrent synthetic four-phone test checks four active bindings, one write, and subsequent idempotent reconciliation. |
| AC09 — Audit events contain opaque internal references, safe reason codes, versions, actor hash and correlation ID; audit rows are append-only. | `ca_meta_subscription_audit` and migration triggers reject UPDATE/DELETE. No provider response/body or credentials are persisted. | The focused harness has no Meta client/network dependency; the audit DDL is migration-verified by the integrated migration gate. |
| AC10 — A focused executable harness is repeatable and cleans up isolated output. | `tools/m4-11/run-focused-test.mjs`, `tools/m4-11/README.md`, and `apps/api/tsconfig.m4-11-test.json`. | Run `node tools/m4-11/run-focused-test.mjs`; output is compiled into an OS temp directory and deleted in `finally`. Not run by this implementer per coordinator instruction. |

## Boundaries and unresolved evidence

- Only WhatsApp Cloud WABA `subscribed_apps` is implemented. Facebook Page and Instagram variants return a safe partial state until their target, grant and subscription semantics are confirmed.
- App-level Webhooks configuration is stored independently, but its mutation and observed fields remain `NOT_CONFIRMED`; no app-level Graph mutation occurs.
- A non-empty per-binding asset field set remains desired state but blocks provider writes as `ASSET_SUBSCRIPTION_FIELDS_NOT_CONFIRMED`. The supported endpoint's field semantics are not confirmed.
- The Meta-maintained WhatsApp Cloud API collection confirms `POST /{WABA-ID}/subscribed_apps` and separation from app Webhooks. Exact permission grants, Graph version availability, response shape, empty request body behavior, GET interpretation and DELETE behavior still require app-specific review/Sandbox evidence. The adapter checks GET response IDs conservatively and verifies each write before marking ACTIVE.
- Disconnect with no active binding intentionally requires manual removal because no confirmed DELETE adapter exists. This prevents claiming a remote removal that was not verified.
- No real Meta request, credential, browser input, production database or customer data is used by the focused harness.

## Gate

The focused package command is `node tools/m4-11/run-focused-test.mjs`. The coordinator must register the module/migration/command serially, then run the focused check and the appropriate synthetic MariaDB migration fixture on the integrated candidate SHA. This branch does not register itself or claim those later checks have run.
