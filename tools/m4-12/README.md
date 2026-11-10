# M4.12 focused harness

The harness covers versioned asset-observation reduction, stale/unknown distinction, late-event rejection, bounded unknown status tokens, tenant-scoped persistence, and manual refresh coalescing/budget behavior. Fixtures are synthetic. It does not call Meta, load credentials, connect to a database, or use production data.

## Setup

Use the pinned Node/npm engine from the root `package.json`. Install the lockfile once from the repository root:

```powershell
npm ci --ignore-scripts
```

## Run

From the repository root:

```powershell
npm run test:m4-12 --workspace=@ca-meta/api
```

The harness uses `apps/api/tsconfig.m4-12-test.json`, emits into a private `apps/api/.test-runs/m4-12-*` directory, runs `m4-12-asset-observation.spec.js`, then removes only that verified child. No Docker or MySQL is needed. The implementer did not run this command; the coordinator owns the focused gate.

## Limits

These fixtures prove local reducer and boundary behavior only. They do not prove Meta field availability, grants, app review, real provider budgets, sandbox changes, webhook event mappings, or a measured update SLO. The worker intentionally has no configured Meta asset adapter.
