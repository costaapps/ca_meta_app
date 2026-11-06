# M4.03 onboarding saga focused harness

This harness compiles only the API sources needed by the onboarding state/code/saga tests into a private temporary folder, then runs the touched M3.05 onboarding regression tests, M4.03 saga tests, gated MariaDB integration fixtures and API migration-unit spec sequentially. It removes only its uniquely named temporary output directory in `finally`.

## Toolchain and dependencies

- Node.js `24.22.1`, npm `11.19.1`.
- Install the pinned npm workspace dependencies from the repository root using the checked-in `package-lock.json`:

```powershell
$node = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$npmCli = 'C:\Users\user\AppData\Local\npm-cache\_npx\ae109337638209d1\node_modules\npm\bin\npm-cli.js'
& $node $npmCli ci --ignore-scripts
```

For another environment, select equivalent Node/npm versions from the environment's approved runtime. Do not copy database or Meta credentials into this harness.

## Run the focused gate

From repository root:

```powershell
$node = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node tools/m4-03/run-focused-test.mjs
```

The workspace shortcut is `npm run test:m4-03 --workspace=@ca-meta/api` when npm resolves to the same Node runtime. The unit tests need no external service. The database integration test is skipped by default; execute that test with `M2_DURABLE_WORK_TEST=1` only after preparing the repository's disposable MariaDB profile with the dedicated migration/runtime identities. Its generated fixture tenant, principal, membership, portal session, onboarding/code/job rows are deleted in `finally`; it does not contact Meta.

This focused harness does not run the Angular suite, broad API suite or CI. The package worktree author did not execute it; the coordinator owns the single gate on the integrated candidate SHA. Real Meta credentials, grants, callbacks, eligibility and provider effects remain **Not confirmed**.
