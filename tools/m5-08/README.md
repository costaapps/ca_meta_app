# M5.08 synthetic legacy projection

The recomposed milestone candidate is based on `44ef7a4610bbaa1c3053ec0d73f66716edbc2a49`. Its central checkpoint migration is v25, following the M5.06 v24 migration; the focused harness deploys the complete contiguous registry through v25.

This slice projects a fresh, tenant-scoped central metadata snapshot to preconstructed destination connections. A destination is selected only by the server-owned `(legacyDatabaseId, legacyCompanyId, environment)` allowlist. Event bodies carry the existing outbox envelope and opaque references; they never choose a database, company, DSN, token or credential. The adapter writes only asset metadata, a central asset reference, projection version/hash and tombstone marker. It does not select or copy automation message text, provider payloads or credentials.

The destination table names and column layout in the integration fixture are **provisional synthetic DDL**, not evidence of the enterprise schemas or deployed consumers. Real mappings, destination catalog provisioning, source data parity and PHP/deployed equivalence remain **Not confirmed**. The focused harness explicitly injects a durable projection scheduler to verify atomic outbox, delivery-job and `PROJECTION_RECONCILE` intent. The default `JobsModule` leaves the scheduler disabled until a matching projection runtime exists, so ordinary API events do not consume tenant queue capacity. Projection replay and rebuild remain deferred until that runtime and its destination catalog are reviewed.

## Focused run

Requirements: the repository Node 24 runtime, npm workspace dependencies, MariaDB reachable only in a disposable local test environment, and the package-scoped credential file prepared for M5.08. The file is read locally; the harness imports only the listed M5.08 keys and never prints credential values. No additional package or lockfile dependency is required.

Run the mapper/service tests without a database:

```powershell
npm run test:m5-08 --workspace=@ca-meta/api
```

Run the one focused MariaDB integration with the fixed fresh schemas `ca_meta_m5_08_v25`, `ca_meta_m5_08_v25_dest_a`, and `ca_meta_m5_08_v25_dest_b`. The test refuses any different database name; it does not accept arbitrary schema names from environment variables:

```powershell
$env:M5_08_ENV_FILE = "$env:LOCALAPPDATA\Temp\ca-meta-m5-env-20261111\package-users-m508-v25.env"
$env:M5_08_PROJECTION_INTEGRATION = '1'
npm run test:m5-08 --workspace=@ca-meta/api
```

The env file must provide the `M5_08_TEST_DB_*`, `M5_08_CENTRAL_*`, and `M5_08_DEST_A/B_*` settings used by this harness. The runner checks host `127.0.0.1`, port `13307`, and the exact three fixed synthetic schema names before invoking the migration CLI. The migrator account is scoped to the dedicated central test schema; destination accounts are scoped to their respective disposable schemas and need test-fixture DDL/DML/trigger privileges. The integration command deploys the local central migration before compiling/running the two focused specs. It checks database names again before fixture writes.

The MariaDB integration creates only the synthetic `MetaConnectedPages`, `MetaConnectedNumbers` and `MetaAssetAutomationConfigs` fixtures in those isolated destination schemas. It injects a destination-local trigger error, verifies another destination and a second company in the first database still commit, retries after removing the trigger, exercises both active/revocation application orders, repairs a removed current row, and checks a full rebuild's expected/actual counts and hashes. It verifies that two authorization events linked to one asset share a tenant-wide connection-job scope and cannot be claimed concurrently; a divergent higher-version destination remains pending instead of marking a lower-version tombstone synced. It corrupts a projected field while preserving the old `ContentHash`, then verifies both `apply()` and `reconcile()` repair the field from the trusted current record and that reconciliation recomputes actual-field hashes before reporting `MATCHED`. A stale row with a known tenant checkpoint is tombstoned; an unowned extra is left untouched and forces an ambiguous/failed parity report. The source adapter fixture also verifies two tenants sharing a legacy database but different companies, tenant-fenced event loading, shared assets through two authorization records, partial/final revocation, active versus revoked grants, and rejection of a relation whose parent lacks a same-target mapping. The focused test explicitly injects the scheduler to check atomic outbox/job commit; default API composition does not enqueue projection jobs while the runtime is absent. Target fixtures have no token/secret/password/DSN/message/payload columns. All event, tenant and resource IDs are synthetic.

### Confirmed code snapshot

