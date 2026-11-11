# SPEC — Internal service asset operations

Status: proposed; local API and synthetic harness implemented. Issue: [#62](https://github.com/costaapps/ca_meta_app/issues/62). Contracts: [canonical OpenAPI](../contracts/openapi.yaml), [credential resolver](credential-resolver.md), [M4.14 certification evidence](../../delivery/M4/M4.14.md), and [M4.02 Graph boundary](../adrs/ADR-011-m4-02-graph-transport-boundary.md). Functional owner: Msg4/Suite4 integration and backend; person unassigned. Code evidence base: `c3e9baa75ea793d74292e62038e0d8d11bb61295`; deployed consumers and production configuration are **Not confirmed**.

## Scope and evidence boundary

The versioned repository contains the PHP sources listed below. They establish source-level behavior only; they do not prove deployed routing, `GeneralSettings`, a live `SYSTEM_ROOT_USER_TOKEN`, or any consumer outside this repository. The local-only `backend/connect.php` and `backend/connect_old.php` were not opened or used.

| Versioned consumer/source | Observed operation | Bridge mapping | Migration state |
|---|---|---|---|
| `backend/connect_whatsapp.php` `getWhatsappTemplates` and `createWhatsappTemplate` (GET/POST `/whatsapp/templates`, lines 760–872) | Uses `SYSTEM_ROOT_USER_TOKEN`; maps a company and phone reference to a WABA before listing/creating templates. | `MANAGE_TEMPLATES` with `LIST` or `CREATE`; preserve `language`, `body`, and `example_values` as typed `language`, `bodyText`, and `exampleValues`. Caller must first resolve its old identifiers to an authorized internal asset UUID. | Static mapping only; not migrated. Legacy database mapping and template equivalence are not exercised against Msg4. |
| `backend/connect_whatsapp.php` `actionNotification` and `sendWhatsAppMessage` (lines 648–758 and 894–924) | `SEND_TEMPLATE` constructs a WhatsApp template payload and calls the helper using a server global token. The `SEND_MESSAGE` branch is commented out. | `SEND_MESSAGE` with a `TEMPLATE` message; use a server-derived asset UUID and recipient reference. Do not claim equivalence for the commented-out text branch. | Static mapping only; actual recipient/asset mapping and provider result shape are **Not confirmed**. No sends are made by the harness. |
| `backend/connect_whatsapp.php` `actionNotification` Facebook `REPLY_COMMENT` branch (lines 734–751) | Loads `CommentPublicReply` and `PageAccessToken` from the versioned legacy database helper path and posts a comment response. | `MANAGE_COMMENTS` with `REPLY`; caller must map legacy comment/page IDs to tenant-authorized internal references. | Static mapping only; no live or PHP contract test, no double-writer test with deployed Msg4. |
| `backend/connect_whatsapp.php` `facebookCallback` (lines 397–423) | Uses the global root token for a WABA subscription call; a separate subscription call is also present in `backend/connect_facebook.php` (line 159) using a page token. | `SUBSCRIBE_WEBHOOKS` with `RECONCILE`, after current WABA/Page grant selection and M4.11 reconciliation policy. | Not migrated. Exact provider permissions, cross-number ownership and live subscription behavior remain **Not confirmed**. |
| `backend/connect_facebook.php`, `backend/connect_instagram.php` | Versioned OAuth callbacks exchange user codes and use a user token to discover Page/Instagram assets; Facebook callback stores per-page tokens. | Keep these onboarding flows in their respective M4 flow contracts. Any later `SEND_MESSAGE`, `MANAGE_COMMENTS`, or `READ_STATUS` operation needs the matching asset authorization and operation policy. | No versioned outbound Facebook/Instagram message consumer was identified in these files. Other consumers and deployed behavior are **Not confirmed**. |
| `GeneralSettings`, operational jobs, integrations outside the tracked source inventory | No source or runtime inventory was available in this checkout. | Require a separately owned inventory and a compatible internal client before any cutover. | **Not confirmed**; do not claim migrated or removed. |

The checked-in endpoint and parity inventories in `docs/baseline/endpoint-matrix.csv`, `docs/baseline/inventory.md`, and `docs/baseline/parity-matrix.md` support the same source-level mapping. They are not production traffic evidence.

## Internal API contract

- `POST /internal/v1/assets/{assetId}/operations` accepts a closed union: `SEND_MESSAGE`, `MANAGE_TEMPLATES`, `MANAGE_COMMENTS`, `READ_STATUS`, and `SUBSCRIBE_WEBHOOKS`.
- `GET /internal/v1/operations/{operationId}` returns status only to the same server-mapped service principal and tenant that created the row.
- The bearer proof is verified against a hash-only runtime allowlist entry mapping exactly one principal and tenant. Each call re-reads the active database service grant and requires `META_CONNECTION_EXECUTE`; operation execution also checks `CREDENTIAL_USE` before M3.08 resolution.
- `tenantId`, app configuration, flow, auth variant, provider ID, credential family, and token are server-derived. Unknown keys and arbitrary URLs are rejected. `company_uuid` is not accepted as authority.
- `recipientRef` and `commentRef` are internal Msg4 references. The API resolves them through a tenant/asset-bound target resolver before it claims an operation. No target-directory integration is present in this repository, so those operations currently fail closed.
- A unique `UNKNOWN` row and audit entry are committed before an adapter can be invoked. The database stores an idempotency hash and canonical request hash, fixed status/reason codes, internal IDs, and an optional one-way provider-reference hash. It does not store operation payload text or raw provider IDs.
- The same key and payload returns the saved `operationId` and current status without a second adapter call. A concurrent replay can observe the initial `UNKNOWN` while the first request is still running; callers can poll the status route for a terminal result. Reusing the key with a different payload returns 409. Timeout/response loss after adapter invocation stays `UNKNOWN`; callers must reconcile by `operationId`, never retry blindly.
- Current Meta app capability evidence and the installed adapter are fail-closed. Meta API versions/permissions/App Review/Sandbox and real provider actions remain gates; no fixture or local mock passes those gates.

## Rotation and revocation

1. Provision a high-entropy service proof into the caller's protected secret store; configure only its SHA-256 digest with one `principalId` and one `tenantId` in `API_INTERNAL_SERVICE_CREDENTIAL_HASHES_JSON`.
2. For rotation, overlap old/new hash entries during rollout, switch the caller after every API replica has loaded the new entry, then remove the old entry and roll replicas again.
3. For revocation, remove the proof digest and revoke the corresponding service scope/grant. Both take effect only after the relevant API replicas have reloaded configuration; database grant revocation is checked per request.
4. Never copy the proof or a Meta token into web storage, application JSON, audit events, logs, PHP source, fixtures, or this repository.

No live service proof issuance, caller ownership, production secret distribution, revocation drill, or rotation drill has been exercised.

## Compatibility, rollout and recovery

Each old PHP operation needs a server-side compatibility adapter that converts its company/phone/page identifiers only after verifying the caller's pre-existing tenant mapping and selecting one internal asset. The current API deliberately accepts neither `company_uuid` nor provider IDs as authority, and this package does not edit PHP consumers. The caller migration sequence is:

1. Inventory the deployed route, scheduled job, caller identity, and owning team; compare them with the tracked source matrix above.
2. Build a contract fixture per consumer with synthetic IDs and expected typed request. Verify the old UI/error behavior separately from provider effects.
3. Start with one consumer/tenant/asset and one writer. Pause the legacy writer before enabling the new operation. Shadow-read may compare normalized metadata; never shadow-send or run two writers.
4. Reconcile the new operation by `operationId`. Keep `UNKNOWN` visible and block another send until provider evidence resolves it. A rollback may restore routing before new effects begin; it cannot undo a message or recreate a revoked grant.
5. Remove legacy token reads only after runtime traffic and consumer ownership are evidenced. Do not revoke a shared token or claim the consumer is retired from source edits alone.

The local harness checks synthetic request mapping, target-resolution denial, idempotency and secret absence. It does not execute PHP, establish deployed parity, send Meta traffic, prove permissions, or certify Suite4. Consumer equivalence, external runtime inventory, production recipient/comment mapping, provider outcome reconciliation, Meta Sandbox, Suite4, production DDL/rollout and real rollback are **Not confirmed**.
