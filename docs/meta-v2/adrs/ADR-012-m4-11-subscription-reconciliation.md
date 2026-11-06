# ADR-012: M4.11 subscription reconciliation boundaries

- **Status:** Accepted for implementation; external provider evidence remains incomplete
- **Date:** 2026-11-06
- **Issue:** [#47](https://github.com/costaapps/ca_meta_app/issues/47)
- **Spec:** [M4.11 subscription reconciliation](../specs/meta-subscriptions.md)

## Context

Meta subscriptions have two distinct scopes. App-level Webhooks configuration selects callback/event fields on a Meta app. WhatsApp Cloud API asset binding subscribes an app to a WABA, which can serve multiple phone numbers. The Meta-maintained WhatsApp Cloud API collection confirms `POST /{WABA-ID}/subscribed_apps` and distinguishes it from app-level Webhooks configuration. Direct Page/Instagram references returned HTTP 429 during discovery. Exact grants, supported field semantics, GET/DELETE behavior, version availability and app-specific sandbox behavior are **Not confirmed**.

The API already has a server-side asset/authorization catalog, a strict Graph client with an explicit `SUBSCRIBE_WEBHOOKS` operation, an eligible credential resolver, and request context that requires the internal asset ID to match a server-resolved `providerObjectId`.

## Decision

1. Key physical WABA subscription state by tenant, Meta app configuration, environment and the internal WABA asset UUID. Connection intent is stored as a binding under that shared target, keyed by the source asset and its authorization/grant; target locking serializes all phone operations for the same WABA.
2. Resolve the WABA external ID from active, verified server catalog rows and a verified `PHONE_TO_ACCOUNT` relation. Request data accepts only the internal phone asset UUID; it cannot set a Graph resource ID, flow, auth variant, credential family or grant.
3. Resolve a fresh one-use `SUBSCRIBE_WEBHOOKS` credential for the internal WABA asset before each Graph call. Use GET first; write only when the provider app is not observed; verify again after POST. An ambiguous POST is followed by a read and never by an automatic write retry.
4. Persist app-level desired fields in a separate state row. Until the app Webhooks mutation contract is verified, retain desired state with observed `UNKNOWN` and `NOT_CONFIRMED`; never treat a WABA subscription as app-level readiness.
5. Preserve desired asset field sets, but block provider writes while field semantics are not confirmed. Do not infer Page or Instagram subscription support from WhatsApp.
6. Keep removed bindings as refcount history. If any binding remains, keep WABA desired state subscribed and do not send DELETE. If no binding remains, mark manual action required; DELETE semantics have not been confirmed and no DELETE route is available in M4.02.
7. Persist each target outcome with a monotonically increasing version, expiring lease, last-attempt and last-verified timestamps, safe error code, exponential retry time and append-only metadata audit. Provider payloads, object IDs and credentials are not copied into audit diffs.

## Consequences

- Four phone numbers under one WABA share one physical subscription and one row lock. Distinct authorization grants keep independent bindings even when they refer to the same source asset. Concurrent adds cannot issue four POST writes. Binding-only changes that do not alter the WABA desired state do not invalidate a valid in-flight subscribe claim.
- The system reports partial/manual outcomes until provider evidence is available rather than asserting readiness from desired state alone.
- Page/Instagram subscriptions, app-level Webhooks updates, arbitrary WABA field sets and remote unsubscribe remain unavailable behind explicit fail-closed outcomes.
- Final migration registration, Nest module wiring, package command registration, focused test execution and MariaDB fixture validation are integration work owned by the M4 coordinator.

## Revisit when

Official primary documentation and app-specific Sandbox evidence confirm target types, request shape, field semantics, grants, version, response shape and unsubscribe behavior for each flow/auth variant. A contract change must update the capability policy, adapter, this ADR/spec, and the affected tests together.
