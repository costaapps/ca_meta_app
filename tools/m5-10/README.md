# M5.10 operational diagnostics

This package adds a tenant-scoped status read, an audited support export boundary, typed operational action requests and the portal `/status` page. The implementation and acceptance conditions are described in [`operations-diagnostics.md`](../../docs/meta-v2/specs/operations-diagnostics.md).

## Setup

Requirements: Node `24.15` through `<25`, npm `11.19.1` through `<12`, and the locked npm workspace dependencies. From a clean checkout, run `npm ci` at the repository root. This package adds no runtime or development dependencies, so `package-lock.json` remains the install source of truth.

## Focused checks

Run only M5.10 API behavior:

```powershell
npm run test:m5-10 --workspace=@ca-meta/api
```

Run API build and test TypeScript project checks:

```powershell
npm run typecheck:m5-10 --workspace=@ca-meta/api
```

Run the focused `/status` count regression test:

```powershell
npm run test:m5-10 --workspace=@ca-meta/web
```

Run the focused connection detail route loading and error-state test:

```powershell
npm run test --workspace=@ca-meta/web -- --include=src/app/features/portal/connection-record-detail.component.spec.ts
```

The runners use Node 24 and compile against the current checkout's generated contract declarations. This explicit API path mapping avoids relying on an unrelated external workspace junction if one exists under `node_modules/@ca-meta/contracts`. The API harness runs only `m5-10-operations-diagnostics.spec.ts`; the Angular harness includes only `operations-diagnostics.component.spec.ts`. Neither test uses MariaDB. Each harness creates a uniquely named directory under an ignored workspace-local folder and removes only that exact directory in a `finally` block. No credentials or test env file is needed.

## Coverage

- Read permission, branded current-tenant scope and SQL-parameter tenant isolation; forged tenant scope rejected.
- Empty grant state and missing projection runtime remain `UNKNOWN`; projection lag stays null.
- Fixed reason-code export requires a short-lived `SUPPORT` role grant; audit is recorded before read; token/message/payload sentinels are removed.
- Tenant refresh is audited but fail-closed while the company identity label is unconfirmed.
- Replay requires current tenant membership and a support grant; the M2 deterministic dead-letter key produces a duplicate on a repeated eligible request; ambiguous jobs are refused without enqueue.
- The `/status` component shows queued/running/retry-pending jobs separately and includes failed, dead-letter and `UNKNOWN` jobs in the review count.
- The connection detail component loads the detail for the emitted route ID, clears loading after success, and clears loading with a safe error after rejection. The earlier browser walkthrough's stuck-loading symptom remains **Not confirmed** because its network trace and response body were unavailable.

Tests use synthetic tenant/resource IDs and in-memory ports only. They do not call Meta, send messages, change subscriptions, access production databases or run a real replay.
