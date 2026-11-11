# M5.02 focused validation

This package uses the monorepo `package-lock.json` and requires the pinned Node 24/npm 11 engine. It uses synthetic fixtures only; no MySQL, Docker, provider credentials, Meta calls, or real tenant data are required.

## Setup

From the repository root, install once with the repository's pinned runtime:

```powershell
npm ci --ignore-scripts
```

## Focused checks

```powershell
npm run test:m5-02 --workspace=@ca-meta/api
npm run test:m5-02 --workspace=@ca-meta/web
npm run typecheck --workspace=@ca-meta/api
npm run typecheck --workspace=@ca-meta/web
npm run check:generated --workspace=@ca-meta/contracts
npm run lint --workspace=@ca-meta/contracts
```

The API runner compiles only `m3-12-asset-catalog.spec.ts` with the API source into a private `apps/api/.test-runs/m5-02-*` directory, runs that Node test file, and removes only that verified child directory. The web runner selects the catalog/detail/route specs and writes its JUnit report to a private `apps/web/.test-runs/m5-02-*` directory, then removes that verified child directory.

## Evidence limits

All fixtures represent normalized local contract states. They do not prove Meta grants, connected provider assets, webhook delivery, tenant display-name availability, or production refresh behavior. The current session contract does not return a safe company label, so tenant-scoped write controls are disabled. The refresh endpoint and coalesced job coordinator remain server-owned; this screen does not initiate a refresh or report a job that it did not receive from the server.
