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

## Meta v2 Milestone Automation
- For authorized automated execution, read [docs/execution/README.md](docs/execution/README.md), [protocol.md](docs/execution/protocol.md) and [review-policy.md](docs/execution/review-policy.md).
- The canonical work graph is `.planning/manifest.json` with real issue identities in `.planning/issues-map.json`. Runtime checkpoint state is under ignored `.orchestrator/`; do not create a competing backlog.
- Explicitly delegate independent bounded tasks to the project agents under `.codex/agents/`. Supply the issue, exact base/head commit, permitted paths, acceptance criteria and required output schema. Do not allow two writers to share one checkout.
- The supervisor invoked through `python3 -m tools.orchestrator` owns GitHub mutations, checkpoints and integration. Agent roles propose and review; they do not bypass supervisor gates.
- Every automated PR merge MUST be **squash**. Never fall back to merge commits or rebase merge, force push, use administrative bypass or change protections when a gate rejects an operation.
- Work-package PRs target `automation/milestone-mN`. The final Milestone PR targets `develop` and requires the responsible human's acceptance; no unattended final merge, deployment or production changes.
- A package accepted in the Milestone branch is not yet completed in `develop`. Do not close implementation issues or epics early, and do not add automatic closing keywords to package PRs.
- After the responsible human merges the final PR by squash, use the supervisor's `finalize M1 --execute` equivalent for that milestone to verify the exact final tree before closing scoped issues and releasing downstream work. GitHub may delete the source branch after merge; keep the local checkpoint and Git objects available for verification.
- Independent reviews and validation evidence must refer to the exact reviewed SHA. New changes or a changed integration base invalidate the affected acceptance and must be reconciled.
- Missing operational PHP, DDL, Suite4 identity, Meta permissions or external approvals is an explicit blocker; mocks and historical reports do not satisfy those gates.
- Agents may not modify execution policy, supervisor, agent definitions or CI gates to pass their own delivery. Legitimate changes to those controls need a dedicated reviewed scope.
- Custom agent instructions do not create separate sandboxes or GitHub identities. Respect the parent's actual permissions and branch protections; never claim an AI verdict is a required human approval.
- Keep credentials, runtime logs, raw provider payloads and local sensitive PHP out of tracked files, prompts, issues and PRs. Use the least privileged authorized environment.

## Specification-driven delivery
- Start from the package's accepted spec and use [spec-template.md](docs/meta-v2/spec-template.md), [adr-template.md](docs/meta-v2/adr-template.md) and [governance](docs/meta-v2/07-acceptance-risk-and-governance.md). Record scope, invariants, contracts, Given/When/Then scenarios, migration/recovery and verifiable acceptance.
- Ready requires satisfied dependencies, stable contracts, fixtures and the operational evidence required by the package. Done requires the reviewed deliverable, relevant checks, documentation and verified final milestone integration; planning alone does not complete implementation.
- Maintain requirement → issue → spec → contract → test → PR traceability. A contract/ADR change must update consumers and affected tests in the same reviewed scope; do not silently override the approved contract from a chat or code comment.
- Historical documents under `.github/docs/agent-context/` describe their recorded baseline. Reconcile them with the current code and recorded experiment before treating their claims as current behavior.
- Controls protected by the supervisor require a dedicated human-reviewed change. Do not weaken a validation or expand allowed paths as part of the delivery being validated. Review validation profiles at each milestone boundary as the application moves into the planned monorepository.
