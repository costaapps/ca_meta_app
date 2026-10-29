# ca_meta_app monorepo

This repository uses npm workspaces. The Angular application lives in `apps/web`; the API and
public contract workspaces are introduced separately so their toolchains and dependencies remain
isolated. Node.js `24.22.2` and npm `11.19.1` are the initial pinned local toolchain (see `.nvmrc`
and `package.json`). The project contains one root `package-lock.json`.

## Install and run

From the repository root:

```bash
npm ci
npm start
```

The Angular development server serves the existing app at `http://localhost:4200` and supports
direct navigation and refresh for `/setup`, `/channels`, and `/templates`. `npm run smoke:routes`
builds the static app and checks those deep links using a small Node built-in static server with an
SPA fallback. This verifies the Angular bundle plus fallback contract; the Nginx container and
proxy behavior are validated separately in M2.06.

## Workspace commands

```bash
npm run build
npm test
npm run typecheck
npm run lint
npm run build:web
npm run test:web
npm run start:web
npm run smoke:routes
```

The aggregate commands run the scripts declared by each present workspace. Later API and contract
packages add their own scripts without changing the root command surface. `lint` currently checks
the web import/dependency boundary; formatting and broader quality checks are added with the
delivery pipeline scope.

The Angular project configuration and its TypeScript configs are in `apps/web/`. From the web
workspace, `npm run build`, `npm test`, `npm run typecheck`, and `npm start` address that app alone.

## Current architecture

- `apps/web`: preserved Angular 21 standalone UI.
- `apps/api`: reserved workspace for the NestJS API (M2.02).
- `packages/contracts`: public HTTP/event contract artifacts (M2.04).
- `docs/meta-v2/contracts`: canonical OpenAPI and inbox/outbox source specifications.

This directory move does not change backend behavior, database schema, Meta assets, or credentials.
Desktop milestone scope, delivery gates, and handoff guidance are documented in the
[Desktop README](docs/codex-desktop/README.md).
