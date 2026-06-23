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
- Output location:
  - `dist/meta-integration`

### `npm test -- --watch=false`
- Result: failed
- Confirmed causes:
  - stale import path using `src/app/...`
  - Jasmine namespace usage in a Vitest-oriented setup
  - spec still expects removed `pages`, `getAvailablePages`, `connectPage`, `disconnectPage` API

Evidence:
- `src/app/features/channels/pages/channel-list/channel-list.component.spec.ts`
- command output captured during validation

## Current Coverage Reality
- Existing tests are minimal and at least partially stale.
- `src/app/app.spec.ts` still expects `Hello, meta-integration`, which does not match the routed app shell.
- `channel-list.component.spec.ts` targets an older page-list architecture that no longer exists.
- No tests were found for:
  - `ChannelSetupComponent`
  - `ChannelTemplatesComponent`
  - `NotificationBellComponent`
  - `MetaIntegrationService`

Evidence:
- `src/app/app.spec.ts`
- `src/app/features/channels/pages/channel-list/channel-list.component.spec.ts`

## Recommended Test Repair Order
1. Fix `App` shell spec to assert app creation and routed shell expectations only.
2. Rewrite `ChannelListComponent` spec against `connectedChannels` and `saveAutoReply`.
3. Add tests for `ChannelSetupComponent` query param handling of `cUUID`, `auth_success`, and `error`.
4. Add tests for WhatsApp template placeholder parsing and validation.
5. Add tests for notification action payload construction.

## Manual Validation Checklist For Future Changes
- Confirm route behavior from `/setup`, `/channels`, and `/templates`
- Confirm `cUUID` persistence and reuse
- Confirm login redirect request uses current tenant
- Confirm channel loading without tenant fails gracefully
- Confirm WhatsApp template list and creation payloads
- Confirm notification refresh and action payloads

## Non-Goals In This Phase
- Do not rewrite the test stack itself.
- Do not add a lint tool just for documentation work.
- Do not change runtime behavior only to make legacy tests pass.
