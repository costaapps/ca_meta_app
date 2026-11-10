# ADR-017 — M4.04 exclusive WhatsApp registration boundary

Status: Accepted for the M4.04 implementation candidate. Date: 2026-11-10.

## Context

Issue [#48](https://github.com/costaapps/ca_meta_app/issues/48) requires an exclusive WhatsApp Cloud API provisioning path, per-number readiness and resumable failures. M4.03 already stores a tenant-bound JSON saga checkpoint; M3.06 persists verified WABA/phone assets and grants; M4.11 stores WABA subscription reconciliation. No current asset column records conventional phone registration readiness. Meta's official Postman collection documents `POST /{Phone-Number-ID}/register` with a six-digit PIN and a system-user token with `whatsapp_business_messaging`, but this app's exchanged token eligibility and a protected tenant-scoped PIN input are **Not confirmed**.

## Decision

1. Keep conventional registration as a closed Graph operation `PHONE_REGISTRATION_CONVENTIONAL`, with the only path `/register`, an exact six-digit request body, and a hard `WHATSAPP_EXCLUSIVE + WHATSAPP_EMBEDDED_SIGNUP` guard before credential use. Never retry ambiguous POSTs; reconcile read-only first.
2. Persist bounded per-phone readiness in existing `saga_checkpoint_json`, validated against exact tenant/authorization and verified phone asset refs. Store only internal refs, safe state/reason codes and timestamps. This avoids a v19 schema change while v18 is sufficient for durable recovery.
3. Keep the exclusive adapter/module separate and unregistered by default. Production operations remain unavailable until server-side OAuth exchange, grant-aware selected asset discovery, M4.11 subscriptions, projection, token eligibility and a protected tenant-scoped PIN source are connected and reviewed.
4. If registration state, exact credential eligibility or the protected PIN is missing, record `ACTION_REQUIRED`/`UNKNOWN` and keep onboarding partial. Never use browser IDs as grants and never fall back to a root/service token.

## Consequences

- The M4.03 worker and status contract gain a safe, resumable per-number checkpoint and portal projection without a migration.
- Existing companies/connections are not removed or replaced when adding a number.
- The local Graph route is testable with synthetic credentials, but no real registration is enabled or certified by this decision.
- Coexistence cannot reach the conventional registration route.

## Evidence limits

Official sources: [Meta WhatsApp Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Meta registration folder](https://www.postman.com/meta/whatsapp-business-platform/folder/zuoeksl/registration), and [Meta Embedded Signup collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup). Exact provider status fields, app-specific permissions/access, token type returned by this Embedded Signup configuration, PIN handling lifecycle and live behavior are **Not confirmed**.
