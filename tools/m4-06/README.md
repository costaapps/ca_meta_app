# M4.06 Coexistence server finalization boundary

This package adds a flow-specific `OnboardingSagaAdapter` boundary for WhatsApp Business App Coexistence. It keeps the one-use code inside a vault-owning exchange port, accepts only internal verified asset references, binds one selected phone to its verified business-account relation, and routes subscription intent through M4.11. The adapter exposes no phone registration, deregistration, or asset deletion operation.

## Run the focused synthetic checks

Requirements: Node `>=24.15.0 <25`, npm `>=11.19.1 <12`, and dependencies from the repository lockfile. From the repository root:

```sh
npm ci --ignore-scripts
node tools/m4-06/run-focused-test.mjs
```

The harness compiles only its TypeScript dependency graph into an OS temporary directory and removes that directory in `finally`. No database or Docker service is needed. The fixtures use generated UUIDs, a synthetic code, synthetic credential/asset references, and a fake M4.11 service; they make no Meta request and store no credential material.

## What the fixtures exercise

- Wrong flow/auth pairs stop before a provider port call.
- Code exchange can return only an internal authorization reference; storage of any returned secret belongs to the vault-owning port.
- Asset verification returns one phone plus one business-account ref; no browser/provider asset IDs are accepted at this adapter boundary.
- Zero eligible phones, an unresolved selection, or unconfirmed grants fail before subscription.
- M4.11 only counts as complete after the target is observed subscribed; retries retain the same onboarding-stage idempotency key and do not exchange the code again.
- Projection requires both verified internal assets and a subscription receipt.
- Ambiguous subscription reconciliation uses a separate read-only port.
- Four synthetic phone bindings can share one WABA target while keeping distinct authorization references.
- The default ports remain unavailable and expose no conventional registration or destructive method.

## Provider evidence and remaining gates

The official [Meta Embedded Signup Postman collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) describes common Embedded Signup steps, including conventional phone registration and WABA subscription, but does not establish Coexistence's exact code-exchange endpoint, token family, grants, asset response or current subscription eligibility. Those details remain **Not confirmed** and conventional registration details must not be transferred to Coexistence. No default provider adapter is installed in the worker. The M4.05 browser adapter is also disabled pending exact first-party protocol evidence.

This local boundary cannot prove number usability in the WhatsApp Business App, real API access, current Coexistence grants, four-number Sandbox completion, or live subscription semantics. The ambiguous-asset selection outcome remains `SELECTION_REQUIRED`; an authenticated selection endpoint and provider-derived candidate list require their own contract/evidence. Keep onboarding partial and the release scenario gated until those pieces are reviewed and exercised in an authorized Meta Sandbox.