The final M5.08 functional code snapshot tested by the targeted MariaDB cases is `9213c3b23a08a7112b0956607b4e164319d301dc`; the documentation commit is later. The run used Node `v24.22.2` from `C:\Users\user\AppData\Local\Temp\ca-meta-m5-node-runtime-20261111\node.exe`, npm `11.19.1`, the shared workspace `node_modules`, and the existing disposable MariaDB `11.8.8` instance on `127.0.0.1:13307`. The environment file was `C:\Users\user\AppData\Local\Temp\ca-meta-m5-env-20261111\package-users-m508-v25.env`; it supplied only the synthetic central/destination test accounts and its values were not printed.

```powershell
$env:Path = 'C:\Users\user\AppData\Local\Temp\ca-meta-m5-node-runtime-20261111;' + $env:Path
$env:M5_08_ENV_FILE = Join-Path $env:LOCALAPPDATA 'Temp\ca-meta-m5-env-20261111\package-users-m508-v25.env'
$env:M5_08_PROJECTION_INTEGRATION = '1'
$env:M5_08_TEST_NAME_PATTERN = 'MariaDB'
npm.cmd run test:m5-08 --workspace=@ca-meta/api
npm.cmd --workspace=@ca-meta/api exec -- tsc -p tsconfig.test.json
node --test apps/api/dist-test/test/migration-unit.spec.js
```

On that SHA the harness compiled API source and tests, printed `Migrations are applied`, and both selected MariaDB integration cases passed. Node reported 3/3 passing test records (the two integration cases and the test-file record), 0 failures and 0 skips. The migration-unit test passed 9/9. `git diff --check` passed after this evidence update.

The no-database focused harness passed 8 unit cases and skipped the 2 DB cases on a pre-commit worktree based on `4e499d7f1bfef195cc1599129e69c11aff061cab`; treat that as supplemental evidence only, not a final-SHA result. On code SHA `4fb0253b157186cf6fcbdc18472910db128c559c`, the first DB attempt stopped at the v22 migration privilege preflight. After the missing table-scoped test grant was prepared, the runner resumed through v25 and exposed two integration fixture failures; those cases were corrected in later commits and both were rerun successfully with the literal `MariaDB` filter on the final code SHA. The final unfiltered DB suite was not repeated, so this record does not claim a full aggregate pass on the final SHA. Destination runtime remains disabled and real destination DDL/catalog, mappings, credentials, provider/deployed consumer behavior and PHP equivalence remain **Not confirmed**.

Cleanup removes rows keyed by the run's random synthetic tenant and exact synthetic company/database IDs, removes the fault trigger and closes connections. The migration ledger/checkpoint table and empty fixture table remain in the dedicated schemas so the command is repeatable. Never point these commands at shared, customer or production schemas.

## Implemented boundary and gaps

- `OutboxService` accepts an injected `DurableLegacyProjectionJobScheduler`, which the focused harness uses to verify that a projection job commits atomically with its event and delivery job. The default `JobsModule` does not inject it while the projection runtime remains unregistered, avoiding unhandled jobs in the shared tenant backlog. Replay/rebuild scheduling is deferred until a reviewed runtime exists.
- If a separately reviewed runtime registers a handler, it must reload the tenant-owned outbox event and ask the central source adapter for current state. A retry of an old event cannot replay its old event payload as destination data.
- The source adapter projects only allowlisted grants whose tenant, authorization, asset, provider and environment match and whose grant is `GRANTED`; authorization and asset authorization must remain active/verified. Relations whose parent has no mapping for the same target tuple fail with a safe code rather than becoming a null parent.
- Checkpoints are tenant-scoped and keyed by a hash of the complete destination tuple and central resource reference. Central checkpoint commit and destination transaction are intentionally separate; an ambiguous destination acknowledgement is safe to retry by version/hash upsert. The injectable scheduler gives every `connection.changed` snapshot one tenant-wide scope because an asset can belong to multiple authorizations; automation configuration remains scoped to its stable asset reference. Event idempotency remains separate. A destination with a newer, divergent version raises a retryable conflict rather than silently skipping a write and marking the checkpoint synced.
- A rebuild consumes a trusted current-state scan and scopes reconciliation to the exact mapped `(legacyDatabaseId, legacyCompanyId, environment)` destination. It replays current rows, recomputes hashes from the projected columns actually read, repairs owned field/hash drift when the trusted current version is not older, reports expected/actual counts and hashes, and tombstones only stale extras tied to a checkpoint for that tenant and destination. Unknown extras are never changed and make parity ambiguous/failed; reports do not claim parity in that case.
- No live adapter is installed. This implementation does not prove a distributed transaction, deployed DDL compatibility, actual per-company mappings, credentials, real consumer parity, automatic tenant rebuild scheduling, or production retry/latency behavior.
