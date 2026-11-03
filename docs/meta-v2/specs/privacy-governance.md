# Privacy governance, audit and retention

Issue: [#35 — M3.10](https://github.com/costaapps/ca_meta_app/issues/35). This specification implements local privacy controls against the accepted M1.05 audit shape and the M1.09 retention proposal. It does not declare a legal policy or production approval.

## Required behavior

- Store security and operational audit events with tenant, pseudonymous actor reference, action, internal target, correlation, allowlisted safe diff, retention class, optional policy version and timestamp.
- Redact logs and diagnostics before serialization or display. Structured logs have a closed field allowlist; audit diffs have the M1.05 `before`, `after`, `status`, `policyVersion`, `version`, and `reasonCode` allowlist.
- Keep retention policies scoped by tenant, runtime environment, category and version. No policy or duration is seeded by migration. Activation needs an approval reference and server authorization; the shipped authorization port denies by default.
- Persist purge progress in a tenant/category/environment scoped run. A run has a fixed cutoff and phase cursor, deletes bounded batches, writes its audit event in the same transaction, pauses when a mail delivery is still processing and resumes after the work becomes terminal.
- Keep deletion requests and tombstones metadata-only. Hash the requester and target references, return status plus evidence reference, and record each status transition with a fixed reason enum. This service does not invoke Meta or delete provider assets.
- Require a short-lived authorization grant and a fixed reason code before support diagnostics are read. Sanitize returned diagnostics. No support controller, screen or export exists in this API package yet.

## Implemented local category

`MAGIC_LINK_TRANSIENT` is the only category that can be activated in the schema, and its service execution is currently restricted to `NODE_ENV=test`. It applies to one tenant and one runtime environment. It purges expired magic-link mail-queue rows in terminal states before expired link rows. An in-flight `PROCESSING` mail row pauses the run. `M3_10_TEST` uses synthetic tenants, links and recipient ciphertext in a UUID-scoped disposable MariaDB. Production environment-to-database ownership and tenant treatment across environments are **Not confirmed**, so the adapter cannot run in staging or production.

The category registry is intentionally closed. Inbox envelopes, durable jobs, message history, audit events, logs, credential versions, backups, key material and object-store blobs cannot be purged by this package. Their owners and storage systems must add a category-specific purge adapter and recovery proof before a policy can be activated. M1.09's proposed values (operational data up to 90 days, raw inbox up to 24 hours, optional history up to 30 days/10,000 records/1 GiB, security audit up to 365 days, and a 30-day backup sizing hypothesis) remain **Not confirmed** and are not copied into executable defaults.

## Lifecycle audit points

- M3.06 authorization snapshots write `AUTHORIZATION_CONNECTED`, `AUTHORIZATION_REAUTHORIZED`, `AUTHORIZATION_OBSERVED` or `AUTHORIZATION_DISCONNECTED` in the same transaction as the state/outbox update. Browser claims without verified provider evidence are recorded as observations. The source platform's exact meaning of a renewed authorization remains **Not confirmed**.
- M3.07 credential store, use and rotation append metadata-only `ASSET_OPERATION` events alongside the existing credential access audit. Event fields contain operation reason and key version only.
- Identity administration denials within a verified tenant write `AUTHORIZATION_DENIED` with a fixed reason code and a constant target. Unverified callers do not get a tenant-scoped event.
- M2 durable replay already records operator reference, authorization reference, scope, action and safe reason code in `ca_meta_replay_audit`. Its authorization adapter remains fail-closed until a trusted operator-role adapter is supplied.
- Support diagnostics, retention runs and deletion status transitions are written to `ca_meta_audit_events`. Audit and tombstone rows are append-only.

## Decisions still required before production

- Data owner, Product, Legal/privacy and customer contracts must approve purpose, lawful basis/consent, categories, retention periods, legal hold, deletion scope and status meanings. Current approval is **Not confirmed**.
- Backup expiry, snapshot/WAL retention, key recovery, old credential-version retirement, object-store purge and restore tests are not controlled by this API. Compatibility between actual backup lifetime and key lifetime is **Not confirmed**.
- Meta deletion/disconnection callbacks and provider asset deletion semantics are **Not confirmed**. A local deletion request never implies a provider-side delete or subscription mutation.
- Suite4 support roles and any exported diagnostic screen are **Not confirmed**. The new ports default to deny until a verified server authority is wired.

## Planned verification

The executable harness is [tools/m3-10/run-retention-tests.ps1](../../../tools/m3-10/run-retention-tests.ps1). Its tests are [m3-10-privacy.spec.ts](../../../apps/api/test/m3-10-privacy.spec.ts) and [m3-10-privacy.integration.spec.ts](../../../apps/api/test/m3-10-privacy.integration.spec.ts). Local focused validation passed 6 M3.10 tests; the MariaDB fixture was skipped without `M3_10_TEST`. The M3.06 unit fixture passed 13/13. The first hosted run stopped in the M2.03 migration-chain assertion because it expected versions 1–11; this change updates that harness and its documentation to include v12. Hosted CI, including the M3.10 MariaDB fixture, remains pending.
