# M6.03 synthetic load and recovery harness

This harness exercises the real API `DurableJobStore` and `InboxService` against a disposable MariaDB database. The worker loop and handlers are synthetic. It does not start the HTTP ingress, call Meta, access an enterprise database, or send messages.

## Setup and run

From the repository root in Windows PowerShell, use Node `v24.22.2` and npm `11.19.1`. If project dependencies are not installed in this worktree, install them once with `npm ci --ignore-scripts`; the runner does not install dependencies.

```powershell
$nodeRuntime = Join-Path $env:LOCALAPPDATA 'ca-meta-runtimes\node-v24.22.2-win-x64'
$env:Path = "$nodeRuntime;$env:Path"
$env:M6_NODE_RUNTIME_DIR = $nodeRuntime
docker info
powershell -ExecutionPolicy Bypass -File tools/m6-03/run-mariadb.ps1
```

The default run compiles the API test tree, prepares the current disposable schema through v26, then runs the clock-step regression and the 528-job profile. Run only the regression while iterating on that behavior with:

```powershell
powershell -ExecutionPolicy Bypass -File tools/m6-03/run-mariadb.ps1 -TestNamePattern 'M6.03 clamps attempt duration'
```

`scenarios.json` is the versioned input profile. The test prints JSON results to stdout and Node TAP counts at exit. It contains no provider/customer credentials or customer payloads; the runner creates short-lived synthetic database passwords in process. There are no provider calls or quota use in the fixture.

## Isolation and cleanup

Each run generates a UUID-scoped Compose project, MariaDB volume, loopback port, temporary init SQL, and synthetic root/migration/API credentials. MariaDB is pinned to `11.8.8` by digest. Migration and runtime accounts have separate grants; the temporary root connection grants `DELETE` only on the disposable v22 coexistence-lock table needed by the migration preflight. All test rows use random synthetic tenant/app identifiers.

The `finally` block removes only the Compose project, volume and network created by that run, deletes its checked temporary directory, and restores process environment variables. It does not enumerate or remove other Compose projects. If the script is interrupted before its `finally` block, inspect the printed `m603-<UUID>` project name and clean only that project.

## Scope

The profile mixes urgent inbox work and onboarding with a noisy tenant's larger historical projection backlog, and records queue and durable-store timings, throughput, per-tenant/per-lane completions and observed active claims. Recovery cases inject a safe inbox retry, an abandoned persisted inbox lease, a synthetic projection dependency failure, and an ambiguous outbox result that must remain `UNKNOWN`.

Metrics describe this one local configuration and are not production capacity promises. The harness does not measure HTTP ACK/ingress, host CPU or memory, actual Meta quotas/429/5xx/timeouts, queue or database outage, a real worker process kill, enterprise database isolation, a business peak profile, or ratified RPO/RTO. See [the M6.03 evidence report](../../docs/delivery/M6/M6.03.md) for the executed results and open gates.
