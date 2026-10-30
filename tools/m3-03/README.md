# M3.03 focused harness

This harness compiles the API source/test tree into a UUID-scoped temporary directory and runs only the M3.03 magic-link unit tests. Fixtures use synthetic identities and two synthetic tenants; delivery uses the in-memory fake inbox and never opens a network connection. No database, SMTP server, provider account, real email address, or production credential is used.

## Setup and run

From the repository root in Windows PowerShell:

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File tools/m3-03/run-focused-tests.ps1
powershell -ExecutionPolicy Bypass -File tools/m3-03/run-migration-unit.ps1
```

The repository root `package-lock.json` supplies the API workspace dependencies. The harness requires Node `24.22.2` and npm `11.19.1`; set `M3_NODE_RUNTIME_DIR` to that runtime directory when it is not under `%LOCALAPPDATA%\Codex\runtimes\node-v24.22.2`.

The script creates a uniquely named directory under the operating-system temp directory, compiles only into that directory, and removes only that exact directory after the run. It preserves repository build output and any pre-existing temp resources.

`run-migration-unit.ps1` uses the same isolated compilation and cleanup pattern to run only `apps/api/test/migration-unit.spec.ts`, including the complete ordered migration-chain assertion.

## Coverage and limits

The focused tests cover known/unknown response equality, identity and tenant rate dimensions, delivery deduplication, hash-only token lookup, scanner GET/HEAD behavior, explicit POST, replay/concurrent consume behavior, expiry, current-membership revocation, and selection options for two active memberships.

These unit tests exercise an in-memory store. The SQL migration, MariaDB row locks, and cross-process delivery behavior require the isolated MariaDB integration gate after the M3.03 migration is registered on the integrated milestone branch. Runtime provider, domain, deliverability, timing behavior, and distributed production quotas remain **Not confirmed**.
