# M4.10 synthetic webhook harness

The focused harness uses the repository's pinned npm workspace dependencies and synthetic data. Its default unit run does not require a Meta app, credentials, database, or network access.

From the repository root, install the committed lockfile dependencies once with `npm ci`, then run:

```powershell
node tools/m4-10/run-focused-test.mjs
```

The script compiles the API and TypeScript fixtures into a uniquely named temporary directory under `apps/api/`, runs only the M4.10 unit and integration fixtures, and removes that directory in `finally`. It requires Node 24.15 or newer in the Node 24 line. The MariaDB fixture is skipped unless explicitly enabled.

To run the MariaDB fixture, configure `MIGRATION_DATABASE_*`, `API_DATABASE_*`, and the other required environment variables for an isolated disposable MariaDB schema, then run:

```powershell
$env:M4_10_MARIADB_TEST = '1'
node tools/m4-10/run-focused-test.mjs
Remove-Item Env:M4_10_MARIADB_TEST
```

The fixture deploys registered migrations, uses UUID-scoped synthetic tenants/assets/events, and removes only its own rows in `finally`. A successful replay audit is append-only by contract, so its synthetic audit row, terminal event, and minimal tenant/app/asset mapping remain; the protected delivery bytes and other fixture rows are removed. Migration ledger rows and schema objects also remain in the disposable schema. Do not point it at production or a shared customer database.

The script was added as reproducible test evidence. It was not executed by the implementation agent; the milestone coordinator runs the focused gate on the integrated candidate SHA.

## Implementation map

- Raw body boundary and 256 KiB parser limit: `apps/api/src/http-boundaries.ts` and `apps/api/src/meta-webhooks/meta-webhook-validation.ts`.
- GET/POST use the canonical `/api/v1/webhooks/meta/{appConfigRef}` route. The resolver selects exactly one enabled profile by `configurationRef` in the runtime environment and fails closed on duplicates; the raw-body parser and originless POST allowlist share that route pattern.
- GET challenge uses the separate `verificationToken` provider method. POST verifies `X-Hub-Signature-256` over the exact raw bytes against up to three current/previous App Secret versions with `timingSafeEqual` before JSON parsing.
- Envelope, entries, changes, `messages`, `statuses` (including those nested under history/echo fields), and page `messaging` items have structural, UTF-8, depth, node-count, entry-count, and item-count bounds. Status identity includes the full normalized item, preserving distinct status transitions.
- Per-item routing is limited to opaque provider asset identifiers, app ID and runtime environment. The repository matches active, verified local catalog/authorization rows and quarantines unknown, missing, or conflicting identities with all tenant and asset columns null. It does not read tenant or phone-number text from provider payloads.
- WhatsApp WABA fallback is limited to account-level `account_update` change items. `history` and `smb_message_echoes` message/status items require their own leaf `phone_number_id`; missing references, other unconfirmed shapes, and `messages`/`statuses` without `metadata.phone_number_id` remain tenantless and quarantined. `entry.id` does not substitute for a phone-number ID on those items. The structure and availability of the history, echo, and app-state event families remain **Not confirmed**.
- Raw body bytes are held only by an injected protected-payload port. The fail-closed default has no key, secret, or retention policy; a configured adapter must return authenticated ciphertext metadata and its policy expiry. The worker purges expired payload records only after routed processing is terminal. Quarantined items remain replayable only while their evidence is retained; later replay attempts are audited as unavailable.
- Durable deliveries persist the exact `app_configuration_ref`, provider App ID, and original environment alongside the protected envelope. Audited replay joins the quarantined event to that delivery, resolves exactly the same configuration reference in the original runtime environment, and verifies the stored provider App ID/environment before routing. Missing, disabled, duplicate, or mismatched configuration context fails closed. Provider App ID remains internal provider identity and is not used to choose a replay profile.
- Durable per-item rows use an app/environment/event uniqueness key, a unique-index race check before ACK, fenced leases, bounded retry/dead-letter state, and an append-only replay audit. Processing is a local idempotent port and does not call Meta.
- Status items persist `schemaVersion`, the provider message ID, provider status and provider timestamp only after signature verification. A per-tenant/app/environment/asset/message lock serializes status processing across workers. Before a claim, the repository compares timestamp and known progress rank with the last processed status: older or rank-regressive states are suppressed, exact-same states are terminally suppressed, and unknown ranks or ambiguous ties are dead-lettered. The lock lease and event lease are released atomically at finalization and a status fence is passed to the local processor, which must check it atomically before applying state. The local order policy covers known WhatsApp `sent` → `delivered` → `read` → `played`; product/provider ordering guarantees remain **Not confirmed**.
- `ApiModule` now registers `MetaWebhooksModule` with the existing `metaAssetsModule` dynamic module, so API ingress and asset routes share its durable-work database provider. The central migration registry includes the existing M4.10 migration and table inventory.
- The registered migration keeps its stable ID `202611060010-meta-webhooks` and uses schema version 17, after M4.03's schema version 16. M4.11 is expected to use 18 after the M4.03 rebase; this worktree currently starts from the M4.02 baseline.
- `worker/main.ts` has an explicit webhook loop lifecycle. It starts only when both the protected-payload and local item-processor adapters are installed; this package returns no such adapters, so webhook events are not claimed or processed by default.

## M4.10 criterion evidence

The unit fixture covers exact-byte HMAC and secret rotation, separate challenge token use, canonical appConfigRef resolution and duplicate rejection, account-level WABA routing versus missing-phone quarantine, item-level history/echo leaf references, multiple message/status items, malformed and oversized envelopes, signature-before-parse order, ACK-after-persistence, unknown/conflicting asset quarantine, concurrent duplicate delivery, stale and rank-regressive status suppression, unknown-rank ambiguity, processor status fencing, DB commit failure, and worker failure retry behavior. The optional MariaDB fixture covers concurrent status-lock claims, stale-fence rollback, tenantless quarantine for conflicting/unknown assets, grant-scope assertions, and audited replay after an asset is mapped. It also supplies two profiles sharing a provider App ID and verifies replay selects the exact configuration reference stored with the source delivery. No real Meta credentials or network calls are used. These checks are authored but remain unrun on this branch by assignment; record the integrated SHA and actual gate result in the milestone handoff.

Meta's current callback retry window and product-specific subscription guarantees remain **Not confirmed**. This implementation defines only local queue retry and does not assume a universal 36-hour provider retry policy.
