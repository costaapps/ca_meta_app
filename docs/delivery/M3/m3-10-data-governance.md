# M3.10 / #35 — audit, minimization, retention and deletion

## Implementation scope

M3.10 adds schema v12 privacy ledgers, a recursive diagnostic redactor and closed structured-log/audit allowlists. The shared audit ledger covers verified authorization lifecycle changes, credential operations, verified-tenant identity denials, support access, retention policy activation/purge runs and deletion requests/status transitions. M2 replay remains in its existing append-only audit with operator, scope, action and safe reason.

Retention policy rows are tenant-, environment-, category- and version-scoped. Migrations seed no policy, the policy starts as `DRAFT`, and application authorization ports deny by default. Only `MAGIC_LINK_TRANSIENT` has an executable adapter, and that adapter is restricted to `NODE_ENV=test` while environment-specific data ownership remains **Not confirmed**. Runs lock their own row, persist a fixed cutoff and cursor/phase, write each batch audit in the transaction and can resume after `PAUSED` when an in-flight mail row reaches a terminal state.

Deletion requests hold only hashes of requester and target references, fixed scope/reason values, workflow status and an audit evidence reference. Tombstones are tenant-scoped and append-only. This M3.10 service does not delete business data or call Meta. `COMPLETED` records only an authorized workflow status; it is not evidence of provider-side erasure.

## Acceptance evidence map (planned; no tests run by package author)

| Issue criterion | Implementation / planned evidence | Current result |
|---|---|---|
| AC01 marker tokens absent from logs, traces, errors and audit | `privacy/redaction.ts`; shared logger; generic audit allowlist; `m3-10-privacy.spec.ts`; M3.06/M3.07 audit consumers | Implemented; execution pending |
| AC02 tenant/category isolation, cutoff, resumable purge | `RetentionService`; `privacy-governance.ts`; `retention-synthetic.json`; MariaDB integration test pauses on processing mail, resumes, and checks a second tenant and live record | Implemented for `MAGIC_LINK_TRANSIENT`; execution pending |
| AC03 deletion status/evidence without requester data | `DeletionRequestService`; hashed requester/target; append-only audit and tombstone; MariaDB integration fixture | Implemented metadata workflow only; execution pending |
| AC04 support/replay actor and reason | `SupportDiagnosticService` default-deny access/audit/redaction; existing `ca_meta_replay_audit`; identity denial events; credential operation audit | Implemented with fail-closed access ports; execution pending |
| AC05 backup/key retention compatible with recovery policy | M1.09 mapping and external decision list in privacy governance spec | **Not confirmed**; no real backup or key-retirement run is available |

## Policy and external limits

M1.09 proposes operational data up to 90 days, raw inbox up to 24 hours, optional history up to 30 days/10,000 records/1 GiB, security audit up to 365 days, and 30 days as a backup-storage sizing hypothesis. Each remains **Not confirmed**. No code default or migration activates those periods. The current API cannot purge inbox blobs, message history, dead jobs, audit history, logs, backups or old credential keys. Data-owner/legal/contract approval, actual backup restore/key custody, Meta deletion callbacks and support roles remain production gates.

## Harness

Install from the repository lockfile with `npm ci --ignore-scripts`, then run `pwsh -NoLogo -NoProfile -File tools/m3-10/run-retention-tests.ps1`. The script starts one UUID-named MariaDB Compose project with separate API/migration database users and removes only that project and its temporary SQL file unless `M3_10_KEEP_ENVIRONMENT=1` is set. The harness was added but not run on this package candidate.
