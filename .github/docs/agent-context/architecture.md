# Architecture

## Current Shape
- This is an npm-workspace monorepo: the preserved Angular application is in `apps/web`; `apps/api` and `packages/contracts` are reserved workspace boundaries for the following packages.
- The web application remains centered on one feature area: Meta channel onboarding and management.
- The root shell is intentionally thin, and most behavior lives in routed pages plus a small set of shared integration files.
- Tenant context is lightweight and reused across flows rather than managed by a larger app-wide state layer.

Evidence:
- `apps/web/src/main.ts`
- `apps/web/src/app/app.config.ts`
- `apps/web/src/app/app.routes.ts`
- `package.json`
- `apps/web/package.json`

## Project Layers
- `apps/web/src/app/core/`
  - shared contracts
  - service-level integration logic
- `apps/web/src/app/features/channels/`
  - setup
  - connected channels
  - WhatsApp templates
  - review-related notifications
- `apps/web/src/environments/`
  - backend base configuration

Evidence:
- `apps/web/src/app/core/**/*`
- `apps/web/src/app/features/channels/**/*`
- `apps/web/src/environments/*`

## Routing
- Routing is flat and simple.
- The main user-facing areas are setup, channel management, and WhatsApp templates.
- There is no lazy loading, resolver, or guard layer at the moment.

Evidence:
- `apps/web/src/app/app.routes.ts`

## State And Reactivity
- The codebase is currently RxJS-oriented.
- Most state is local to the screen or component that needs it.
- There is no real Signals adoption yet, and no need to force one before broader refactors.

Evidence:
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `apps/web/src/app/features/channels/**/*.ts`

## Backend Boundary
- The frontend talks to a PHP backend through a small number of direct HTTP integration paths.
- The actual runtime contract is defined by the current Angular consumers plus the local PHP handlers.
- `backend/connect_old.php` is useful as historical context, not as the preferred operational reference.

Evidence:
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `apps/web/src/app/features/channels/components/notification-bell/notification-bell.component.ts`
- `backend/connect.php`
- `backend/connect_old.php`

## Styling And Tooling
- Styling is SCSS-based.
- There is a lightweight global utility layer, but no true Tailwind build pipeline.
- Build and test tooling are modern Angular 21 tooling, though the tests themselves still need cleanup.

Evidence:
- `apps/web/src/styles.scss`
- `apps/web/angular.json`
- `apps/web/package.json`
- `apps/web/src/app/**/*.spec.ts`
