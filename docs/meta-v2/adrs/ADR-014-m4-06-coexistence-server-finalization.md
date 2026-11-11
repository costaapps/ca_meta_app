# ADR-014 · Coexistence server finalization boundary

Status: accepted for the local implementation boundary; provider adapter wiring is deferred. Issue: [#52](https://github.com/costaapps/ca_meta_app/issues/52). Spec: [Coexistence server finalization](../specs/coexistence-server-finalization.md). Functional owner: Meta integration. Provider exchange/grant contract: **Not confirmed**.

## Context

M4.03 already persists one-use authorization codes and durable checkpoints for authorization, asset verification, subscription and projection. M3.06/M3.07 provide the tenant-scoped asset/credential metadata and encrypted vault boundary. M4.11 provides a target-locked subscription reconciler for exact internal asset refs. M4.05 has a separate browser flow, but its current SDK, Coexistence event schema and launch behavior remain **Not confirmed**, so its provider adapter is disabled.

The accessible official [Meta Embedded Signup collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) covers common Embedded Signup operations and standard WhatsApp Cloud registration. It does not prove the Coexistence code-exchange endpoint, token family, exact grants or asset/subscription semantics. These standard operations cannot be copied into Coexistence. No app-specific Sandbox evidence is available.

## Options

| Option | Benefit | Cost/risk | Evidence |
|---|---|---|---|
| Reuse the generic M4.03 saga with a typed Coexistence adapter boundary and ports for exchange, verified assets, M4.11 subscription and projection | Keeps durable checkpoints/retries and tenant ownership already reviewed; isolates product semantics and can use existing vault/catalog/subscription code | Live ports cannot be wired until first-party token/grant/asset evidence and a verified worker scope are available | Local contracts and synthetic adapter tests; provider facts **Not confirmed** |
| Reuse the WhatsApp-exclusive adapter and conventional `/phone/register` path | Shares code | Could disconnect or change the WhatsApp Business App number, mixes flow/auth/token families, violates issue guard | Rejected by M4.06 and M4.05 flow separation; no provider evidence authorizes it |
| Add a new Coexistence table/saga separate from M4.03 | Could encode more product-specific detail | Duplicates session/tenant/recovery state without need; adds DDL and migration risk before provider fields are known | No measured need; existing four-stage checkpoints are sufficient for current local boundary |

## Decision and consequence

Use a dedicated `CoexistenceOnboardingSagaAdapter` that implements M4.03's existing adapter interface. The code-exchange port performs the full exchange and vault store and returns only an internal authorization ref. The asset port discovers within that authorization and persists a verified phone-to-account relation. The subscription port adapts to M4.11 with an internal phone ref, exact internal authorization selector and a `VerifiedServiceTenantScope` resolved from the worker identity. Projection consumes only internal refs and a M4.11 success receipt. The production worker installs no such adapter while its exact first-party contract is unavailable.

The M4.03 checkpoint code remains the source of per-stage status and readiness. M4.11 is the sole subscription owner; the adapter considers the step successful only after the reconciler reports `ACTIVE` and `observedState=SUBSCRIBED`. A retry uses the same stage idempotency key and does not exchange the code again. A separate read-only observer is required for ambiguous reconciliation; the M4.11 `reconcile` method is not treated as read-only.

The adapter contains no conventional register, deregister, or delete operation. Desired subscription state is only a necessary local step; it does not prove WhatsApp Business App usability or real API capability.

## Security, effects and reversibility

- Tenant, principal, portal session, flow, app config and environment are pinned in the M4.03 saga. The M4.11 adapter resolves its UUID app configuration and verified worker scope server-side; no tenant or provider ID is accepted from browser DTOs.
- Raw code is passed only to the exchange port; provider secrets are stored and used through M3.07 CredentialVaultService. No token or credential material is returned to the saga, public API, projection or logs.
- The asset verifier must use exact grant evidence and persist one `PHONE_TO_ACCOUNT` relation. No eligible or ambiguous result cannot reach READY. The package does not provide a user-facing selection endpoint; this remains a precise recovery gap.
- M4.11 owns idempotency/target locks. No retry path invokes code exchange after the authorization ref has been checkpointed. Unknown provider effects remain unknown until a read-only observation resolves them.
- The package changes no schema and issues no real Meta calls. Rollback removes the adapter package; existing sessions/credentials/assets are not deleted.
- This scope does not enable history sync, send a message, change production subscriptions, or authorize standard phone registration.

## Proof and revisit

The synthetic focused harness is `node tools/m4-06/run-focused-test.mjs`; it was authored for the coordinator's exact-candidate run and has not been run by the implementer. It covers flow isolation, opaque references, asset ambiguity, subscription verification/retry, read-only reconciliation delegation, shared WABA with four phone grants, and the disabled provider boundary. A future activation requires direct Meta evidence for version/token/exchange/grants/assets/subscription, an authenticated selection contract if discovery is ambiguous, a fully configured vault/credential resolver, current app-specific Sandbox access, a no-registration transport spy, and reviewed exact-candidate tests.

Revisit when that primary evidence and Sandbox configuration exist. Update this ADR, M4.06 spec, M4.01 capability profile, affected consumers, and tests together before installing any adapter.
