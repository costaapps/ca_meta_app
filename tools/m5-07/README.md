# M5.07 focused harness

This harness compiles the API into its normal, ignored `apps/api/dist` output, runs only the M5.07 synthetic Node tests, and deletes that output only if this invocation created it. It refuses to overwrite an existing `apps/api/dist`. It does not start Docker/MariaDB, call Meta, execute PHP, or read production credentials. The consumer fixture contains source paths and typed operation names only.

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

The tests use in-memory fake repositories, current-grant responses, an idempotency store, and a provider adapter spy. They verify hash proof rotation/revocation, tenant/principal scope, missing service scopes, asset mismatch, typed payload rejection, operation gates, concurrent duplicate suppression, key/body conflict, `UNKNOWN` no-retry, status/audit redaction, migration metadata shape, and exact middleware path bypass. They do not establish real grants, provider behavior, PHP runtime parity, Meta permissions, App Review, Sandbox, Suite4 behavior, or production rollout.

The root workspace lockfile remains the dependency source of record. There is no test-specific data service or generated file to clean; the API build output is the only temporary artifact.
