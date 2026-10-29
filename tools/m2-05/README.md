# M2.05 durable work harness

The harness uses a fresh UUID-named Compose project, volume, loopback port, temporary init SQL and synthetic credentials on each run. It pins MariaDB 11.8.8 by digest and uses Node 24.22.2/npm 11.19.1. Cleanup addresses only the project created by this script. It does not inspect, stop or remove another Compose project.

From the repository root on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools/m2-05/run-mariadb-tests.ps1
```

The script sets up separate least-privilege synthetic migrator and runtime accounts, compiles the API test tree, and runs only `durable-work.integration.spec.js` with `M2_DURABLE_WORK_TEST=1`. The integration test calls the versioned migration runner before exercising the schema. The full API/root suite is a separate candidate gate and is not repeated by this harness. No production/staging database, Meta API, provider account, real tenant data, or provider credential is used.

The MariaDB scenario checks:

- Migration chain v1/v2/v3 and the additive v3 schema, including the job claim, tenant/resource, ambiguous lease and replay audit indexes.
- Same idempotency key/body returns the existing job; the same key with a different payload hash is rejected.
- Inbox persists before returning, routes through the server-owned app configuration row, enqueues in the same transaction, deduplicates semantic redelivery despite a new receive timestamp/correlation/protected handle, and rejects changed semantic metadata.
- Outbox row plus delivery job and a synthetic local write roll back together. A repeated event is deduplicated. An uncertain external outcome or expired ambiguous lease marks both job and outbox projection `UNKNOWN` atomically, with no automatic retry.
- Two claimers serve another tenant while one tenant has a lease active; a blocked asset scope does not block a second asset scope in the same tenant.
- Concurrent claims for one tenant/resource never receive the same active scope. A real child process claims an inbox job and is killed without ACK; a replacement requeues it after expiry/backoff. Expired safe leases are delayed, stale fencing tokens cannot ACK, and attempt/budget exhaustion reaches a redacted DLQ.
- A handler remains leased beyond the original TTL through heartbeat while SIGTERM stops claims and drains it. The worker applies per-type deadlines by aborting cooperatively, continues lease renewal until the handler exits, and only then finalizes; ambiguous timeouts become `UNKNOWN`.
- DLQ stores safe reason/action fields only. Inbox projections follow the effective job result in the same transaction, including `UNKNOWN` and retry exhaustion into `DEAD_LETTER`. The default replay port denies. An explicit exact tenant/job/resource/operator grant can authorize a dry-run preview without enqueueing, or requeue safe work idempotently; database scope mismatch is denied, expired grants and ambiguous effects cannot replay, audit writes are append-only, and the harness never executes the requeued handler.
- An unforced MariaDB `EXPLAIN` selects `ix_ca_meta_job_ambiguous_expired` for the expired ambiguous lease sweep after a synthetic mixed-state fixture and `ANALYZE TABLE`.

`MAX_ACTIVE_JOBS_PER_TENANT = 4`, `MAX_WAITING_JOBS_PER_TENANT = 1000`, handler deadlines, retry delays and elapsed/attempt limits are synthetic implementation defaults aligned to M1.09 planning; they are not Meta quotas, measured production limits, or a provider contract. A handler must honor its `AbortSignal`; the worker keeps the lease while cancellation is pending and does not ACK while the handler promise is still active. Work without a registered handler remains unclaimed. The worker command is available from the API image (`npm run start:worker --workspace=@ca-meta/api`); this package intentionally registers no onboarding/provider handler.

The API Nest module closes the lazy durable-work pool through `OnModuleDestroy`; a focused application-context test covers that hook without rerunning the M2.02 HTTP suite.

Replay is an internal service with no HTTP controller. `preview()` is always dry-run. `requeue()` requires the injected `ReplayAuthorizationPort` to grant an exact tenant, dead-letter, persisted resource scope, operator, action and expiry, and refuses ambiguous effects. The default port denies all requests. Requeue creates a durable job and an audit row transactionally; it does not invoke a handler or provider.

## Local evidence

Record the exact commit/snapshot and exit code after each focused run. The coordinator performs the final candidate review and milestone integration separately.

| Check | Command | Environment/result |
|---|---|---|
| Runtime versions | `tools/m2-05/run-mariadb-tests.ps1` runtime preflight | Node v24.22.2 / npm 11.19.1; pass |
| Specialized MariaDB/API integration | `powershell -ExecutionPolicy Bypass -File tools/m2-05/run-mariadb-tests.ps1` | MariaDB 11.8.8, UUID Compose project `m205-9fcee8ceded248ac9b768e81027cff12`; API test TypeScript compile passed; 1 test passed, 0 failed; exit code 0 |
| API unit/build suite | `npm test --workspace=@ca-meta/api` | An initial run before the AJV import/type fix stopped in Nest build (exit 1); the root coordinator will run the complete suite on the integrated candidate |
| Formatting/whitespace | `git diff --cached --check` | Pass; exit code 0 |

An earlier harness attempt found and fixed a trailing comma in the v3 replay-audit DDL; the next attempt found and fixed the job INSERT parameter order for `idempotencyKey` and `resourceScopeRef`. The final specialized run above exercised the corrected migration and complete DB scenario. Its code snapshot is the current branch diff on base `e72941fbe82979ca95d911cd51f0def7fd1b4c9c`; no source changes were made after that passing run.
