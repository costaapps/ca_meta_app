# ADR-009: Persist credential lifecycle observations separately

Status: Accepted for M3.09 package implementation

## Context

M3.08 denies credential use while health and expiry are unknown. Meta flow families differ, and available official material does not establish uniform expiry, data-access-expiry, refresh, or revocation semantics. Persisting raw provider responses would expand sensitive-data exposure and couple behavior to an unverified schema.

## Decision

Add schema-v13 lifecycle observation and local reauthentication-intent stores. Persist only validated allowlisted states, timestamps, provenance, safe reason codes, versions, scheduling metadata, and lease fencing fields. Keep evidence separate from encrypted credentials and authorization grants/scopes. Add nullable flow/auth variants to existing authorization metadata without backfilling; NULL means unknown.

Resolver use requires fresh health plus known, nonexpired credential and data-access-expiry evidence. UNKNOWN, STALE, malformed, or expired evidence fails closed. Transient inspection errors only mark existing evidence STALE or leave missing evidence UNKNOWN; only a validated normalized provider outcome may establish REVOKED.

Capability is selected by the exact server-owned `(flow, auth, family)` tuple; absent or malformed context/capability is disabled. `scheduleDue()` excludes authorizations with unknown flow/auth values. The existing authorization upsert accepts an optional complete tuple only with verified provider evidence and a service/system actor, preserves omitted values, and rejects a conflicting tuple. No current production caller supplies both values from persisted onboarding/config context; no token-shape or client-input inference is permitted.

An opt-in scheduler creates idempotent inspection jobs on the existing historical-projection lane with bounded budget, per-credential leases, version fencing, and jitter. A worker handler/scheduler loop is registered only when an adapter composition is present; the current bootstrap has no adapter composition, so the environment flag alone does nothing. The inspection worker is read-only with respect to credential storage; it never renews or replaces a credential. An isolated `CredentialReplacementCasService` provides a local synthetic CAS finalizer primitive only: in one transaction it checks the active authorization state/version, credential and secret versions, lifecycle version, flow/auth context, schedule generation and lease before delegating to the vault's conditional write. It has no provider port and is not composed into inspection. It does not establish a renewal capability. A future renewal requires a separate durable `CREDENTIAL_RENEWAL` job classified `AMBIGUOUS`, with one-attempt/no-unsafe-retry semantics, provider-specific review and this CAS finalizer; automatic refresh remains unimplemented in M3.09.

Each asset authorization stores one exact credential link. V13 quarantines legacy ACTIVE rows with `credential_id IS NULL`; new unbound upserts stay quarantined, and resolver candidates require `aa.credential_id = c.id`. A family-created reauth intent retains exact current verified asset impacts for EXPIRED, REVOKED and ACTION_REQUIRED observations. Only validated REVOKED revokes the exact linked credential, assets and grants, and only queued/retry-pending `CREDENTIAL_INSPECTION` jobs for that credential are canceled. Running inspection finalization is fenced by current versions and lease. Other job types are not canceled by this package; every non-inspection operation must re-run the credential resolver immediately before its effect. A trusted new active credential may rebind a previously revoked asset authorization only from the exact same tenant/authorization/app/provider/environment and with verified per-asset evidence; active bound links cannot be rebound and the old revoked credential remains revoked. The internal bounded reauth reader returns only current exact resource references, exposes active expired/action-required links and confirmed revoked links, and requires caller-side tenant+REAUTHORIZE authorization. There is no public route or external notification delivery.

The issue's `VALID` label maps to M3.08 `HEALTHY`; `lastVerifiedAt` maps to `health_observed_at`, while `last_checked_at` records attempts. `expiry_state='PROVIDER_NO_EXPIRY'` requires an explicit validated adapter observation and is never inferred from NULL. Data-access expiry remains independent and must be known/fresh/future before resolver admission.

## Consequences

- Existing credentials without lifecycle observations remain unusable until supported evidence is recorded.
- Existing authorizations whose flow/auth variants are NULL are unscheduled until an authenticated server source writes the exact pair.
- Existing unbound asset-authorization rows are quarantined and cannot resolve to any credential; the runtime source for exact credential-to-asset evidence remains **Not confirmed**.
- No universal TTL, “never expires” rule, generic refresh exchange, or generic revocation interpretation is inferred.
- Automatic renewal is not implemented; its future AMBIGUOUS job and provider adapter remain required. The isolated CAS primitive is only a local synthetic fence proof.
- Provider adapter semantics, the legitimate source for flow/auth and credential/asset evidence, app/grant eligibility, authorized periodic scheduling, and notification delivery remain **Not confirmed**.
- This ADR authorizes no external Meta calls, credential imports, messages, subscription changes, or production changes.
