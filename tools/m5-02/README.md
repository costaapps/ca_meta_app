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
npm --prefix tools/m1-07 run check:generated
```

The API runner compiles only `m3-12-asset-catalog.spec.ts` with the API source into a private `apps/api/.test-runs/m5-02-*` directory, runs that Node test file, and removes only that verified child directory. The web runner selects the catalog/detail/route specs and writes its JUnit report to a private `apps/web/.test-runs/m5-02-*` directory, then removes that verified child directory.

## Refresh handoff and evidence limits

The connection detail screen can submit a refresh only when both `PortalTenantIdentityService.current.confirmed` and the server's `capabilities.canRefresh` are true. It uses the internal asset reference for the POST and only the opaque `jobId` in the returned acceptance for status reads. It blocks another request while that job is active, polls no more than five times at one-second intervals, and offers a manual single status check after polling pauses. Route/context/session changes and component destruction invalidate displayed job state and stop later polling. Only mapped job status and a validated request reference are displayed. HTTP 429/503 responses receive safe copy without exposing raw server errors.

All fixtures represent synthetic normalized contract states. They do not prove Meta grants, connected provider assets, webhook delivery, tenant display-name availability, or production refresh behavior. The current session contract does not return a safe company label and the API does not register a Meta refresh adapter, so the runtime identity/capability gates keep the action unavailable and do not issue a POST. The API separately authorizes `REFRESH_ASSET` for owner, admin and operator roles; viewer requests remain denied. No provider, sandbox or production behavior is claimed.
