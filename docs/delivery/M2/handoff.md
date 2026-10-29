# M2 handoff

## Starting point

- Target package integration branch: `desktop/milestone-m2`.
- Verified base: `develop@2f0944d771ea7e98c520b20667586304e8bb9113`.
- M1 consolidated PR #94 is remotely merged to develop at this SHA. Its M1 handoff predates that merge; the live GitHub merge and develop tree take precedence.
- M2.01/#20 package PR #95 is merged by squash into the milestone branch as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. The issue remains open pending final acceptance in develop.

## Current stage

M2.01/#20 is accepted in the milestone branch. Package PR #95 head `957d00dfbf0113a41a5642282baf293532b29648` was squash-integrated as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. GitHub checks `desktop-candidate`, baseline, plan, and orchestrator succeeded; structure was skipped by its branch condition. Its local matrix and independent reviews are recorded in `progress.md`; the issue stays open until the consolidated PR is accepted in develop. The current first eligible package is M2.02/#21, whose prerequisites are integrated.

M2.02/#21 follow-up source candidate 5283cf85e015a67f430bb2ea8a7720da1fab7d91 is locally committed on desktop/m2-02, based on 0812c20ba125071ee6351de7687a5302b83339bd. It fixes the security review finding where a response close could release the drain lease while async handler work continued. The API now tracks transport and handler work separately: SIGTERM waits for Promise completion or explicit post-cleanup cancellation acknowledgement for an Observable. The acknowledgement is rejected until signal.aborted. Tests cover aborted client response with Promise handler pending, response finished before handler completion, and RxJS unsubscribe followed by explicit cleanup acknowledgement. The exact health contract decision is in decisions.md: 200 returns {"status":"ok"}, and readiness DB failure returns the canonical 503 Unavailable ErrorEnvelope; OpenAPI was not changed.

On the source snapshot later committed as 5283cf85e015a67f430bb2ea8a7720da1fab7d91, clean npm ci/build/typecheck/CI test/lint/web regressions/API production audit passed. Windows reports API 14 pass and four explicit POSIX signal skips; Angular tests are 5/5. After the source commit, the Linux runner's only change prints its synthetic UUID/volume names; the final pinned runner execution passed 18/18 with zero skips. MariaDB harness passed under isolated project m202-api-ready-a674e72b7dc3426aaa8df63cc52eddb9, proving /ready 200→canonical 503 during outage→200 after recovery and /health 200 while down. It removed only its own project resources and preserved db-migrations-mariadb-1. Linux run cc466ae24e434b31ab9dd222411339c5 used exact volumes m202-sigterm-root-cc466ae24e434b31ab9dd222411339c5 and m202-sigterm-api-cc466ae24e434b31ab9dd222411339c5; both are confirmed removed. Full commands and install audit warnings are in progress.md.

The follow-up code commit 5283cf85e015a67f430bb2ea8a7720da1fab7d91 was validated while checked out as a working-tree snapshot before commit; the progress/handoff and UUID-reporting runner are committed separately and do not change runtime/test source. No push or PR exists. Next: principal/reviewers should run independent functional/security review and validation on the updated branch head; coordinator owns consolidation. Keep #21 open through final acceptance in develop.
## Environment and limits

See `progress.md`. Preserve user-installed dependencies and the existing stopped MariaDB container. Use named disposable Docker projects/volumes for package test services. GitHub Projects #12 is not exposed by the available connector. Never publish images or alter shared/production staging resources without their authorization and credentials.

## Resume protocol

Before resuming, read current remote heads, attached worktrees, package PRs/checks/reviews, and this report. Re-run checks affected by changed base/content. Continue at the first dependency-eligible package; do not repeat completed work.
