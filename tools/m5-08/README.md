# M5.08 synthetic legacy projection

This slice projects a fresh, tenant-scoped central metadata snapshot to preconstructed destination connections. A destination is selected only by the server-owned `(legacyDatabaseId, legacyCompanyId, environment)` allowlist. Event bodies carry the existing outbox envelope and opaque references; they never choose a database, company, DSN, token or credential. The adapter writes only asset metadata, a central asset reference, projection version/hash and tombstone marker. It does not select or copy automation message text, provider payloads or credentials.

The destination table names and column layout in the integration fixture are **provisional synthetic DDL**, not evidence of the enterprise schemas or deployed consumers. Real mappings, destination catalog provisioning, source data parity and PHP/deployed equivalence remain **Not confirmed**. `configuredLegacyProjectionRuntime()` intentionally returns no adapter. The worker and producers therefore remain fail-closed until a separately reviewed runtime composition supplies the catalog and source; no production destination is configured by this package.

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

The MariaDB test creates the fixture table `MetaConnectedPages` only in those isolated destination schemas, injects a destination-local trigger error, verifies another destination and a second company in the first database still commit, retries after removing the trigger, exercises version/tombstone ordering, deletes one row and repairs it through the full trusted snapshot rebuild, checks the central event plus `OUTBOX_DELIVER`/`PROJECTION_RECONCILE` jobs are committed once, and verifies the destination fixture has no token/secret/password/DSN/message/payload columns. The injected event and resource IDs are synthetic.

Cleanup removes rows keyed by the run's random synthetic tenant and exact synthetic company/database IDs, removes the fault trigger and closes connections. The migration ledger/checkpoint table and empty fixture table remain in the dedicated schemas so the command is repeatable. Never point these commands at shared, customer or production schemas.

## Implemented boundary and gaps

- `OutboxService` accepts an optional scheduler. When a composition supplies it, the projection job is added using the same caller transaction as the event and delivery job; a repeated event does not enqueue another projection job.
- The handler reloads the tenant-owned outbox event, then asks the central source adapter for current state. A retry of an old event cannot replay its old event payload as destination data.
- Checkpoints are tenant-scoped and keyed by a hash of the complete destination tuple and central resource reference. Central checkpoint commit and destination transaction are intentionally separate; an ambiguous destination acknowledgement is safe to retry by version/hash upsert.
- A rebuild consumes a complete trusted current-state scan and replays all supplied rows; tombstones make revocation/removal explicit. It does not scan arbitrary legacy rows to infer ownership.
- No live adapter is installed. This implementation does not prove a distributed transaction, deployed DDL compatibility, actual per-company mappings, credentials, real consumer parity, automatic tenant rebuild scheduling, or production retry/latency behavior.
