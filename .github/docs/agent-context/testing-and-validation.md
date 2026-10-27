# Testing And Validation

## Tooling Confirmed
- Package manager: `npm 10.9.2`
- Node: `22.17.0`
- Angular CLI: `21.0.5`
- Angular: `21.0.8`
- Test builder: `@angular/build:unit-test`
- Installed test package of note: `vitest`

Evidence:
- `package.json`
- `angular.json`
- `tsconfig.spec.json`
- `npx ng version`

## Available Commands
- `npm start`
- `npm run build`
- `npm test -- --watch=false`
- `npx ng version`

Not available:
- No lint script in `package.json`
- No e2e framework configured beyond Angular boilerplate text in `README.md`

## Validation Results Recorded In This Session

### `npm run build`
- Result: passed
- Output location: `dist/meta-integration`

### `npm test -- --watch=false`
- Result: passed

### `php -l backend/meta_auth_helper.php`
- Result: passed

### `php -l backend/connect_facebook.php`
- Result: passed

### `php -l backend/connect_instagram.php`
- Result: passed

## Current Coverage Reality
- `src/app/app.spec.ts` now matches the routed shell instead of the old title check.
- `src/app/features/channels/pages/channel-list/channel-list.component.spec.ts` now targets the current service contract.
- No tests were added for:
  - `ChannelSetupComponent`
  - `ChannelTemplatesComponent`
  - `NotificationBellComponent`
  - `MetaAuthService`

Evidence:
- `src/app/app.spec.ts`
- `src/app/features/channels/pages/channel-list/channel-list.component.spec.ts`

## Manual Validation Checklist For Future Changes
- Confirm route behavior from `/setup`, `/channels`, and `/templates`
- Confirm `cUUID` persistence and reuse
- Confirm login redirect request uses the current tenant and product context
- Confirm channel loading without tenant fails gracefully
- Confirm WhatsApp template list and creation payloads
- Confirm notification refresh and action payloads

## Non-Goals In This Phase
- Do not rewrite the test stack itself.
- Do not add a lint tool just for documentation work.
- Do not change runtime behavior only to make legacy tests pass.
