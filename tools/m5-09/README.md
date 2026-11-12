# M5.09 focused harness

This package checks the migration execution policy with an in-memory synthetic ledger. An optional MariaDB mode compiles the API and deploys the complete current migration registry into a random empty loopback schema, then runs the synthetic persistence test. No provider, customer source, PHP endpoint, real tenant or production connection is used.

## Prerequisites

- Node.js 24 and npm from the root `package.json` engines/package manager.
- Root npm workspace dependencies installed from the checked-in `package-lock.json`. This harness adds no dependency and changes no lockfile.
- The normal command needs no database service or extra environment values.
- Optional MariaDB mode needs a disposable local MariaDB reachable at `127.0.0.1`, `localhost` or `::1`. Provide its local administrator password as `M5_09_DB_ROOT_PASSWORD`. Optional overrides are `M5_09_DB_ROOT_USER`, `M5_09_DB_HOST` and `M5_09_DB_PORT` (default `root`, `127.0.0.1`, `13307`). Password values are never printed. No non-loopback hostname is accepted.

## Commands

From the repository root:

```powershell
npm run test:m5-09 --workspace=@ca-meta/api
npm run test:m5-09:db --workspace=@ca-meta/api
```

The first command runs the M5.09 unit suite against the checked-in `synthetic-migration-inventory.json`. The second runs the same suite and its MariaDB integration case. Both compile source and tests into a private `apps/api/.test-runs/m5-09-*` directory and remove only that invocation's directory in `finally`; they do not write the standard API build output or modify fixtures.

In database mode the runner verifies the endpoint is MariaDB and loopback, creates a random empty schema plus separate temporary migration/API users, gives each access only to that schema, deploys the current registry and runs the integration case. It then drops those random users and schema and verifies their absence. If the harness cannot connect or clean up, it reports failure; inspect the local service manually before retrying. It does not remove any pre-existing schema/account.

`npm run typecheck --workspace=@ca-meta/api` and `git diff --check` are separate checks. This harness is intentionally focused; it is not the full API test suite.

## Coverage and limits

The synthetic tests cover redacted batch provenance and before/after aggregate counts, explicit quarantine reason codes, concurrent source drift and reconciliation, read-only fingerprint shadow comparison, cutover rejection without matched evidence and when a previously matched candidate snapshot becomes stale, writer uniqueness/CAS, repeated idempotent execution, interrupted checkpoint resume, and route-only rollback after partial per-function cutover. The repository re-reads the candidate through its configured read-only port before CAS. Rollback keeps a previously legacy credential reference central and leaves revoked authorization state unchanged. MariaDB assertions run only in the disposable schema.

This harness does not prove a real source watermark, target schema parity, Meta grant or credential validity, deployed PHP or Suite4 equivalence, webhook callback topology, absence of production double-send, or a real pilot. There is no M5.09 HTTP/controller/runtime registration. If webhook ingress is introduced later, raw-body signature validation and independent internal envelope/ledger authentication are prerequisites before item routing.

The correction's exact-SHA harness, typecheck, and diff-check evidence is recorded in [`docs/delivery/M5/M5.09.md`](../../docs/delivery/M5/M5.09.md). That report distinguishes code-tested SHA from later documentation-only updates.
