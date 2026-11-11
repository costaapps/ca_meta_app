# ADR-020: M4.11 subscription reconciliation boundaries

- **Status:** Accepted for implementation; external provider evidence remains incomplete
- **Date:** 2026-11-06
- **Issue:** [#47](https://github.com/costaapps/ca_meta_app/issues/47)
- **Spec:** [M4.11 subscription reconciliation](../specs/meta-subscriptions.md)

## Context

Meta subscriptions have two distinct scopes. App-level Webhooks configuration selects callback/event fields on a Meta app. WhatsApp Cloud API asset binding subscribes an app to a WABA, which can serve multiple phone numbers. The [Meta-maintained WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=folder-3880d23a-495c-4c5e-9146-2d9db8afb629) documents GET/POST/DELETE on `/{WABA-ID}/subscribed_apps` and distinguishes this from app-level Webhooks configuration. The official [GET subscriptions request](https://www.postman.com/meta/whatsapp-business-platform/request/tl2wk2j/get-all-subscriptions-for-a-waba) does not establish the response item shape. Exact grants, supported field semantics, response shape, GET/DELETE behavior, version availability and app-specific sandbox behavior are **Not confirmed**. Direct Page/Instagram references returned HTTP 429 during discovery.

The API already has a server-side asset/authorization catalog, a strict Graph client with an explicit `SUBSCRIBE_WEBHOOKS` operation, an eligible credential resolver, and request context that requires the internal asset ID to match a server-resolved `providerObjectId`.

## Decision

1. Key physical WABA subscription state by tenant, Meta app configuration, environment and the internal WABA asset UUID. Connection intent is stored as a binding under that shared target, keyed by the source asset and its authorization/grant; target locking serializes all phone operations for the same WABA.
2. Resolve the WABA external ID from active, verified server catalog rows and a verified `PHONE_TO_ACCOUNT` relation. A trusted internal caller may include an internal authorization UUID to select one of several grants for the same asset. The catalog scopes that UUID by tenant, app, environment, source asset and WABA target; an omitted selector is accepted only when exactly one eligible grant exists. Request data cannot set a Graph resource ID, flow, auth variant or credential family.
3. Resolve a fresh one-use `SUBSCRIBE_WEBHOOKS` credential for the internal WABA asset before each Graph call. Use GET first; write only when the provider app is not observed; verify again after POST. An ambiguous POST is followed by a read and never by an automatic write retry.
4. Persist app-level desired fields in a separate state row. Until the app Webhooks mutation contract is verified, retain desired state with observed `UNKNOWN` and `NOT_CONFIRMED`; never treat a WABA subscription as app-level readiness.
5. Preserve desired asset field sets, but block provider writes while field semantics are not confirmed. Do not infer Page or Instagram subscription support from WhatsApp.
6. Keep removed bindings as refcount history. If any binding remains, keep WABA desired state subscribed and do not send DELETE. If no binding remains, mark manual action required; DELETE semantics have not been confirmed and no DELETE route is available in M4.02.
7. Persist each target outcome with a monotonically increasing version, expiring lease, last-attempt and last-verified timestamps, safe error code, exponential retry time and append-only metadata audit. Provider payloads, object IDs and credentials are not copied into audit diffs.

## Consequences

- Four phone numbers under one WABA share one physical subscription and one row lock. Distinct authorization grants keep independent bindings even when they refer to the same source asset; ambiguous grant selection fails closed, and an explicit internal selector can remove only the matching binding. Concurrent adds cannot issue four POST writes. Binding-only changes that do not alter the WABA desired state do not invalidate a valid in-flight subscribe claim.
- The system reports partial/manual outcomes until provider evidence is available rather than asserting readiness from desired state alone.
- The generic v18 target/binding contract can persist an exact Facebook Page desired binding under `FACEBOOK` / `FACEBOOK_LOGIN_FOR_BUSINESS`; this is selection/reconciliation intent only. `MetaGraphSubscriptionProvider` returns `PAGE_SUBSCRIPTION_NOT_CONFIRMED` before credential resolution or Graph access. Instagram subscriptions, app-level Webhooks updates, arbitrary WABA field sets and remote unsubscribe remain unavailable behind explicit fail-closed outcomes.
- The WABA GET parser accepts only a string or object with a top-level string `id`. Nested shapes such as `whatsapp_business_api_data.id` are not confirmed by the official request example and fail closed as `GRAPH_RESPONSE_INVALID` before a POST; do not interpret the synthetic test as evidence of the provider's live response shape.
- Final migration registration, Nest module wiring, package command registration, focused test execution and MariaDB fixture validation are integration work owned by the M4 coordinator.

## Amendment — 2026-11-10: explicit internal grant selection

Static review showed that a phone can have multiple eligible authorization grants, while an asset-only request cannot identify which binding to disconnect. Decision 2 now permits an optional internal `authorizationId` selector. It is only a disambiguator: the actor still needs a verified service tenant scope, and the catalog must resolve the selected grant against the same tenant, app configuration, environment, internal source asset and related WABA. Missing selectors remain fail-closed whenever more than one eligible grant exists. This amendment does not accept provider object IDs or grant new authorization.

## Amendment — 2026-11-10: M4.08 Facebook Page target contract

M4.08 extends the catalog/service contract to recognize only a direct `FACEBOOK_PAGE` asset authorized by `FACEBOOK` / `FACEBOOK_LOGIN_FOR_BUSINESS`. The existing target natural key already includes tenant, app, environment and internal target asset ID, so a Page binding needs no schema migration. Its Page token/grant is resolved only by the exact catalog authorization. The provider deliberately returns a durable partial result without a Graph request because Page subscription permissions, endpoint semantics and fields are **Not confirmed**. This does not infer Page behavior from WABA subscriptions and does not enable Instagram.

## Revisit when

Official primary documentation and app-specific Sandbox evidence confirm target types, request shape, field semantics, grants, version, response shape and unsubscribe behavior for each flow/auth variant. A contract change must update the capability policy, adapter, this ADR/spec, and the affected tests together.
