# SPEC — Four Meta onboarding journeys

Status: proposed. Issues: [#12](https://github.com/costaapps/ca_meta_app/issues/12), [#15](https://github.com/costaapps/ca_meta_app/issues/15), [#17](https://github.com/costaapps/ca_meta_app/issues/17). Contracts: [capability matrix](../meta-capability-matrix.md), [OpenAPI](../contracts/openapi.yaml), [event schemas](../contracts/events/). Functional owner: product/Meta integration; people unassigned. App permissions, eligibility, approved config and real grants are **Not confirmed**.

## Problem and scope

Onboard independently: WhatsApp Cloud API, WhatsApp + app (Coexistence), Instagram, and Facebook. Four user choices map to five contract variants because Instagram Login and Instagram through Facebook Login stay distinct. The spec covers server-selected config, onboarding session, callback/correlation, job status, recovery and safe UI state. It does not promise an account is eligible or an authorization is ready.

## Invariants

- Server chooses app/environment/flow/auth variant; client cannot provide app secret, permanent token or a trusted `company_uuid`.
- Pre-auth challenge is created before Suite4 ticket exchange. Meta authorization code/state is separate from portal session ticket; state/correlation is opaque, one-use and tenant/session-bound server-side.
- `202 Accepted`, redirect, callback popup close or user-facing completion screen are not final success. Read server job/connection/asset readiness and `observedAt` before showing complete.
- Each Coexistence phone has a distinct onboarding/connection identity; adding the next never overwrites prior grants/assets.
- Never blindly repeat an ambiguous external provider effect. Portal-entry ticket recovery is a narrow idempotent retry only: the same ticket/JTI, challenge and pre-auth browser binding may return the same still-active session without creating or renewing it; changed binding or revoked/expired state is denied. This does not make the ticket a reusable bearer. Keep each Meta flow's permission/asset/token family separate.

## Contract and data

Use M1.07 `/integrations/flows`, `/onboarding-sessions`, auth preauth/exchange, jobs, connections/assets and error/event schemas. Link app, environment, `flowVariant`, `authVariant`, capability version and readiness policy to the server session. The M1.03 matrix states source/version/gate per capability; its local tests do not certify current app-review status.

The onboarding aggregate has a random server-generated opaque ID and is bound to the verified starting tenant, principal and portal session. Browser input cannot set tenant or credential authority. Provider correlation state is HMAC-derived from server configuration, stored only as a digest, expires after ten minutes and is consumable once. A pending row may be replayed only with the same tenant, principal, session, idempotency key and normalized body while unexpired. Status reads remain scoped to that starting record and recheck current membership in its tenant after a context switch. Only a trusted backend adapter may complete the aggregate; a callback page, popup message, HTTP success or client `READY` value is not proof.

M4.03 persists safe onboarding metadata and digests plus a short-lived AES-GCM envelope for the one-time OAuth code. The worker atomically consumes and erases the envelope before the single exchange attempt; cleartext codes, tokens and provider payloads are not persisted. Expired provider correlation is unusable, but rows have no automated purge mechanism in this scope. The operational row retention period is therefore **Not confirmed** and must be resolved before production onboarding data is used. Provider launch configuration, the real adapter and real authorization behavior also remain **Not confirmed**.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| ONB-01 | Four choices and five contract variants | User starts one path | Server-bound flow/auth variants remain distinct | M1.03 capability fixture; M1.08 walkthrough |
| ONB-02 | Provider popup closes before server confirms callback | Browser returns | Show pending/recovery state, not connected; resume by status check | M1.08 popup fixtures + future integration test |
| ONB-03 | Portal exchange response or Meta provider outcome is lost | Client retries | Portal exchange permits only the exact same ticket/JTI, challenge and browser binding to recover the same active session; no session renewal/creation. Ambiguous provider effect remains `UNKNOWN` until reconciliation and is never blindly repeated. | M1.07 contract fixtures + M3.02 DB replay case; provider sandbox gate |
| ONB-04 | Four Coexistence onboarding sessions complete in sequence | Each server projection arrives | Four separate connection refs and resources are visible | M1.08 four-ref append fixture; Sandbox gate for real eligibility |

## Implementation, migration and recovery

Build each auth adapter behind the shared versioned contract and separate flow strategies. M4.03 defines the persisted correlation, one-use code envelope, step checkpoint and explicit resume/reconciliation contract in [the onboarding saga spec](onboarding-saga.md). Legacy callbacks remain mapped through the compatibility matrix until consumer/rewrite evidence and a single-writer plan exist. Reconcile accepted job outcomes before retry. Gate real use on current official docs, app/config/permission evidence and authorized Sandbox account for each of four journeys.
