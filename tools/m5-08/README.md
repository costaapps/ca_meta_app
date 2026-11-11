# M5.08 synthetic legacy projection

This slice projects a fresh, tenant-scoped central metadata snapshot to preconstructed destination connections. A destination is selected only by the server-owned `(legacyDatabaseId, legacyCompanyId, environment)` allowlist. Event bodies carry the existing outbox envelope and opaque references; they never choose a database, company, DSN, token or credential. The adapter writes only asset metadata, a central asset reference, projection version/hash and tombstone marker. It does not select or copy automation message text, provider payloads or credentials.

The destination table names and column layout in the integration fixture are **provisional synthetic DDL**, not evidence of the enterprise schemas or deployed consumers. Real mappings, destination catalog provisioning, source data parity and PHP/deployed equivalence remain **Not confirmed**. The normal `JobsModule` composition now gives `OutboxService` a durable projection scheduler, so event, delivery job and `PROJECTION_RECONCILE` intent commit together. The projection worker handler and allowlisted destination runtime remain absent: this change persists intent but does not execute destination writes, and no production destination is configured by this package.

## Focused run

Requirements: the repository Node 24 runtime, npm workspace dependencies, MariaDB reachable only in a disposable local test environment, and the package-scoped credential file prepared for M5.08. The file is read locally; the harness imports only the listed M5.08 keys and never prints credential values. No additional package or lockfile dependency is required.

Run the mapper/service tests without a database:

```powershell
npm run test:m5-08 --workspace=@ca-meta/api
```

Run the one focused MariaDB integration with the dedicated schemas `ca_meta_m5_08`, `ca_meta_m5_08_dest_a`, and `ca_meta_m5_08_dest_b`:

```powershell
$env:M5_08_ENV_FILE = "$env:LOCALAPPDATA\Temp\ca-meta-m5-env-20261111\package-users.env"
$env:M5_08_PROJECTION_INTEGRATION = '1'
npm run test:m5-08 --workspace=@ca-meta/api
```

The env file must provide the `M5_08_TEST_DB_*`, `M5_08_CENTRAL_*`, and `M5_08_DEST_A/B_*` settings used by this harness. The migrator account is scoped to the dedicated central test schema; destination accounts are scoped to their respective disposable schemas and need test-fixture DDL/DML/trigger privileges. The integration command deploys the local central migration before compiling/running the two focused specs. It checks database names before test writes and stops if the schemas differ from the exact synthetic names.

The MariaDB integration creates only the synthetic `MetaConnectedPages`, `MetaConnectedNumbers` and `MetaAssetAutomationConfigs` fixtures in those isolated destination schemas. It injects a destination-local trigger error, verifies another destination and a second company in the first database still commit, retries after removing the trigger, exercises version/tombstone ordering, repairs a removed current row, and checks a full rebuild's expected/actual counts and hashes. A stale row with a known tenant checkpoint is tombstoned; an unowned extra is left untouched and forces an ambiguous/failed parity report. The source adapter fixture also verifies two tenants sharing a legacy database but different companies, tenant-fenced event loading, active versus revoked grants, and rejection of a relation whose parent lacks a same-target mapping. The test checks that the central event plus `OUTBOX_DELIVER`/`PROJECTION_RECONCILE` jobs commit once and that target fixtures have no token/secret/password/DSN/message/payload columns. All event, tenant and resource IDs are synthetic.

Cleanup removes rows keyed by the run's random synthetic tenant and exact synthetic company/database IDs, removes the fault trigger and closes connections. The migration ledger/checkpoint table and empty fixture table remain in the dedicated schemas so the command is repeatable. Never point these commands at shared, customer or production schemas.

## Implemented boundary and gaps

- The `JobsModule` `OutboxService` provider installs `DurableLegacyProjectionJobScheduler`; the projection job is added using the same caller transaction as the event and delivery job. A repeated event does not enqueue another projection job. The projection worker/runtime remains unregistered and fail-closed.
- If a separately reviewed runtime registers a handler, it must reload the tenant-owned outbox event and ask the central source adapter for current state. A retry of an old event cannot replay its old event payload as destination data.
- The source adapter projects only allowlisted grants whose tenant, authorization, asset, provider and environment match and whose grant is `GRANTED`; authorization and asset authorization must remain active/verified. Relations whose parent has no mapping for the same target tuple fail with a safe code rather than becoming a null parent.
- Checkpoints are tenant-scoped and keyed by a hash of the complete destination tuple and central resource reference. Central checkpoint commit and destination transaction are intentionally separate; an ambiguous destination acknowledgement is safe to retry by version/hash upsert.
- A rebuild consumes a trusted current-state scan and scopes reconciliation to the exact mapped `(legacyDatabaseId, legacyCompanyId, environment)` destination. It replays current rows, reports expected/actual counts and hashes, and tombstones only stale extras tied to a checkpoint for that tenant and destination. Unknown extras are never changed and make parity ambiguous/failed; reports do not claim parity in that case.
- No live adapter is installed. This implementation does not prove a distributed transaction, deployed DDL compatibility, actual per-company mappings, credentials, real consumer parity, automatic tenant rebuild scheduling, or production retry/latency behavior.
