# AGENTS.md

## Purpose and source of truth

`ca_meta_app` is an npm-workspace monorepo with a standalone Angular frontend for Meta onboarding and management in Msg4 and versioned PHP endpoint references. The code and SHA-specific evidence are authoritative; do not infer deployed PHP/rewrite behavior from this checkout. The target platform separates Facebook, Instagram, WhatsApp exclusive and WhatsApp Coexistence journeys. Do not assume shared auth flows.

Current stack recorded in [`apps/web/package.json`](apps/web/package.json) and Angular configuration: Angular 21, strict TypeScript, RxJS and SCSS. Frontend entry, providers, routes and core API service are indexed in [apps/web/src/main.ts](apps/web/src/main.ts), [app.config.ts](apps/web/src/app/app.config.ts), [app.routes.ts](apps/web/src/app/app.routes.ts) and [meta-integration.service.ts](apps/web/src/app/core/services/meta-integration.service.ts). Root scripts and the npm lockfile are in `package.json` and `package-lock.json`. Local browser storage `cUUID` is tenant-sensitive context, never proof of identity or membership.

## Non-negotiable guardrails

- Preserve behavior unless the accepted scope changes it. Keep Angular standalone-first and strict-typed.
- Mark uncertainty **Not confirmed**. Cite files, tests, environment and SHA for claims.
- Never commit/copy secrets, tokens, app secrets, raw backend environment values or customer data. Permanent Meta credentials stay backend-side.
- `backend/connect.php` and `backend/connect_old.php` are local sensitive references: do not open, copy, commit or rewrite them. Versioned PHP sources are separate evidence and do not prove deployed equivalence.
- Validate `cUUID`/`company_uuid`; never use them as authorization. Do not send real messages, alter production subscriptions/data, import real credentials, deploy, or retire PHP without the task's explicit authorization and external gates.

## Context index

| Topic | Read |
|---|---|
| Architecture, routes and state | [.github/docs/agent-context/architecture.md](.github/docs/agent-context/architecture.md) |
| Current journeys and page behavior | [.github/docs/agent-context/current-flows.md](.github/docs/agent-context/current-flows.md) |
| Meta auth and flow families | [.github/docs/agent-context/meta-integrations.md](.github/docs/agent-context/meta-integrations.md) |
| Frontend/PHP contracts | [.github/docs/agent-context/backend-contracts.md](.github/docs/agent-context/backend-contracts.md) |
| Angular decisions and tests | [.github/docs/agent-context/angular-guidelines.md](.github/docs/agent-context/angular-guidelines.md), [testing-and-validation.md](.github/docs/agent-context/testing-and-validation.md) |
| Tenant, credentials, OAuth, CORS and iframe | [.github/docs/agent-context/security.md](.github/docs/agent-context/security.md), [iframe-integration.md](.github/docs/agent-context/iframe-integration.md) |
| Historical context to reconcile | [git-workflow.md](.github/docs/agent-context/git-workflow.md), [known-issues.md](.github/docs/agent-context/known-issues.md), [roadmap.md](.github/docs/agent-context/roadmap.md), [open-questions.md](.github/docs/agent-context/open-questions.md) |

## Specification-driven delivery index

- Read the assigned prompt, current GitHub issue, [Desktop README](docs/codex-desktop/README.md), [execution contract](docs/codex-desktop/execution-contract.md), [scope decisions](docs/codex-desktop/scope-decisions.md) and [handoff rules](docs/codex-desktop/progress-and-handoff.md).
- Use [.planning/manifest.json](.planning/manifest.json), [.planning/issues-map.json](.planning/issues-map.json), accepted specs/ADRs/contracts and code evidence. Do not invoke the legacy `tools/orchestrator` or its SQLite state as the Desktop executor.
- Feature specs, states, Ready/Done, blocked records, branch/version conventions and functional-role ownership are indexed in [the SDD playbook](docs/meta-v2/sdd-playbook.md). Use [spec-template.md](docs/meta-v2/spec-template.md), [adr-template.md](docs/meta-v2/adr-template.md), [responsibility matrix](docs/meta-v2/responsibility-matrix.csv), and [traceability.csv](docs/meta-v2/traceability.csv).
- Keep requirement → issue → spec → contract → test → PR → release evidence linked. A contract/ADR change updates consumers and affected tests in the same reviewed scope. Planning or a milestone-branch merge alone is not Done; final milestone integration to `develop` requires human acceptance.
- Package branches use `desktop/mN-XX`, target `desktop/milestone-mN`, and merge by squash. Use the configured Git identity; never force-push, bypass protections, impersonate approval, or weaken delivery checks. Changes to delivery controls require a dedicated reviewed scope; M2 CI/platform work cannot weaken its own tests or approvals. Recheck validation profiles at every milestone boundary. One writer per worktree; preserve work through interruptions.
- Use native subagents for bounded roles when available. The principal coordinates work, environment, evidence, tests, reviews and integration. Run write-requiring experiments in isolated worktrees/services. Report exact commands and environment; do not claim checks on a later SHA ran early.
- Only an explicit error stating the token limit was exceeded triggers a 45-minute timer: save handoff, preserve files/commits, wait 45 minutes, resume the exact interrupted stage and repeat only affected gates. Generic errors, context compaction, timeouts and other rate limits do not trigger it; follow their own indicated interval.

## Loading and validation

Before changing components/services, load architecture and Angular guidance. For auth/tokens load Meta integration and security docs; for PHP/API load backend contracts; for UX load current flows; for Suite4 load iframe integration; for tests load testing/validation. `npm start`, `npm run build`, `npm test`, `npm run typecheck`, and `npm run lint` execute workspace scripts. App-specific commands are available with `--workspace=@ca-meta/web`. Run only checks relevant to scope and identify any blocked command with its exact reason.

M1.10 governance checks are documented in [tools/m1-10/README.md](tools/m1-10/README.md). They are read-only by default; do not run `.planning/validate.py`, `.planning/render.py` or `.planning/contracts.py` from the implementation checkout because they write generated artifacts.
