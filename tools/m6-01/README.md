# M6.01 local journey evidence

This package runs one focused Angular test invocation covering the onboarding service and portal screens used by the four flow families, connection management, templates and notifications. The exact source specs and requirement links are in [`evidence-matrix.json`](evidence-matrix.json).

## Requirements and setup

- Windows or Linux with Node `24.15` through `<25` and npm `11.19.1` through `<12`.
- Repository dependencies installed from the root lockfile: `npm ci`.
- No Meta credentials, Suite4 identity, real tenant data, browser profile or provider account is used.

## Run

From the repository root (with the required Node version first on `PATH`):

```powershell
node tools/m6-01/run-focused-web-tests.mjs
```

The harness verifies every mapped test title still exists, computes a SHA-256 fingerprint over the selected spec sources and matrix, runs the 17 declared web spec files once through Angular's configured JUnit reporter, checks the report has tests and no failures, writes the sanitized summary to `tools/m6-01/last-run.json`, then removes only its uniquely named JUnit output directory under `apps/web/.test-runs/`.

## Evidence limits

This is local fixture-based component/service evidence. It does not execute a real browser E2E session, prove popup behavior under browser privacy settings, certify keyboard/screen-reader/contrast behavior, exercise the production release digest, or prove Meta/Suite4 permissions or consumers. Those scenarios stay marked **Not confirmed** in the matrix until an authorized staging walkthrough is performed. Do not interpret these tests as production approval.
