# ADR-009: Persist credential lifecycle observations separately

Status: Accepted for M3.09 package implementation

## Context

M3.08 denies credential use while health and expiry are unknown. Meta flow families differ, and available official material does not establish uniform expiry, data-access-expiry, refresh, or revocation semantics. Persisting raw provider responses would expand sensitive-data exposure and couple behavior to an unverified schema.

## Decision

Add schema-v13 lifecycle observation and local reauthentication-intent stores. Persist only validated allowlisted states, timestamps, provenance, safe reason codes, versions, scheduling metadata, and lease fencing fields. Keep evidence separate from encrypted credentials and authorization grants/scopes. Add nullable flow/auth variants to existing authorization metadata without backfilling; NULL means unknown.

Resolver use requires fresh health plus known, nonexpired credential and data-access-expiry evidence. UNKNOWN, STALE, malformed, or expired evidence fails closed. Transient inspection errors only mark existing evidence STALE or leave missing evidence UNKNOWN; only a validated normalized provider outcome may establish REVOKED.

Capability is selected by the exact server-owned `(flow, auth, family)` tuple; absent or malformed context/capability is disabled. `scheduleDue()` excludes authorizations with unknown flow/auth values. The existing authorization upsert accepts an optional complete tuple only with verified provider evidence and a service/system actor, preserves omitted values, and rejects a conflicting tuple. No current production caller supplies both values from persisted onboarding/config context; no token-shape or client-input inference is permitted.

An opt-in scheduler creates idempotent jobs on the existing historical-projection lane with bounded budget, per-credential leases, CAS version fencing, and jitter. A worker handler/scheduler loop is registered only when an adapter composition is present; the current worker has no composition, so the environment flag alone does nothing. A synthetic provider-agnostic renewal path is available only with an exact policy and injected renewal/vault adapters. Its transaction checks authorization state/version, credential version, secret version, lifecycle version, generation and lease before replacing the encrypted secret and observation. The replacement stays inside the vault adapter callback/transaction and never enters durable work or lifecycle metadata. No Meta provider family is enabled for renewal. Reauthentication creates one local intent per authorization+impact key and retains one safe affected-credential reference. External provider calls and intent delivery are separate reviewed work.

The issue's `VALID` label maps to M3.08 `HEALTHY`; `lastVerifiedAt` maps to `health_observed_at`, while `last_checked_at` records attempts. `expiry_state='PROVIDER_NO_EXPIRY'` requires an explicit validated adapter observation and is never inferred from NULL. Data-access expiry remains independent and must be known/fresh/future before resolver admission.

## Consequences

- Existing credentials without lifecycle observations remain unusable until supported evidence is recorded.
- Existing authorizations whose flow/auth variants are NULL are unscheduled until an authenticated server source writes the exact pair.
- No universal TTL, “never expires” rule, generic refresh exchange, or generic revocation interpretation is inferred.
- Provider adapter semantics, the legitimate source for both flow/auth variants, app/grant eligibility, authorized periodic scheduling, and notification delivery remain **Not confirmed**.
- This ADR authorizes no external Meta calls, credential imports, messages, subscription changes, or production changes.
