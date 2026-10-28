# AGENTS.md

## Purpose
- `msg4_Meta_Application` is a standalone Angular frontend for Meta channel onboarding and management in Msg4.
- The versioned backend references contain separated product flows. The deployed legacy PHP may still use a unified flow; do not assume source/deployment equivalence. The new platform replaces PHP and treats Facebook, Instagram, WhatsApp exclusive and Coexistence as distinct journeys.
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

## Codex Desktop milestone delivery
- New milestone execution uses the native Desktop principal chat and subagents. Read [the Desktop kit](docs/codex-desktop/README.md), [execution contract](docs/codex-desktop/execution-contract.md), [scope decisions](docs/codex-desktop/scope-decisions.md) and the assigned prompt under docs/codex-desktop/prompts/.
- The user restarts delivery from develop using new desktop/milestone-mN and desktop/mN-XX branches. Preserve historical branches/PRs and uncommitted work; do not inherit old acceptance without verifying develop.
- Do not invoke tools.orchestrator run/resume/finalize, use .orchestrator SQLite as the execution ledger, or require its result schemas/attempt budget. Legacy docs/execution and controller code are retained for history, not the Desktop workflow authority.
- Use .planning/manifest.json and issues-map.json plus current issue bodies, accepted specs and explicit scope decisions. Execute dependencies in order while advancing independent discovery with documented assumptions; do not invent provider, DDL or deployment evidence.
- The Desktop principal owns planning, environment, checkpoints, tests and integration. Delegate bounded work to .codex/agents roles with issue, worktree, base/head, scope and criteria. One writer per worktree and one GitHub integration lane. If native delegation is unavailable, perform the roles sequentially and state the limitation.
- Package PRs target desktop/milestone-mN and all PR integrations MUST be squash. The final milestone PR targets develop and requires human acceptance. Never force-push, use administrative bypass, impersonate an approval or change protections to pass a gate.
- Use the configured Git identity. Never set a fabricated automation email. Agents are roles, not separate GitHub users or permission boundaries.
- Run package-specific experiments and tests in writable isolated checkouts/services; source reviewers may use exact-SHA evidence independently. Missing tests are coordinated in-session, not deferred to user commands. Do not require a report to contain the hash of its own final commit.
- Preserve files/commits and resume the pending stage after interruption. Base movement, setup, CI failures and review corrections are normal coordination work. Record handoffs under docs/delivery/MN/ and keep the main Desktop chat updated.
- Keep issues open while accepted only in the milestone branch. After human squash into develop, verify the actual final integration, then close only delivered issues and release their dependencies. Never use the old Python finalize command for Desktop delivery.
- Public official Meta research needs no Sandbox. Local design/fixtures do not certify real grants, subscriptions, Suite4 identity or production behavior. Record the exact remaining gate before the dependent real scenario; do not stop unrelated implementation.
- Do not deploy, migrate real data, send real messages, publish to shared environments, import real credentials or retire PHP without the corresponding explicit authorization. M6 separates release readiness from the authorized real rollout.
- Changes to delivery controls require dedicated reviewed scope; M2 CI/platform issues may implement their assigned controls, but cannot weaken tests or approvals to pass their own changes. Keep secrets and sensitive local PHP out of tracked artifacts and chat output.

## Specification-driven delivery
- Start from the package's accepted spec and use [spec-template.md](docs/meta-v2/spec-template.md), [adr-template.md](docs/meta-v2/adr-template.md) and [governance](docs/meta-v2/07-acceptance-risk-and-governance.md). Record scope, invariants, contracts, Given/When/Then scenarios, migration/recovery and verifiable acceptance.
- Ready requires satisfied dependencies, stable contracts, fixtures and the operational evidence required by the package. Done requires the reviewed deliverable, relevant checks, documentation and verified final milestone integration; planning alone does not complete implementation.
- Maintain requirement → issue → spec → contract → test → PR traceability. A contract/ADR change must update consumers and affected tests in the same reviewed scope; do not silently override the approved contract from a chat or code comment.
- Historical documents under `.github/docs/agent-context/` describe their recorded baseline. Reconcile them with the current code and recorded experiment before treating their claims as current behavior.
- Delivery controls require a dedicated reviewed scope, not self-approval by the implementation being checked. Do not weaken a validation or expand allowed paths as part of the delivery being validated. Review validation profiles at each milestone boundary as the application moves into the planned monorepository.
