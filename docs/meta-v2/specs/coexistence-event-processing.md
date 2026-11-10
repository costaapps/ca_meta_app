# SPEC · Coexistence history, state and echo processing

Status: fail-closed processing seam implemented; provider ingestion and persistence adapter remain disabled. Issue: [#53](https://github.com/costaapps/ca_meta_app/issues/53). Depends on [M4.06 server finalization](coexistence-server-finalization.md), [M4.10 webhook inbox](webhooks.md), M2.05 durable persistence and M3.10 retention. Decision: [ADR-018](../adrs/ADR-018-m4-07-coexistence-event-processing.md). Functional owner: Meta integration.

## Scope and confirmed boundary

M4.10 validates signed raw deliveries, commits the durable inbox, expands entries into leaves, resolves each leaf to an internal tenant/app/asset route and passes leased leaves to a worker. Its current parser resolves `history` and `smb_message_echoes` leaves through a phone-number reference on that leaf. Leaves without a usable phone reference have no resource route and remain quarantined/tenantless. `smb_app_state_sync` deliberately has no resource route. M4.07 preserves these routing rules.

`CoexistenceWebhookItemProcessor` handles only M4.10's internal canonical history message/status and app-echo event types. It requires explicit `enabled: true`, an exact routed tenant/app/asset tuple, and a server-owned scope proving an active Coexistence authorization and verified WhatsApp phone ownership. A disabled processor rejects Coexistence leaves with a safe permanent code and never delegates them. Other product events keep using the configured fallback processor.

The implementation provides typed sink and scope-resolver ports only. No resolver, sink, history table, migration, provider request, automated reply, or production runtime registration is added. `enabled` defaults to false; the existing M4.10 default processor remains fail-closed. A future adapter must preserve the route and tenant boundary and must be reviewed before explicit wiring.

## Local processing contract

- The scope resolver reads trusted server-owned catalog/authorization records for the exact M4.10 tenant, app configuration, and internal phone asset. It returns only `WHATSAPP_PHONE_NUMBER` assets whose tenant ownership has been verified. Webhook fields never provide consent, tenant membership, authorization, retention, or flow identity.
- The scope must match the exact tuple and an active `WHATSAPP_COEXISTENCE` + `WHATSAPP_BUSINESS_APP_ONBOARDING` authorization. Missing, unknown, revoked, or mismatched data fails closed with a bounded safe reason.
- History message and status leaves require explicit server-owned history consent. App echoes require explicit server-owned echo consent. Unknown/declined consent is not converted to an import success.
- Every history message/status and app-echo record requires a server-owned future retention expiry. The port has no implicit retention period. The persistence implementation must enforce expiry and M3.10's approved retention/deletion policy.
- The sink must atomically deduplicate content by tenant/app/asset/providerMessageId and eventRef, and apply retention. Status transitions use eventRef plus the M4.10 status fence so later statuses for the same message are not collapsed. The worker retains M4.10's durable item lease/retry/dead-letter behavior. The echo/history event carries `suppressAutomation: true`; no automated send API is exposed here.
- Status leaves preserve M4.10's leased status fence so stale status updates cannot regress delivery state. Status dedupe retains distinct event references for later transitions and applies the same explicit history expiry. They remain subject to the unconfirmed provider event schema and M4.10's parser status mapping.
- The processor rejects `smb_app_state_sync` as `STATE_SYNC_SCHEMA_NOT_CONFIRMED` before looking up a tenant or calling a sink. Unknown Coexistence event families are permanently rejected with a safe reason. Tenantless leaves cannot enter this processor.

The fake test sink models stable message identity even if a duplicate echo arrives under a different inbox event reference, and preserves status idempotency by event reference. It does not demonstrate a database transaction. The real history/echo sink is absent.

## Acceptance criteria and evidence

| Issue criterion | Local evidence | Status and remaining gate |
|---|---|---|
| AC01 · A declined history request produces a specific outcome without fictitious import success | Declined server consent returns `HISTORY_CONSENT_DECLINED`; unknown consent returns `HISTORY_CONSENT_NOT_CONFIRMED`; neither calls the sink or reports import success. | Partial. Provider refusal/error shape and user-visible refusal state are **Not confirmed**. No provider history request is made. |
| AC02 · Redelivery does not duplicate a message or trigger a reply to the sender | M4.10 eventRef is passed unchanged; sink contract requires tenant/app/asset/eventRef atomic idempotency; echo and history are marked `suppressAutomation: true`. Synthetic fake sink checks repeated keys. | Partial. No durable M4.07 sink is registered, so DB idempotency and real echo/manual-send equivalence remain unproved. |
| AC03 · Worker interruption resumes from checkpoints | M4.10 provides durable inbox leases, retry state, status fence and safe item-level reprocessing; M4.07 sends events through that worker seam. | Partial. No provider history batch/cursor checkpoint exists because the history protocol is **Not confirmed**. Full import resume and no-loss progress remain **Not confirmed**. |
| AC04 · Sync deadline and partial state are visible and monitored | No deadline, sync progress model, UI or monitor was added. | Not implemented; blocked on a confirmed sync protocol, trigger/window, ownership state and measurable SLO. |
| AC05 · Another company's or phone's data never enters the same history/cache | Exact routed tenant/app/asset equality and verified phone ownership are required before sink; synthetic mismatch/unverified ownership cases fail closed. | Partial. A production catalog resolver and tenant-scoped persistent sink do not exist in this slice; integration and database isolation evidence remain required. |

## Not confirmed provider and release evidence

On 2026-11-10, lookup of the official [Business App onboarding page](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/) and [Graph Webhooks page](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/) returned HTTP 429. Search did not expose authoritative event schemas. The following remain **Not confirmed** and are release blockers for the corresponding behavior:

- Exact history, app-state and echo payload schemas, supported fields, ordering, and event availability by app/version.
- History trigger, user consent semantics, import window/retention bounds, batch/cursor protocol, completion signal and retry rules.
- `smb_app_state_sync` phone ownership fields and a safe route to a tenant/phone. It stays unprocessed and quarantined by M4.10.
- Which history refusal/error codes distinguish refusal from empty history or provider failure.
- Echo identity equivalence to API-originated sends and any permitted event subscription requirements.
- Product-side partial/progress display, deadline SLO, alerting and authorized real Sandbox evidence.

No 24-hour window, trigger, schema, subscription or eligibility is inferred. The event family names in the code are M4.10's normalized internal route names and do not assert that a live Meta payload has a particular schema. Official-source lookup requires a successful current primary-source review before changing this contract.

## Validation and rollout

Focused synthetic harness: [`tools/m4-07/README.md`](../../../tools/m4-07/README.md). Command: `node tools/m4-07/run-focused-test.mjs`. It compiles only the relevant API types, processor and synthetic test to a unique OS temp directory. The implementer did not run it; the coordinator runs it once on the package candidate. No credentials, real events, provider calls or production services are used.

The processor is opt-in and has no default production wiring. Enabling it requires a reviewed server-side scope resolver, durable sink with atomic idempotency and retention enforcement, confirmed provider event schemas and retention/consent semantics, updated tests, security review and exact-candidate validation. Until these gates close, M4.10's fail-closed processor and tenantless quarantine remain the runtime behavior. No migration or public API is introduced here.
