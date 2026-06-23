# AGENTS.md

## Purpose
- `msg4_Meta_Application` is a standalone Angular frontend for Meta channel onboarding and management in Msg4.
- Today it demonstrates and operates a unified Meta connection flow; future work will split Facebook, Instagram, WhatsApp, and Embedded Signup.
- Treat the current code as the source of truth. Legacy docs often diverge.

## Installed Stack
- Angular `21.0.8`, Angular CLI `21.0.5`
- TypeScript `5.9.3` in strict mode
- RxJS `7.8.2`
- Test runner: Angular unit-test builder with Vitest packages installed
- Styling: SCSS, no Tailwind pipeline configured
- Backend currently consumed by the frontend: PHP endpoints behind `https://msg4.app/meta/auth`

## Architecture Summary
- Entry point: [src/main.ts](src/main.ts)
- Global providers: [src/app/app.config.ts](src/app/app.config.ts)
- Routes: [src/app/app.routes.ts](src/app/app.routes.ts)
- Core API service: [src/app/core/services/meta-integration.service.ts](src/app/core/services/meta-integration.service.ts)
- Main feature area: `src/app/features/channels`
- Local tenant persistence: `localStorage['cUUID']`
- Local PHP references: `backend/connect.php`, `backend/connect_old.php` are local-only and sensitive

## Essential Commands
- `npm start`
- `npm run build`
- `npm test -- --watch=false`
- `npx ng version`
- No lint script is currently configured in `package.json`

## Global Rules
- Preserve current behavior unless the task explicitly changes it.
- Prefer evidence from code over README or prompt templates.
- Document uncertainty as `Not confirmed`; never present inference as fact.
- Keep Angular code standalone-first and strict-typed.
- Do not assume Facebook, Instagram, and WhatsApp share the same future auth flow.

## Security Restrictions
- Never commit or copy secrets, tokens, app secrets, or raw backend env values.
- Keep permanent tokens and Meta credentials in the backend only.
- `backend/connect.php` and `backend/connect_old.php` are local references; do not commit or rewrite them without explicit approval.
- Treat `cUUID` and `company_uuid` as tenant-sensitive inputs requiring validation.

## Definition Of Done
- Behavior changes are justified and validated.
- Docs changes cite real files and commands.
- Build and relevant tests are run or explicitly blocked with the exact reason.
- No secrets or local-only sensitive values are introduced into tracked files.

## Current Priorities
- Stabilize documentation around the actual Angular 21 + PHP architecture.
- Record divergences between code and legacy documentation.
- Prepare safe ground for future auth-flow separation and iframe embedding in `suite4`.

## Context Map
- For architecture, bootstrapping, routing, and state boundaries: [.github/docs/agent-context/architecture.md](.github/docs/agent-context/architecture.md)
- For user journeys and page behavior: [.github/docs/agent-context/current-flows.md](.github/docs/agent-context/current-flows.md)
- For Meta auth/product flow details: [.github/docs/agent-context/meta-integrations.md](.github/docs/agent-context/meta-integrations.md)
- For frontend ↔ PHP endpoint contracts: [.github/docs/agent-context/backend-contracts.md](.github/docs/agent-context/backend-contracts.md)
- For Angular coding decisions in this repo: [.github/docs/agent-context/angular-guidelines.md](.github/docs/agent-context/angular-guidelines.md)
- For tokens, tenant safety, OAuth, CORS, and iframe security concerns: [.github/docs/agent-context/security.md](.github/docs/agent-context/security.md)
- For validation commands, test gaps, and known failures: [.github/docs/agent-context/testing-and-validation.md](.github/docs/agent-context/testing-and-validation.md)
- For future embedding in `suite4`: [.github/docs/agent-context/iframe-integration.md](.github/docs/agent-context/iframe-integration.md)
- For Git hygiene, local PHP handling, and release discipline: [.github/docs/agent-context/git-workflow.md](.github/docs/agent-context/git-workflow.md)
- For delivery sequencing and likely affected areas: [.github/docs/agent-context/roadmap.md](.github/docs/agent-context/roadmap.md)
- For confirmed defects and documentation drift: [.github/docs/agent-context/known-issues.md](.github/docs/agent-context/known-issues.md)
- For unresolved gaps that need proof: [.github/docs/agent-context/open-questions.md](.github/docs/agent-context/open-questions.md)
- For official references and decisions derived from them: [.github/docs/agent-context/references.md](.github/docs/agent-context/references.md)

## When To Load More Context
- Changing Angular components or services: load `architecture.md` and `angular-guidelines.md`
- Changing auth, callbacks, tokens, or Meta permissions: load `meta-integrations.md` and `security.md`
- Changing API calls or PHP expectations: load `backend-contracts.md`
- Changing channels, templates, setup, or notifications UX: load `current-flows.md`
- Planning iframe work for `suite4`: load `iframe-integration.md`
- Preparing validation or repairing tests: load `testing-and-validation.md`
- Preparing commits or deciding what must stay local-only: load `git-workflow.md`
