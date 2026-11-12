# M5.07 focused harness

This harness compiles the API into its normal, ignored `apps/api/dist` output, runs the M5.07 synthetic Node tests, and deletes that output only if this invocation created it. It refuses to overwrite an existing `apps/api/dist`. The regular harness does not start Docker/MariaDB, call Meta, execute PHP, or read production credentials. The consumer fixture contains sanitized source paths and typed operation names only.

## Setup and dependencies

- Runtime: Node 24.22.2 and npm 11.19.1 as pinned by the root `package.json` engines/packageManager.
- Dependencies: root npm workspace dependencies pinned by the repository `package-lock.json`; the harness adds no package dependencies and no separate lockfile.
- From a clean checkout, use the repository's standard `npm ci --ignore-scripts` setup after verifying the lockfile. Do not run `npm ci` inside a shared `node_modules` junction.
- The API build uses the installed Nest CLI and strict API TypeScript project.

## Command

From repository root:

```powershell
npm run test:m5-07 --workspace=@ca-meta/api
```

The runner executes `apps/api/node_modules/@nestjs/cli/bin/nest.js build`, then `node --test tools/m5-07/internal-operations.test.mjs`. It prints both command outputs and returns nonzero on a build/test failure. A successful run removes only `apps/api/dist`, which it verified was absent before it started. `node_modules`, MariaDB, fixtures, source files, and unrelated artifacts are untouched.

The contract crosswalk shares the M1.07 source-of-truth generator. After changing its mapping, regenerate and check it from repository root with:

```powershell
python tools/m1-07/scripts/generate-compatibility.py
python tools/m1-07/scripts/generate-compatibility.py --check
node --test tools/m1-07/src/contract.test.mjs
```

When a disposable local MariaDB is available, `npm run test:m5-07:db --workspace=@ca-meta/api` runs the same synthetic tests and then applies the full migration sequence to a random temporary schema. It requires `M5_07_DB_ROOT_PASSWORD` in the process environment (optional `M5_07_DB_ROOT_USER`, `M5_07_DB_HOST`, `M5_07_DB_PORT`; host must be loopback), creates a random restricted migration account with privileges only on its new schema, checks schema version 21 and its columns/indexes, then drops only the randomly named schema and user. It never targets a non-loopback service or prints the supplied password.

The tests use in-memory fake repositories, current-grant responses, an idempotency store, and a provider adapter spy. They verify proof rotation/revocation, four flow/auth resolver contexts with distinct handles, service scopes, asset mismatch, typed-operation idempotency/replay, changed-body conflict, replay after execution gates are removed, concurrent duplicate suppression, `UNKNOWN` no-retry, status/audit redaction, migration metadata shape, and exact middleware path bypass. The per-consumer matrix records synthetic equivalence evidence or a concrete block reason; no PHP handler is declared migrated. These tests do not establish real grants, provider behavior, PHP runtime parity, Meta permissions, App Review, Sandbox, Suite4 behavior, or production rollout.

The root workspace lockfile remains the dependency source of record. There is no test-specific data service or generated file to clean; the API build output is the only temporary artifact.
