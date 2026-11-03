# Credential lifecycle observations

Status: Local observation, scheduling, fencing, and reauthorization contracts implemented; automatic renewal and provider adapters remain unimplemented/unconfigured

## Purpose

Persist safe observations about credential issuance, expiry, data-access expiry, health, provenance, and last check. Observations are evidence, not proof of provider use. Resolver admission requires fresh health and known, nonexpired credential and data-access expiry evidence.

## Requirements

- R1. Store only allowlisted metadata. Never persist provider response bodies, token material, or secrets in lifecycle rows, jobs, logs, or reauthentication intents.
- R2. Unknown, stale, malformed, expired, or data-access-expired observations deny use. A local inspection error does not prove revocation.
- R3. Inspection, refresh, and reauthentication behavior is selected by a server-owned flow/auth/family capability. Missing capabilities are disabled; there is no generic exchange-token fallback.
- R4. An opt-in bounded scheduler uses per-credential leases, generation/version fencing, a per-run budget, jitter, and an idempotent durable job.
- R5. Finalization must match current credential and secret versions and lease generation. Old concurrent results cannot restore credential state.
- R5a. No inspection worker performs renewal. A separate transaction-scoped CAS finalizer contract may replace a secret only when the active authorization state/version, credential and secret versions, lifecycle version, flow/auth context, generation, and lease all still match. It does not call a provider.
- R6. A family policy may create one local intent per authorization+impact key and exact credential-linked resource impacts. Delivery is outside this scope.
- R7. A transient check preserves known evidence as STALE, or absent evidence as UNKNOWN. Only an explicit validated provider result may establish REVOKED.

## State policy

| State | Resolver behavior |
|---|---|
| HEALTHY / EXPIRING | May proceed only with fresh health and usable expiry dimensions; EXPIRING also requires operation policy permission |
| EXPIRED / REVOKED / ACTION_REQUIRED | Deny; record a local intent and exact current resource impacts only when family policy calls for reauthentication |
| UNKNOWN / STALE | Deny |

The issue's `VALID` health label maps to the M3.08 resolver's `HEALTHY` state. Its `lastVerifiedAt` maps to `health_observed_at`; `last_checked_at` records the most recent attempt, including transient failures. Credential expiry has an explicit `expiry_state`: `KNOWN`, `PROVIDER_NO_EXPIRY`, or `UNKNOWN`. A nullable `expires_at` never proves no-expiry; only an explicit normalized `PROVIDER_NO_EXPIRY` observation does. Data-access expiry is a separate dimension and stays UNKNOWN when it is absent; it must independently be known, fresh, and in the future before the resolver admits use.

Cadence and jitter are operational controls, not provider TTL claims. No universal TTL, permanent-token inference, or generic Meta refresh recipe is implemented. The inspection worker is read-only with respect to credential storage: it can read a secret through the vault callback and submit a validated inspection observation, but it cannot replace a credential. An isolated transaction-scoped `CredentialReplacementCasService` checks the current authorization state/version, credential and secret versions, lifecycle version, flow/auth pair, generation, and lease before calling the vault's conditional write. It has no provider port and is not composed into the inspection worker. It is a local finalization primitive only; no renewal adapter or durable renewal job is implemented. Any future renewal needs its own durable `CREDENTIAL_RENEWAL` job with `AMBIGUOUS` effect classification, bounded one-attempt semantics, provider-specific review, and this CAS as finalizer. The refresh criterion remains unimplemented until that separate job and a verified family adapter exist.


Asset authorizations carry one exact nullable `credential_id`. Existing unbound active rows move to `QUARANTINED` during v13; new upserts without trusted credential evidence remain quarantined. The resolver requires `asset_authorization.credential_id = credential.id`, so an unbound row cannot borrow another credential under the same authorization. A confirmed revocation affects only the revoked credential and its exact linked verified asset authorizations/grants; it does not revoke the overall authorization or other credential links. Reauthorization can bind a different active credential to a previously revoked asset authorization only with trusted per-asset provider evidence and the same tenant/authorization/app/provider/environment context. Other bound rows cannot be rebound, and the revoked credential/history is not restored. The legitimate runtime source of this credential-to-asset evidence is **Not confirmed**.

The v13 authorization context columns `flow_variant` and `auth_variant` are nullable and additive. Existing records remain NULL and `scheduleDue()` excludes them. Exact, valid `(flow, auth, family)` is required for a policy match. The existing meta-assets upsert accepts an optional complete pair only with verified provider evidence and a service/system actor, preserves omitted legacy context, and rejects conflicting updates. There is no current production caller that obtains both variants from persisted onboarding/config evidence; product flow alone is insufficient to infer the auth variant. Until that source is wired, existing and newly upserted authorizations without the pair remain unscheduled. **Not confirmed**: the legitimate server path that will supply both values.

For EXPIRED, REVOKED, or ACTION_REQUIRED observations, a family policy can create a deduplicated authorization+impact intent and child rows for only the current verified asset links to that credential. Only a validated REVOKED observation revokes the credential, those grants/asset links, and queued or retry-pending `CREDENTIAL_INSPECTION` jobs for that same credential. Running inspection results are fenced by credential/lifecycle versions and lease. This package does not cancel other job types; each non-inspection operation must re-run the credential resolver immediately before executing an effect. The bounded internal reauthorization reader returns only exact current resource references for active EXPIRED/ACTION_REQUIRED links or confirmed revoked links; M3.12 must authorize tenant and REAUTHORIZE access before calling it. No public route or notification adapter is added.

## External evidence and uncertainty

Official Meta material accessed 2026-11-03 documents WhatsApp user tokens at 24 hours and system-user tokens up to 60 days or permanent only for the documented setup. Facebook Marketing API material distinguishes user and system-user types and references the debugger without establishing a shared TTL or refresh strategy. Instagram material shows separate Facebook Login/Page-token and Instagram Login paths without establishing either path's TTL or renewal. The official debug-token request is available, but response schema and field semantics are **Not confirmed**. Actual app/grant eligibility, expiry/data-access-expiry semantics, refreshability, revocation fields, authorized periodic execution, and notification delivery are **Not confirmed**.

Sources: [WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Facebook Marketing API](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi), [Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [Instagram Login](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login), [debug-token request](https://www.postman.com/meta/whatsapp-business-platform/request/i1mz7w8/debug-token).

## Acceptance evidence

- Additive schema stores no raw provider data.
- Resolver tests deny UNKNOWN, STALE, expired and data-access-expired candidates.
- Synthetic unit and opt-in MariaDB tests cover schema v13, exact flow/auth/family payload policy, due selection, bounded idempotent durable enqueue, per-credential lease, authorization+impact intent coalescing, exact two-credential/two-resource revocation, EXPIRED/ACTION_REQUIRED non-revoking impacts, trusted rebind to a new credential, and current/stale isolated CAS replacement. All providers and evidence are synthetic; the inspection worker performs no replacement.
- Missing/transient adapters do not produce REVOKED evidence.
- The worker flag alone does not register a handler or scheduler. The bootstrap has no adapter composition, so scheduling stays off even if the flag is true; configured adapters and an authorized periodic trigger are **Not confirmed**.
