# M5.08 synthetic legacy projection

The recomposed milestone candidate is based on `44ef7a4610bbaa1c3053ec0d73f66716edbc2a49`. Its central checkpoint migration is v25, following the M5.06 v24 migration; the focused harness deploys the complete contiguous registry through v25.

This slice projects a fresh, tenant-scoped central metadata snapshot to preconstructed destination connections. A destination is selected only by the server-owned `(legacyDatabaseId, legacyCompanyId, environment)` allowlist. Event bodies carry the existing outbox envelope and opaque references; they never choose a database, company, DSN, token or credential. The adapter writes only asset metadata, a central asset reference, projection version/hash and tombstone marker. It does not select or copy automation message text, provider payloads or credentials.

The destination table names and column layout in the integration fixture are **provisional synthetic DDL**, not evidence of the enterprise schemas or deployed consumers. Real mappings, destination catalog provisioning, source data parity and PHP/deployed equivalence remain **Not confirmed**. The normal `JobsModule` composition now gives `OutboxService` a durable projection scheduler, so event, delivery job and `PROJECTION_RECONCILE` intent commit together. The projection worker handler and allowlisted destination runtime remain absent: this change persists intent but does not execute destination writes, and no production destination is configured by this package.

## Focused run

Requirements: the repository Node 24 runtime, npm workspace dependencies, MariaDB reachable only in a disposable local test environment, and the package-scoped credential file prepared for M5.08. The file is read locally; the harness imports only the listed M5.08 keys and never prints credential values. No additional package or lockfile dependency is required.

Run the mapper/service tests without a database:

```powershell
npm run test:m5-08 --workspace=@ca-meta/api
```

Run the one focused MariaDB integration with the fixed fresh schemas `ca_meta_m5_08_v25`, `ca_meta_m5_08_v25_dest_a`, and `ca_meta_m5_08_v25_dest_b`. The test refuses any different database name; it does not accept arbitrary schema names from environment variables:

```powershell
$env:M5_08_ENV_FILE = "$env:LOCALAPPDATA\Temp\ca-meta-m5-env-20261111\package-users.env"
$env:M5_08_PROJECTION_INTEGRATION = '1'
npm run test:m5-08 --workspace=@ca-meta/api
```

The env file must provide the `M5_08_TEST_DB_*`, `M5_08_CENTRAL_*`, and `M5_08_DEST_A/B_*` settings used by this harness. The migrator account is scoped to the dedicated central test schema; destination accounts are scoped to their respective disposable schemas and need test-fixture DDL/DML/trigger privileges. The integration command deploys the local central migration before compiling/running the two focused specs. It checks database names before test writes and stops if the schemas differ from the exact synthetic names.

The MariaDB integration creates only the synthetic `MetaConnectedPages`, `MetaConnectedNumbers` and `MetaAssetAutomationConfigs` fixtures in those isolated destination schemas. It injects a destination-local trigger error, verifies another destination and a second company in the first database still commit, retries after removing the trigger, exercises both active/revocation application orders, repairs a removed current row, and checks a full rebuild's expected/actual counts and hashes. It verifies that events for the same tenant resource share a durable job scope and cannot be claimed concurrently; a version conflict remains retryable so the next handler attempt reloads current state. It corrupts a projected field while preserving the old `ContentHash`, then verifies both `apply()` and `reconcile()` repair the field from the trusted current record and that reconciliation recomputes actual-field hashes before reporting `MATCHED`. A stale row with a known tenant checkpoint is tombstoned; an unowned extra is left untouched and forces an ambiguous/failed parity report. The source adapter fixture also verifies two tenants sharing a legacy database but different companies, tenant-fenced event loading, active versus revoked grants, and rejection of a relation whose parent lacks a same-target mapping. The test checks that the central event plus `OUTBOX_DELIVER`/`PROJECTION_RECONCILE` jobs commit once and that target fixtures have no token/secret/password/DSN/message/payload columns. All event, tenant and resource IDs are synthetic.

### Confirmed code snapshot

The focused review corrections are included in functional code SHA `047b0614be59531a5c0468cfd0d2160875e74c11`. The run used Node `v24.22.2` from `C:\Users\user\AppData\Local\Temp\ca-meta-m5-node-runtime-20261111\node.exe`, npm `11.19.1`, the shared workspace `node_modules`, and the existing disposable MariaDB `11.8.8` instance on `127.0.0.1:13307`. The package env file supplied only the synthetic central/destination test accounts; its values were not printed. The source snapshot was checked with:

```powershell
$env:Path = 'C:\Users\user\AppData\Local\Temp\ca-meta-m5-node-runtime-20261111;' + $env:Path
$env:M5_08_ENV_FILE = Join-Path $env:LOCALAPPDATA 'Temp\ca-meta-m5-env-20261111\package-users.env'
$env:M5_08_PROJECTION_INTEGRATION = '1'
node --version
npm run test:m5-08 --workspace=@ca-meta/api
npm run typecheck --workspace=@ca-meta/api
git diff --check
git rev-parse HEAD
```

At that source SHA, Node reported `v24.22.2`; the focused harness reported migration applied and 10/10 pass, 0 skipped, including both MariaDB integration tests. API typecheck and `git diff --check` passed. This result is tied to the code SHA above; this documentation update does not claim those checks ran on its later commit. Destination runtime remains disabled and real destination DDL/catalog, mappings, credentials, provider/deployed consumer behavior and PHP equivalence remain **Not confirmed**.

Cleanup removes rows keyed by the run's random synthetic tenant and exact synthetic company/database IDs, removes the fault trigger and closes connections. The migration ledger/checkpoint table and empty fixture table remain in the dedicated schemas so the command is repeatable. Never point these commands at shared, customer or production schemas.

## Implemented boundary and gaps

- The `JobsModule` `OutboxService` provider installs `DurableLegacyProjectionJobScheduler`; the projection job is added using the same caller transaction as the event and delivery job. A repeated event does not enqueue another projection job. The projection worker/runtime remains unregistered and fail-closed.
- If a separately reviewed runtime registers a handler, it must reload the tenant-owned outbox event and ask the central source adapter for current state. A retry of an old event cannot replay its old event payload as destination data.
- The source adapter projects only allowlisted grants whose tenant, authorization, asset, provider and environment match and whose grant is `GRANTED`; authorization and asset authorization must remain active/verified. Relations whose parent has no mapping for the same target tuple fail with a safe code rather than becoming a null parent.
- Checkpoints are tenant-scoped and keyed by a hash of the complete destination tuple and central resource reference. Central checkpoint commit and destination transaction are intentionally separate; an ambiguous destination acknowledgement is safe to retry by version/hash upsert. Projection jobs for the same tenant resource share `resourceScopeRef`, so the durable queue serializes them while preserving a distinct idempotency key per event. A projection version conflict is retryable; each retry reloads current central state and recalculates its version/hash.
- A rebuild consumes a trusted current-state scan and scopes reconciliation to the exact mapped `(legacyDatabaseId, legacyCompanyId, environment)` destination. It replays current rows, recomputes hashes from the projected columns actually read, repairs owned field/hash drift when the trusted current version is not older, reports expected/actual counts and hashes, and tombstones only stale extras tied to a checkpoint for that tenant and destination. Unknown extras are never changed and make parity ambiguous/failed; reports do not claim parity in that case.
- No live adapter is installed. This implementation does not prove a distributed transaction, deployed DDL compatibility, actual per-company mappings, credentials, real consumer parity, automatic tenant rebuild scheduling, or production retry/latency behavior.
