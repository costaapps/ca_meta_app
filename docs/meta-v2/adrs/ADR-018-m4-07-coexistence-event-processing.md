# ADR-018 · M4.07 Coexistence event-processing boundary

Status: accepted for a disabled local boundary; history/state/echo provider ingestion remains deferred. Issue: [#53](https://github.com/costaapps/ca_meta_app/issues/53). Spec: [Coexistence history, state and echo processing](../specs/coexistence-event-processing.md). Functional owner: Meta integration. Provider schemas and sync protocol: **Not confirmed**.

## Context

M4.10 owns signed webhook ingress, durable per-item inbox processing, leaf-level asset routing, leases, retries and status fences. Its current implementation routes history and app-echo leaves only when the leaf includes a phone-number reference that resolves to an internal asset. Missing or ambiguous ownership remains tenantless/quarantined. The `smb_app_state_sync` family has no verified phone route and remains tenantless.

The official [Meta Business App onboarding page](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/) and [Graph Webhooks page](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/) returned HTTP 429 during lookup on 2026-11-10. Search results did not establish exact Coexistence schemas, history trigger/window, consent semantics, cursor protocol, or event availability. No app-specific Sandbox evidence exists. M3.10 does not currently provide a WhatsApp history persistence adapter.

## Options

| Option | Benefit | Cost/risk | Evidence |
|---|---|---|---|
| Add a narrow, explicitly disabled processor seam using M4.10's trusted routed leaves and typed scope/sink ports | Defines safe consent, ownership, retention and echo-suppression requirements without changing ingress; future implementation can plug into the durable worker | Does not provide real history sync, persistent import, sync monitoring or provider eligibility | Synthetic contract tests; provider facts remain **Not confirmed** |
| Invent event schemas, a sync trigger/window or a default retention window and implement the whole stream now | Could make local code appear complete | Risks tenant misrouting, false consent/import state, wrong retention and incompatible parsing; official primary-source contract unavailable | Rejected; no source or Sandbox evidence |
| Reuse a generic message handler or auto-reply path for echoes/history | Shares existing message behavior | Can send loops and mix historical imports with live inbound messages | Rejected by issue requirement and safe-processing boundary |

## Decision

Implement a processor that is disabled by default and rejects Coexistence events unless explicitly enabled. It handles only M4.10's normalized history message/status and app echo leaf types. It requires the exact tenant/app/internal phone asset route from M4.10 plus a server-owned resolver result that proves phone ownership, active Coexistence authorization and exact flow/auth variants. It requires explicit server-owned consent and a future retention expiry for every history message/status and echo. The sink contract requires atomic content idempotency by tenant/app/asset/providerMessageId and eventRef, status idempotency by eventRef plus the M4.10 status fence, retention enforcement and no automated replies. Every imported history and app echo is labeled `suppressAutomation: true`.

The processor has no persistence or provider adapter and is not registered in the worker. Unknown/tenantless leaves receive safe permanent reasons and cannot fall through to a more permissive Coexistence handler. `smb_app_state_sync` stays unprocessed before tenant lookup until an official schema and trusted phone route are confirmed. M4.10 routing and fail-closed default behavior are unchanged.

## Consequences and proof

- M4.10 continues to own signature validation, durable item dedupe, worker retry/checkpoint and status update fencing. M4.07 does not add an independent inbox, sync cursor, migration, public endpoint or message-send operation.
- A future sink/resolver must be tenant-scoped, phone-ownership aware, retention-enforcing and transactionally idempotent. It must be wired only after primary-source, privacy, security, exact-candidate test and authorized Sandbox gates are met.
- Synthetic tests cover consent, retention, ownership/scope mismatch, disabled default, eventRef propagation, echo suppression, state-sync quarantine and sanitized safe failures. They do not prove a live event schema, a real DB transaction, sync progress/deadline, or provider behavior.
- M4.07 AC01, AC02, AC03 and AC05 remain partial; AC04 remains unimplemented. The exact release limits are tracked in the spec and must not be reported as full history/echo support.

Revisit when current official Meta documentation and authorized Sandbox evidence establish exact event payloads, consent/refusal semantics, history trigger/window/cursor, echo identity, state-sync phone routing and subscription requirements. Update this ADR, the spec, provider parser, resolver/sink contracts and affected tests together before enabling runtime processing.
