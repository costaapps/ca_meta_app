# Testing And Validation

## Pre-M2 Baseline Tooling
- Package manager: `npm 10.9.2`
- Node: `22.17.0`
- Angular CLI: `21.0.5`
- Angular: `21.0.8`
- Test builder: `@angular/build:unit-test`
- Installed test package of note: `vitest`

Evidence:
- `apps/web/package.json`
- `apps/web/angular.json`
- `apps/web/tsconfig.spec.json`
- `npx ng version`

## Current Workspace Commands
- Root commands: `npm start`, `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`.
- Web-specific commands: `npm run start --workspace=@ca-meta/web`, `npm run build --workspace=@ca-meta/web`, `npm test --workspace=@ca-meta/web`, `npm run typecheck --workspace=@ca-meta/web`, `npm run lint --workspace=@ca-meta/web`.
- Toolchain pin: Node `24.22.2`, npm `11.19.1`, declared by `.nvmrc` and the root `package.json`.
- Web import-boundary lint is implemented in `tools/m2/check-web-boundary.mjs`; it does not claim to be a formatter or general style linter.

The root aggregate scripts run scripts from each workspace that declares them (`--if-present`).

## Baseline Validation Before M2.01

- `npm ci`, `npm run build`, and `npm test -- --watch=false` passed on Node `24.22.2` / npm `11.19.1` at milestone start.
- The install reported 46 audit findings inherited from the Angular baseline. No audit auto-fix was applied.
- No e2e framework configured beyond Angular boilerplate text in `README.md`

## Validation Results Recorded In This Session

### `npm run build`
- Result: passed
- Pre-move output location: `dist/meta-integration`; after M2.01 the workspace output is under `apps/web/dist/meta-integration`.

### `npm test -- --watch=false`
- Result: passed

### `php -l backend/meta_auth_helper.php`
- Result: passed

### `php -l backend/connect_facebook.php`
- Result: passed

### `php -l backend/connect_instagram.php`
- Result: passed

## Current Coverage Reality
- `apps/web/src/app/app.spec.ts` now matches the routed shell instead of the old title check.
- `apps/web/src/app/features/channels/pages/channel-list/channel-list.component.spec.ts` now targets the current service contract.
- No tests were added for:
  - `ChannelSetupComponent`
  - `ChannelTemplatesComponent`
  - `NotificationBellComponent`
  - `MetaAuthService`

Evidence:
- `apps/web/src/app/app.spec.ts`
- `apps/web/src/app/features/channels/pages/channel-list/channel-list.component.spec.ts`

## Manual Validation Checklist For Future Changes
- Confirm route behavior from `/setup`, `/channels`, and `/templates`
- Confirm `cUUID` persistence and reuse
- Confirm login redirect request uses the current tenant and product context
- Confirm channel loading without tenant fails gracefully
- Confirm WhatsApp template list and creation payloads
- Confirm notification refresh and action payloads

## Non-Goals In This Phase
- Do not rewrite the test stack itself.
- The boundary check is deliberately limited to preventing web imports/dependencies on server-only modules.
- Do not change runtime behavior only to make legacy tests pass.
