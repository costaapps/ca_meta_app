# M4.09 Instagram adapter harness

This offline harness checks the Instagram-specific onboarding adapter boundary, including the two auth variants, Page-link rules, incomplete discovery, zero accounts, atomic persistence receipts, exact subscription evidence, read-only reconciliation, and fail-closed defaults. All IDs and provider results are synthetic. It makes no HTTP calls and stores no credential values.

## Requirements

- Node.js 24.x
- npm 11.x
- Repository dependencies installed from the root `package-lock.json` with `npm ci --ignore-scripts`

## Run

From the repository root:

```powershell
node tools/m4-09/run-focused-test.mjs
```

The harness compiles only `apps/api/src/meta-instagram/instagram-onboarding.adapter.ts` and its focused test through `apps/api/tsconfig.m4-09-test.json`, then runs the emitted Node test. It writes temporary output beneath `apps/api/.test-runs/m4-09-*` and removes only that unique output directory in `finally`.

Expected result: TypeScript compilation succeeds and all 14 synthetic tests pass. This command is a local contract check; it does not certify current Meta app grants, OAuth exchange behavior, account eligibility, webhook subscriptions, or a real Sandbox flow.

## Cleanup

No persistent service, database, or external resource is created. The harness removes its own unique output directory. If interrupted, inspect `apps/api/.test-runs/` and remove only the specific `m4-09-*` directory created by that invocation.
