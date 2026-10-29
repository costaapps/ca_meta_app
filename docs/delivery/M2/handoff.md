# M2 handoff

## Starting point

- Target package integration branch: `desktop/milestone-m2`.
- Verified base: `develop@2f0944d771ea7e98c520b20667586304e8bb9113`.
- M1 consolidated PR #94 is remotely merged to develop at this SHA. Its M1 handoff predates that merge; the live GitHub merge and develop tree take precedence.
- M2.01/#20 package PR #95 is merged by squash into the milestone branch as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. The issue remains open pending final acceptance in develop.

## Current stage

M2.01/#20 is accepted in the milestone branch. Package PR #95 head `957d00dfbf0113a41a5642282baf293532b29648` was squash-integrated as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. GitHub checks `desktop-candidate`, baseline, plan, and orchestrator succeeded; structure was skipped by its branch condition. Its local matrix and independent reviews are recorded in `progress.md`; the issue stays open until the consolidated PR is accepted in develop. The current first eligible package is M2.02/#21, whose prerequisites are integrated.

Historical M2.02/#21 checkpoint, superseded by the current P1 follow-up below: source candidate 5283cf85e015a67f430bb2ea8a7720da1fab7d91 was locally committed on desktop/m2-02, based on 0812c20ba125071ee6351de7687a5302b83339bd. It fixed the earlier security review finding where a response close could release the drain lease while async handler work continued. The final implementation and evidence are recorded below.

Historical validation detail for the 5283cf8 checkpoint: clean npm ci/build/typecheck/CI test/lint/web regressions/API production audit passed. Windows reported API 14 pass and four explicit POSIX signal skips; Angular tests were 5/5. The pinned Linux runner passed 18/18 with zero skips. MariaDB readiness passed and removed only its own project resources, preserving db-migrations-mariadb-1. Full final evidence is recorded below and in progress.md.

At that historical checkpoint, the next action was independent review/validation; the current completed status is below. Keep #21 open through final acceptance in develop.

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

The Windows skips are specifically covered on Linux. Independent functional review, security review, and isolated validation all PASS on package head `e5c6f8ab744acaf6754bf267b74aa2021ffc6f94`; implementation is code commit `05a837d96593999b14d8fdf9c4292d95d2aa237e`, and the remaining package-head delta is documentation-only. The package is ready to push and open as a PR to `desktop/milestone-m2`; no push or PR exists yet. Keep #21 open until the consolidated PR is accepted in develop.

Non-blocking advisories and owners: direct clients can intentionally reuse a valid UUID v4 `X-Request-Id` and create ambiguous log grouping; M2.04 must resolve the trust/correlation policy before business routes. `ORIGIN_NOT_ALLOWED` currently represents a rejected Host although M1.07 defines it for Origin/Fetch Metadata; generic HTTP 500 currently uses retryable `DEPENDENCY_UNAVAILABLE`. M2.04 must align both with the error catalog/OpenAPI and update consumers/tests in the same reviewed contract scope. The request drain has no deadline and can wait until an external forced kill; M2.06/M2.07 must align handler duration limits and the container stop grace period. No M2.02 business route, Meta effect, production credential, migration, or staging operation is present or claimed.
## Environment and limits

See `progress.md`. Preserve user-installed dependencies and the existing stopped MariaDB container. Use named disposable Docker projects/volumes for package test services. GitHub Projects #12 is not exposed by the available connector. Never publish images or alter shared/production staging resources without their authorization and credentials.

## Resume protocol

Before resuming, read current remote heads, attached worktrees, package PRs/checks/reviews, and this report. Re-run checks affected by changed base/content. Continue at the first dependency-eligible package; do not repeat completed work.
