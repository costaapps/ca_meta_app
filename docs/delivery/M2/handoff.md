# M2 handoff

## Starting point

- Target package integration branch: `desktop/milestone-m2`.
- Verified base: `develop@2f0944d771ea7e98c520b20667586304e8bb9113`.
- M1 consolidated PR #94 is remotely merged to develop at this SHA. Its M1 handoff predates that merge; the live GitHub merge and develop tree take precedence.
- M2.01/#20 package PR #95 is merged by squash into the milestone branch as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. The issue remains open pending final acceptance in develop.

## Current stage

M2.01/#20 is accepted in the milestone branch. Package PR #95 head `957d00dfbf0113a41a5642282baf293532b29648` was squash-integrated as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. GitHub checks `desktop-candidate`, baseline, plan, and orchestrator succeeded; structure was skipped by its branch condition. Its local matrix and independent reviews are recorded in `progress.md`; the issue stays open until the consolidated PR is accepted in develop. The current first eligible package is M2.02/#21, whose prerequisites are integrated.

M2.02/#21 has a local package candidate on `desktop/m2-02`, source commit `301fee08bcb8c40453ce4b95c1cbf210a48da312`, based on milestone SHA `930cfc0bc3627dfb5b50e4c104ddc65b496ef1e2`. Local clean-install, build, typecheck, tests, lint, API production dependency audit and isolated MariaDB readiness evidence are recorded in `progress.md`. The candidate has no push or package PR. The path conflict between issue #21 and canonical M1.07 OpenAPI is resolved in `decisions.md`. Next actions are independent functional/security review and coordinator candidate checks; then the coordinator may prepare the package PR. Keep #21 open through consolidated acceptance in develop.

## Environment and limits

See `progress.md`. Preserve user-installed dependencies and the existing stopped MariaDB container. Use named disposable Docker projects/volumes for package test services. GitHub Projects #12 is not exposed by the available connector. Never publish images or alter shared/production staging resources without their authorization and credentials.

## Resume protocol

Before resuming, read current remote heads, attached worktrees, package PRs/checks/reviews, and this report. Re-run checks affected by changed base/content. Continue at the first dependency-eligible package; do not repeat completed work.
