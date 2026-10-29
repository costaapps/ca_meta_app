# SDD playbook — Meta platform v2

Status: proposed process standard. Owner: architecture/technical leadership (role, not an assignee). This playbook governs changes from issue through verified release; it does not certify external access, provider behavior, or production readiness.

## Sources of truth

Use the current issue body, `AGENTS.md`, this playbook, the feature spec, accepted ADRs/contracts, implementation and tests in that order for their respective concerns. `AGENTS.md` indexes rules and security boundaries; it does not replace feature contracts. A chat, stale worktree, unmerged milestone branch, generated report, or historical context note cannot silently change an accepted contract. Record a justified exception in the scoped issue/ADR/PR and reconcile the affected docs and tests in that review.

Feature specs are organized under [specs/](specs/README.md) for authentication, tenancy, credentials, Meta onboarding, webhooks, portal, and legacy bridge. Their status is `proposed`, `ready`, `implemented`, or `verified`; do not set a later status without its evidence.

## Work states

| State | Entry evidence | Exit evidence |
|---|---|---|
| Backlog | Issue exists; scope may be incomplete. | Dependencies and criteria are reviewed for the work being selected. |
| Ready | Required dependencies for this slice are satisfied; contract is stable; acceptance is measurable; fixtures and stage-required evidence are available. A later real-provider gate may remain explicit if this slice does not depend on it. | Named package branch and writer begin. |
| In progress | One writer owns a bounded branch/worktree; scope and acceptance are recorded. | Candidate and evidence are ready for independent review, or a documented blocker is found. |
| In review | Exact candidate SHA, tests, diff, limitations and recovery are available; functional, security and validation roles review independently. | Findings are corrected/rechecked and CI/protections pass, or work returns to In progress. |
| Blocked | Record the affected scenario, missing evidence/resource, responsible functional role, next experiment, and independent work that can continue. Never invent a person or date. | Evidence/resource arrives and the blocked gate is re-evaluated. |
| Done | All in-scope criteria are proven, docs/consumers/tests match, reviews and checks pass, and the accepted milestone deliverable is integrated into `develop` after human acceptance. | Only the actual delivered issue is closed; dependents are released from that verified state. |

Acceptance on `desktop/milestone-mN` is an intermediate state, not Done and not a reason to close the issue. An external gate may be `Not confirmed`; keep it attached to the precise dependent scenario and do not use mocks as proof of real eligibility, grants, identity, deployment, or provider effects.

## Branch and version conventions

- Start a milestone branch as `desktop/milestone-mN` from the verified `develop` SHA. Give each package its own `desktop/mN-XX` branch and worktree; use the issue's package key, with a two-digit package number.
- Package PRs target the current milestone branch and merge by squash after the exact candidate SHA has required reviews and passing protections. The final milestone PR targets `develop`; only human acceptance and verified integration release that milestone's dependents.
- Do not make release tags for a package branch or milestone branch. The project release version is not assigned by this plan. When an actual release process is approved, use SemVer (`MAJOR.MINOR.PATCH`) to distinguish breaking, backward-compatible feature, and compatible fix releases; versioning the HTTP API path is a separate contract decision.
- A version, tag, deployment, or release is evidence only when its exact artifact and target environment are recorded. Planned values remain `NOT_RELEASED`.

## Functional responsibility and blocked work

Use [the responsibility matrix](responsibility-matrix.csv) to assign a functional role, not a fabricated person. A Blocked record names the affected acceptance scenario, missing evidence/resource, responsible role, next experiment and independent work that continues. The matrix gives the default role and first evidence experiment for each boundary; the current issue may narrow it when that decision is recorded.

Every issue and PR should state a bounded scope, acceptance IDs, owning functional role, dependencies, external gates, contract/spec/test links, rollback/recovery and exact validation. The templates under `.github/` provide the required prompts.

## One path for contract and ADR changes

1. Update the scoped issue and proposed/accepted ADR or feature spec with the reason, invariant, impact, and evidence.
2. Change the canonical contract source and its version/breaking-change baseline. Do not edit a generated client/schema by hand or create a competing copy.
3. Update every affected consumer, fixture, migration/recovery instruction, and test in the same package scope. If a dependent package is not in scope, record it as blocked on the new contract version; do not silently ship incompatibility.
4. Run the read-only contract/generator check and relevant package tests. Review the resulting diff, including generated files.
5. Get independent functional, security, and validation reviews on the exact SHA; resolve findings and run affected gates again.
6. Merge package PRs to the milestone branch by squash after required CI/protections pass. A final milestone PR targets `develop`; human acceptance and verified integration precede Done/issue closure.

For M1.07, `docs/meta-v2/contracts/openapi.yaml` is the canonical proposed HTTP contract; the frozen baseline and generated client are checked against it. Event schemas are versioned alongside it. A future implementation may replace this path only through an ADR and consumer/test migration in the same reviewed scope.

## Requirement traceability

`traceability.csv` carries every current acceptance-matrix requirement through issue, spec, contract, test, package PR, and release evidence. `matrix_evidence_status` preserves the planning matrix value; `delivery_status` records the observed package state separately. M1.01–M1.10 have verified package PRs merged into the milestone branch; final M1 acceptance and integration into `develop` remain pending human acceptance, so release evidence stays `NOT_RELEASED`. M1.10 package PR [#93](https://github.com/costaapps/ca_meta_app/pull/93) was squash-integrated at `ddb92588855f5128f6a173291c581a547e7b5317`. M2–M6 remain `PLANNED`. Unstarted packages use explicit `NOT_YET_AUTHORED`/`NOT_CREATED` markers; never fabricate a spec, test, PR, tag, release, owner, or date.

## Security and change checklist

- Resolve tenant only from authenticated server session/membership; `cUUID` and `company_uuid` are untrusted context inputs, not authority.
- Keep permanent provider credentials, authorization codes, app secrets, raw payloads, production data and raw backend environment values out of browser contracts, fixtures, logs, issues and AI context.
- Keep retry policy separate from local job retries and external side effects. `202`, popup close, timeout, redirect, or message acceptance does not prove completion. Never blindly replay a one-use code or an ambiguous non-idempotent effect.
- Write a bounded scope, explicit non-goals, baseline evidence, changed consumers/contracts, acceptance and negative cases, migration/recovery, rollout/rollback, environmental setup, validation commands/results, known limitations, and review roles into the PR.
- Changes to CI, validation profiles, allowed paths, required checks, or approval rules require a dedicated scope and independent review; the change being checked cannot approve itself. M2 CI/platform work may implement assigned controls, but cannot weaken its own tests or approvals or expand allowed paths to pass its validation. Reassess the actual validation profiles at every milestone boundary as the application moves toward the planned monorepository.
- Use synthetic fixtures and disposable services. State exactly which claims remain `Not confirmed`; tests do not certify real Meta grants, Suite4 issuer/membership, Hostinger deployment, or provider behavior.

## Explicit token-limit recovery rule

Only an explicit error stating that the token limit was exceeded triggers token-limit recovery: save the handoff, preserve files and commits, start a 45-minute timer, then resume the exact interrupted stage from that handoff and repeat only affected gates. Do not trigger this timer for generic errors, context compaction, timeouts, transport failures, or any other rate limit (including HTTP 429); follow a different supplied wait interval for that rate limit. The common Desktop execution contract is authoritative for this rule.
