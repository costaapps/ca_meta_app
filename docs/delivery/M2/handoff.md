# M2 handoff

## Starting point

- Target package integration branch: `desktop/milestone-m2`.
- Verified base: `develop@2f0944d771ea7e98c520b20667586304e8bb9113`.
- M1 consolidated PR #94 is remotely merged to develop at this SHA. Its M1 handoff predates that merge; the live GitHub merge and develop tree take precedence.
- No M2 package PRs existed at start. All package issues are open.

## Current stage

M2.01/#20 is implemented in the managed `m2-01` worktree on branch `desktop/m2-01`, based on `af941f29e1b0862f46f299eb08ae544d1af1f04a` and synchronized with milestone tip `ca7442da8e4f2ea339ce4340c165aa1577131b9b`. The validated source candidate is `069b057721f4748bcae9ebfb92c621eaed5ad747`; subsequent changes in this handoff/progress report do not alter package code or dependencies. On Node 24.22.2/npm 11.19.1, clean `npm ci` passed for the same manifest/lock snapshot (504 packages; 46 inherited audit findings and five npm install-script warnings). Aggregate build, 5/5 Angular tests, typecheck, lint/self-tests, bundle scan, dev and static route smokes, and `git diff --check` passed. Functional and security reviews passed without blockers; the import checker is documented as a static heuristic, with broader CI/security controls remaining in M2.08. Next action: publish the package branch, open its PR to `desktop/milestone-m2`, verify remote checks/reviews/protections, and squash only if all required gates pass.

## Environment and limits

See `progress.md`. Preserve user-installed dependencies and the existing stopped MariaDB container. Use named disposable Docker projects/volumes for package test services. GitHub Projects #12 is not exposed by the available connector. Never publish images or alter shared/production staging resources without their authorization and credentials.

## Resume protocol

Before resuming, read current remote heads, attached worktrees, package PRs/checks/reviews, and this report. Re-run checks affected by changed base/content. Continue at the first dependency-eligible package; do not repeat completed work.
