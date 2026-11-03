# M2.05 durable work harness

The harness uses a fresh UUID-named Compose project, volume, loopback port, temporary init SQL and synthetic credentials on each run. It pins MariaDB 11.8.8 by digest and uses Node 24.22.2/npm 11.19.1. Cleanup addresses only the project created by this script. It does not inspect, stop or remove another Compose project.

From the repository root on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools/m2-05/run-mariadb-tests.ps1
```

The script sets up separate least-privilege synthetic migrator and runtime accounts, compiles the API test tree, and runs `durable-work.integration.spec.js`, `m3-05-onboarding.integration.spec.js` and `m3-06-meta-assets.integration.spec.js` with `M2_DURABLE_WORK_TEST=1`, followed by `m3-02-db.integration.spec.js` with `M3_02_DB_TEST=1`. The onboarding fixture checks migration v10 and verifies tenant/session ownership, tenant-scoped idempotency, one-use state consumption and digest-only persistence using synthetic rows. The session fixture asserts that a Suite4 embed mode survives the actual MySQL session insert after the versioned migration chain is applied. The full API/root suite is a separate candidate gate and is not repeated by this harness. No production/staging database, Meta API, provider account, real tenant data, or provider credential is used.

The M3.06 fixture covers concurrent upsert/shared assets, confirmed scopes and grants, typed Instagram-to-Page relation persistence, omitted-grants preservation versus explicit revocation, cross-tenant FK rejection and quarantine, exact external IDs above 2^53, and rollback after outbox staging. Its JUnit and LCOV reports are emitted as `m3-06-meta-assets.*`. The M3.02 portal-session fixture emits `m3-02-portal-session.*`; both report sets are uploaded by the M2.08 MariaDB workflow.

The M2.05 durable-work MariaDB scenario checks:

- Migration chain v1/v2/v3 and the additive v3 schema, including job claim, tenant/resource, tenant+lane candidate, ambiguous lease and replay audit indexes, plus one persistent dispatch cursor per lane.
- Same idempotency key/body returns the existing job; the same key with a different payload hash is rejected.
- Inbox persists before returning, routes through the server-owned app configuration row, enqueues in the same transaction, deduplicates semantic redelivery despite a new receive timestamp/correlation/protected handle, and rejects changed semantic metadata.
- Outbox row plus delivery job and a synthetic local write roll back together. A repeated event is deduplicated. An uncertain external outcome or expired ambiguous lease marks both job and outbox projection `UNKNOWN` atomically, with no automatic retry.
- Two claimers serve another tenant while one tenant has a lease active; a blocked asset scope does not block a second asset scope in the same tenant.
- A per-lane cursor is locked before candidate discovery and advances atomically with a successful claim. Sequential completion lets tenant B claim while tenant A still has backlog; concurrent workers serialize and re-read the cursor before selecting their turns.
- Concurrent claims for one tenant/resource never receive the same active scope. A real child process claims an inbox job and is killed without ACK; a replacement requeues it after expiry/backoff. A second child persists a quarantined `provider.unclassified` inbox event, is killed before ACK, and the replacement repeats `InboxService.persist`; the app-config/provider-event key returns a duplicate and leaves exactly one row. This synthetic local effect uses the existing schema and no provider call. Expired safe leases are delayed, stale fencing tokens cannot ACK, and attempt/budget exhaustion reaches a redacted DLQ.
- A handler remains leased beyond the original TTL through heartbeat while SIGTERM stops claims and drains it. The worker aborts at the per-type deadline and stops heartbeats; cooperative cancellation gets a bounded grace. A handler still pending after that grace is finalized `UNKNOWN` without retry, late results cannot finalize it, and that worker exits its claim loop to avoid accumulating abandoned handlers.
- DLQ stores safe reason/action fields only. Inbox projections follow the effective job result in the same transaction, including `UNKNOWN` and retry exhaustion into `DEAD_LETTER`. An authorized `INBOX_PROCESS` replay resets only its exact tenant-scoped dead-letter projection to `PENDING` in the enqueue transaction; successful finalization reaches `PROCESSED`, and duplicate replay leaves the projection unchanged. The default replay port denies. An explicit exact tenant/job/resource/operator grant can authorize a dry-run preview without enqueueing, or requeue safe work idempotently; database scope mismatch is denied, expired grants and ambiguous effects cannot replay, audit writes are append-only, and the harness never executes a provider handler.
- An unforced MariaDB `EXPLAIN` selects `ix_ca_meta_job_ambiguous_expired` for the expired ambiguous lease sweep after a synthetic mixed-state fixture and `ANALYZE TABLE`.
- The claim harness seeds 5,000 ready historical projection jobs and measures two concurrent urgent webhook claims with a 2-second bound. Separate unforced plans check the global urgent lane pass and both tenant/lane ready and expired lease lookups; lane-priority queries avoid scanning lower-priority history to find urgent work. The dispatch cursor is fixed-size state per lane, so tenant fairness does not aggregate terminal job history.

`MAX_ACTIVE_JOBS_PER_TENANT = 4`, `MAX_WAITING_JOBS_PER_TENANT = 1000`, cancellation grace, handler deadlines, retry delays and elapsed/attempt limits are synthetic implementation defaults aligned to M1.09 planning; they are not Meta quotas, measured production limits, or a provider contract. A handler should honor its `AbortSignal`. If it does not settle within the configured grace, the attempt becomes terminal `UNKNOWN`, the worker stops claiming and reports a process failure, and any late completion is ignored. Work without a registered handler remains unclaimed. The worker command is available from the API image (`npm run start:worker --workspace=@ca-meta/api`); this package intentionally registers no onboarding/provider handler.

The API Nest module closes the lazy durable-work pool through `OnModuleDestroy`; a focused application-context test covers that hook without rerunning the M2.02 HTTP suite.

Replay is an internal service with no HTTP controller. `preview()` is always dry-run. `requeue()` requires the injected `ReplayAuthorizationPort` to grant an exact tenant, dead-letter, persisted resource scope, operator, action and expiry, and refuses ambiguous effects. The default port denies all requests. Requeue creates a durable job and an audit row transactionally; it does not invoke a handler or provider.

## Local evidence

Candidate validated: `80fc9df8cf925731b90064af38109a2c305d4ff5` on Windows, Node v24.22.2/npm 11.19.1. The M2.05 MariaDB harness uses synthetic fixtures only; it does not contact Meta or production/staging.

| Check | Command | Result |
|---|---|---|
| Runtime versions | Harness preflight | Node v24.22.2 / npm 11.19.1; pass |
| Specialized MariaDB/API integration | `powershell -ExecutionPolicy Bypass -File tools/m2-05/run-mariadb-tests.ps1` | MariaDB 11.8.8; UUID Compose project `m205-9a04d03c2c194bcc86b067cbdec4f16a`; TypeScript test compile passed; 1 integration test passed, 0 failed; exit code 0 (5.6 s). The harness removed only this project's container, network, volume and temporary SQL. |
| Workspace build | `npm run build` | Pass; API Nest build, Angular production build, and 12 deterministic contract artifacts verified. |
| Workspace tests | `npm test -- --watch=false` | Pass, exit code 0. API: 28 passed, 0 failed, 7 skipped for dedicated MariaDB/POSIX-only cases; web: 10 passed; contract sensitivity/determinism/contract/runtime tests passed. |
| Workspace typecheck | `npm run typecheck` | Pass for API build/test TypeScript, Angular application, and contracts. |
| Workspace lint | `npm run lint` | Pass; web boundary check inspected 18 source files and Redocly validated both OpenAPI documents. |
