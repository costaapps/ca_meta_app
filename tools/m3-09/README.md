# M3.09 credential lifecycle harness

This package adds a focused synthetic unit harness and one opt-in MariaDB integration fixture. It uses no Meta API, provider account, real credential, tenant data, or customer data. The unit fixture uses an in-memory-only synthetic marker. The integration fixture generates a disposable key, synthetic secret markers, tenant, authorization, and credentials at runtime; it verifies inspection scheduling, exact flow/auth/family policy selection, authorization+impact reauthentication coalescing, a successful conditional vault renewal, and rejection of a late renewal after authorization state/version changes.

## Toolchain and dependencies

- Node.js `24.22.2`
- npm `11.19.1`
- MariaDB `11.8.8`, pinned by digest in `tools/m2-05/compose.yaml`
- Root `package-lock.json` supplies the workspace dependencies. From the repository root, install with `npm ci --ignore-scripts`.
- Docker Compose is required only for the MariaDB integration fixture.

## Commands

From the repository root, run the focused synthetic unit suite:

```powershell
npm run test:m3-09 --workspace=@ca-meta/api
```

Run the opt-in MariaDB schema and lifecycle integration through the existing isolated M2.05 harness:

```powershell
powershell -ExecutionPolicy Bypass -File tools/m2-05/run-mariadb-tests.ps1
```

The script sets `M3_09_TEST=1` only for its fresh disposable MariaDB project, compiles the API test tree, and runs `m3-09-credential-lifecycle.integration.spec.js` after the established M2.05/M3.02/M3.06/M3.07 integration cases. Its report is `artifacts/test-results/m3-09-credential-lifecycle.junit.xml` with an LCOV companion.

## Expected result and cleanup

The focused command compiles only the M3.09 test project into an OS temporary directory, runs its Node test file, and removes that directory in `finally`. The MariaDB command should complete with the lifecycle integration passing and emit JUnit/LCOV reports. By default it removes only its UUID-named Compose project, network, volume, and temporary init SQL in `finally`; it restores the caller's managed environment variables afterward. If `M2_05_KEEP_ENVIRONMENT=1` is set, the script prints the exact Compose project and cleanup command for that run.

The local Docker daemon was unavailable during this implementation task, so the MariaDB fixture was not run locally. Hosted M2.08 MariaDB CI runs the same opt-in fixture. This is a test-environment limitation, not evidence that the fixture passed.
