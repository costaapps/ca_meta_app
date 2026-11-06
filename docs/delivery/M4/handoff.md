# M4 handoff

## Current checkpoint

- Milestone: M4, target `desktop/milestone-m4`.
- `develop` start SHA: `b35e0ddae5ce09df2ca2ce09785be4332e653803`; this contains the squash merge of M3 PR #127.
- Integration branch/worktree: `desktop/milestone-m4` at `C:\Users\user\.codex\worktrees\m4-milestone\ca_meta_app`, initially created from the start SHA.
- Active package: M4.01 / #42, branch `desktop/m4-01`, worktree `C:\Users\user\.codex\worktrees\m4-01\ca_meta_app`, base `b35e0ddae5ce09df2ca2ce09785be4332e653803`.
- Package has uncommitted implementation files; do not discard or reset. There is no candidate SHA, commit, PR, test/build check, review or squash yet. The contract generator completed successfully in the package worktree.
- `desktop/milestone-m4` exists remotely. No other M4 package branch was created.

## Environment and evidence

- Local Node used for package dependency setup: `v24.22.1`; npm `11.19.1` launched directly from the Corepack cache with the Node 24 binary. Package worktree `npm ci --ignore-scripts` completed. The shared `develop` checkout's existing `node_modules` was not modified.
- Docker CLI/Compose are installed, but the Docker Desktop daemon is unavailable. No MariaDB alternative has been prepared or tested.
- `gh` is absent; the native GitHub connector can read the repository and current issues. The authenticated GitHub user is `eduardomatuella-costaapps`, with admin permission. Git identity is already configured.
- No tests/build/typecheck were executed by the M4.01 implementer. The focused command is documented in the package README/runbook for coordinator validation on an exact candidate SHA.
- Official evidence reviewed 2026-11-06 reports a v27.0 announcement and a stale v26.0 changelog snapshot; Graph endpoint compatibility/version remains **Not confirmed**. App IDs, mode, permission grants, App Review, Sandbox, Coexistence eligibility, and production callbacks remain **Not confirmed**.
- M1.03 capability docs and synthetic 12-case harness are preserved. Do not treat their fixture values as current Meta versions or grants.

## Exact next action

Review the final M4.01 diff and changed-file list for secrets and scope drift, then let the coordinator create the candidate SHA and run the focused API/contract gates once. Follow with exact-SHA correction, validation and independent source/security review. Do not start dependents until M4.01 is squash-integrated into the milestone branch.
