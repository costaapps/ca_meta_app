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

### Current M2.02/#21 P1 follow-up

Current code candidate: 05a837d96593999b14d8fdf9c4292d95d2aa237e on desktop/m2-02, directly based on 80548645b562147abb713cbff9751349f1d857b0. The functional review P1 was that RxJS takeUntil(signal) could complete/error on request abort, causing RequestDrainInterceptor to release a lease before asynchronous Observable cleanup completed. The fix requires an explicit post-cleanup acknowledgeCancellation() for Observable handlers after abort. Promise handlers and synchronous Object/void handlers such as /health still settle normally. Missing return metadata fails closed; Promise<Observable>, type-erased Observable, and dynamic handlers use @RequireCancellationAcknowledgement(). Reflect.hasMetadata distinguishes a declared void return type from truly missing metadata. README and the Linux runner document this contract.

The process regression fixture returns Promise<Observable> marked for cancellation acknowledgement. It exercises takeUntil(signal), client disconnect, asynchronous cleanup, then SIGTERM; app close/drain must remain pending until the cleanup ACK. Existing Promise-after-abort and pre-abort-ACK-rejection cases remain.

Final checks on the code snapshot 05a837d96593999b14d8fdf9c4292d95d2aa237e:
- Isolated bounded case: tools/m2-02/run-sigterm-drain-linux.ps1 -TestName 'Observable takeUntil completion' — 1/1 pass; UUID 5ad920ccd2954e22be339d38818f9eb9; its two volumes were removed.
- Linux full suite: tools/m2-02/run-sigterm-drain-linux.ps1 — 21/21 pass, no skips; pinned Node 24.22.2 digest; UUID be0e6eb71da741c1891425d352967261; both exact m202-sigterm-root- and m202-sigterm-api- UUID volumes absent after cleanup.
- Windows CI command npm test -- --watch=false — exit 0; API 16 pass/5 POSIX subprocess skips, Angular 5/5.
- npm run typecheck, npm run build, npm run lint — exit 0; Angular bundle 372.81 kB.
- MariaDB readiness harness — exit 0, UUID project m202-api-ready-6701c8cd145f46ae8bcdc5b85a23162e; /ready 200→canonical 503→200, /health remained 200 during outage; exact project container/network/volumes removed. Pre-existing db-migrations-mariadb-1 remained stopped.
- npm audit --workspace=@ca-meta/api --omit=dev — 0 production vulnerabilities; package lock unchanged. Isolated npm ci reported 2 development advisories (1 moderate, 1 high).
- git diff --check — exit 0.

The Windows skips are specifically covered on Linux. Code commit is 05a837d96593999b14d8fdf9c4292d95d2aa237e; this handoff/progress update is a separate documentation-only commit. No push or PR. Next action is independent functional/security review and validation of the exact code SHA 05a837d96593999b14d8fdf9c4292d95d2aa237e; keep #21 open pending review and milestone acceptance.
## Environment and limits

See `progress.md`. Preserve user-installed dependencies and the existing stopped MariaDB container. Use named disposable Docker projects/volumes for package test services. GitHub Projects #12 is not exposed by the available connector. Never publish images or alter shared/production staging resources without their authorization and credentials.

## Resume protocol

Before resuming, read current remote heads, attached worktrees, package PRs/checks/reviews, and this report. Re-run checks affected by changed base/content. Continue at the first dependency-eligible package; do not repeat completed work.
