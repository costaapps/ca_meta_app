# M5.04 focused validation

Prerequisites: use Node 24 and npm 11 and install the repository workspace dependencies from the existing root `package-lock.json` (`npm ci`). No package or lockfile dependency was added. The worktree requires its own `@ca-meta/*` aliases to point to local packages; the shared root `node_modules` junction is not changed by these scripts.

Run from the repository root:

```powershell
npm run test:m5-04 --workspace=@ca-meta/api
npm run test:m5-04 --workspace=@ca-meta/web
```

The API harness compiles only `test/m5-04-whatsapp-templates.spec.ts` plus API sources to `apps/api/.test-runs/m5-04-*`, then runs Node's built-in test runner. The Angular harness includes only the template component spec and route-map spec, writes JUnit beneath `apps/web/.test-runs/m5-04-*`, and verifies a non-empty, failure-free result. Each harness validates its output path and removes only its own private output directory. Both suites use synthetic fixtures; they do not call Meta, need no database schema, and do not inspect or modify shared service state.
