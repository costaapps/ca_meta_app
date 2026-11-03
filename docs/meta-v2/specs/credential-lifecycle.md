# Credential lifecycle observations

Status: Implemented locally in M3.09; provider adapters remain unconfigured

## Purpose

Persist safe observations about credential issuance, expiry, data-access expiry, health, provenance, and last check. Observations are evidence, not proof of provider use. Resolver admission requires fresh health and known, nonexpired credential and data-access expiry evidence.

## Requirements

- R1. Store only allowlisted metadata. Never persist provider response bodies, token material, or secrets in lifecycle rows, jobs, logs, or reauthentication intents.
- R2. Unknown, stale, malformed, expired, or data-access-expired observations deny use. A local inspection error does not prove revocation.
- R3. Inspection, refresh, and reauthentication behavior is selected by a server-owned flow/auth/family capability. Missing capabilities are disabled; there is no generic exchange-token fallback.
- R4. An opt-in bounded scheduler uses per-credential leases, generation/version fencing, a per-run budget, jitter, and an idempotent durable job.
- R5. Finalization must match current credential and secret versions and lease generation. Old concurrent results cannot restore credential state.
- R5a. Renewal writes must also match the active authorization state/version captured before provider work; replacement secret material stays inside the vault callback/transaction.
- R6. Reauthentication creates a deduplicated local intent; delivery is outside this scope.
- R7. A transient check preserves known evidence as STALE, or absent evidence as UNKNOWN. Only an explicit validated provider result may establish REVOKED.

## State policy

| State | Resolver behavior |
|---|---|
| HEALTHY / EXPIRING | May proceed only with fresh health and usable expiry dimensions; EXPIRING also requires operation policy permission |
| EXPIRED / REVOKED / ACTION_REQUIRED | Deny; record a local intent only when family policy calls for reauthentication |
| UNKNOWN / STALE | Deny |

The issue's `VALID` health label maps to the M3.08 resolver's `HEALTHY` state. Its `lastVerifiedAt` maps to `health_observed_at`; `last_checked_at` records the most recent attempt, including transient failures. Credential expiry has an explicit `expiry_state`: `KNOWN`, `PROVIDER_NO_EXPIRY`, or `UNKNOWN`. A nullable `expires_at` never proves no-expiry; only an explicit normalized `PROVIDER_NO_EXPIRY` observation does. Data-access expiry is a separate dimension and stays UNKNOWN when it is absent; it must independently be known, fresh, and in the future before the resolver admits use.

Cadence and jitter are operational controls, not provider TTL claims. No universal TTL, permanent-token inference, or generic Meta refresh recipe is implemented. A provider-agnostic injected renewal/CAS path exists for synthetic or later explicitly reviewed adapters; it runs only for an exact configured flow/auth/family policy with a renewal port. No Meta family is configured to renew in the worker bootstrap.

The v13 authorization context columns `flow_variant` and `auth_variant` are nullable and additive. Existing records remain NULL and `scheduleDue()` excludes them. Exact, valid `(flow, auth, family)` is required for a policy match. The existing meta-assets upsert accepts an optional complete pair only with verified provider evidence and a service/system actor, preserves omitted legacy context, and rejects conflicting updates. There is no current production caller that obtains both variants from persisted onboarding/config evidence; product flow alone is insufficient to infer the auth variant. Until that source is wired, existing and newly upserted authorizations without the pair remain unscheduled. **Not confirmed**: the legitimate server path that will supply both values.

## External evidence and uncertainty

Official Meta material accessed 2026-11-03 documents WhatsApp user tokens at 24 hours and system-user tokens up to 60 days or permanent only for the documented setup. Facebook Marketing API material distinguishes user and system-user types and references the debugger without establishing a shared TTL or refresh strategy. Instagram material shows separate Facebook Login/Page-token and Instagram Login paths without establishing either path's TTL or renewal. The official debug-token request is available, but response schema and field semantics are **Not confirmed**. Actual app/grant eligibility, expiry/data-access-expiry semantics, refreshability, revocation fields, authorized periodic execution, and notification delivery are **Not confirmed**.

Sources: [WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Facebook Marketing API](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi), [Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [Instagram Login](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login), [debug-token request](https://www.postman.com/meta/whatsapp-business-platform/request/i1mz7w8/debug-token).

## Acceptance evidence

- Additive schema stores no raw provider data.
- Resolver tests deny UNKNOWN, STALE, expired and data-access-expired candidates.
- Synthetic unit and opt-in MariaDB tests cover schema v13, exact flow/auth/family payload policy, due selection, bounded idempotent durable enqueue, per-credential lease, authorization+impact intent coalescing, successful injected renewal, and stale authorization/version fencing. All providers are synthetic.
- Missing/transient adapters do not produce REVOKED evidence.
- The worker flag alone does not register a handler or scheduler. The bootstrap has no adapter composition, so scheduling stays off even if the flag is true; configured adapters and an authorized periodic trigger are **Not confirmed**.
