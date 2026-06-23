# Architecture

## Current Shape
- This is a small standalone Angular application centered on one feature area: Meta channel onboarding and management.
- The root shell is intentionally thin, and most behavior lives in routed pages plus a small set of shared integration files.
- Tenant context is lightweight and reused across flows rather than managed by a larger app-wide state layer.

Evidence:
- `src/main.ts`
- `src/app/app.config.ts`
- `src/app/app.routes.ts`

## Project Layers
- `src/app/core/`
  - shared contracts
  - service-level integration logic
- `src/app/features/channels/`
  - setup
  - connected channels
  - WhatsApp templates
  - review-related notifications
- `src/environments/`
  - backend base configuration

Evidence:
- `src/app/core/**/*`
- `src/app/features/channels/**/*`
- `src/environments/*`

## Routing
- Routing is flat and simple.
- The main user-facing areas are setup, channel management, and WhatsApp templates.
- There is no lazy loading, resolver, or guard layer at the moment.

Evidence:
- `src/app/app.routes.ts`

## State And Reactivity
- The codebase is currently RxJS-oriented.
- Most state is local to the screen or component that needs it.
- There is no real Signals adoption yet, and no need to force one before broader refactors.

Evidence:
- `src/app/core/services/meta-integration.service.ts`
- `src/app/features/channels/**/*.ts`

## Backend Boundary
- The frontend talks to a PHP backend through a small number of direct HTTP integration paths.
- The actual runtime contract is defined by the current Angular consumers plus the local PHP handlers.
- `backend/connect_old.php` is useful as historical context, not as the preferred operational reference.

Evidence:
- `src/app/core/services/meta-integration.service.ts`
- `src/app/features/channels/components/notification-bell/notification-bell.component.ts`
- `backend/connect.php`
- `backend/connect_old.php`

## Styling And Tooling
- Styling is SCSS-based.
- There is a lightweight global utility layer, but no true Tailwind build pipeline.
- Build and test tooling are modern Angular 21 tooling, though the tests themselves still need cleanup.

Evidence:
- `src/styles.scss`
- `angular.json`
- `package.json`
- `src/app/**/*.spec.ts`
