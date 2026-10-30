# M2 handoff

## Starting point

- Target package integration branch: `desktop/milestone-m2`.
- Verified base: `develop@2f0944d771ea7e98c520b20667586304e8bb9113`.
- M1 consolidated PR #94 is remotely merged to develop at this SHA. Its M1 handoff predates that merge; the live GitHub merge and develop tree take precedence.
- M2.01/#20 package PR #95 is merged by squash into the milestone branch as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. The issue remains open pending final acceptance in develop.

## Current stage

M2.01/#20 is accepted in the milestone branch. Package PR #95 head `957d00dfbf0113a41a5642282baf293532b29648` was squash-integrated as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. GitHub checks `desktop-candidate`, baseline, plan, and orchestrator succeeded; structure was skipped by its branch condition. Its local matrix and independent reviews are recorded in `progress.md`; the issue stays open until the consolidated PR is accepted in develop.

M2.02/#21 package PR #96 head `868634a7749fa8ba3eb229670fd4384b60f87650` was squash-integrated as `398ab42cd00b4fc181f9c49e7b4eebd6e48f88a9`. `orchestrator` and `desktop-candidate` succeeded; functional/security reviews and isolated validation passed. The issue stays open until the consolidated PR is accepted in develop.

M2.03/#22 package PR #97 head `cb188464d985ab574d8829b1c4c7071a2053415f` was squash-integrated as `5956663454c6affeef1121bfca19a76e8049fd30`; both GitHub checks passed, independent static review and validation passed, and the issue remains open pending final acceptance in develop. Its final code SHA is `15b2b67e993b2f4dfac9589615faa8de421f9f60`; complete evidence is in `docs/delivery/M2/packages/M2.03-evidence.md`.

M2.04/#23 package PR #98 final head `4c68aa6fe03737ad9bb8791b15d9d009cfa34e98` passed `desktop-candidate`, `baseline`, `plan`, `orchestrator`, and `m1-07-contract`; `structure` was skipped by its branch condition. Independent static review and Linux validation passed on that exact head. Squash-integrated as `29a1b1ade165dcb48ffa676d5cd54a523c612e65` into `desktop/milestone-m2`. M2.04 code SHA is `2eb1a00c495527d845e2df334564a3c649550c7e`; evidence including the scoped CI rebuild, the initial transient local subprocess timeouts, and external binary digest limitation is in `packages/contracts/README.md`. Keep #23 open until consolidated acceptance in develop.

M2.05/#24 package PR #99 (`desktop/m2-05` → `desktop/milestone-m2`) was squash-integrated as `52e9745137680056860cf4d1fbf3b9ffd7c2c62a`; its final PR head was `54a83c1006455a911786b398df611101f5ff6512`, with code/test snapshot `80fc9df8cf925731b90064af38109a2c305d4ff5`. `desktop-candidate` run 40985805735 and `orchestrator` run 40985805733 succeeded. On Windows with Node 24.22.2/npm 11.19.1, the isolated MariaDB 11.8.8 harness passed 1/1; root build, tests, typecheck and lint passed. Seven API cases were skipped by the Windows root suite because they require POSIX subprocesses or their dedicated MariaDB harness; M2.05's dedicated MariaDB harness passed. Evidence is in `tools/m2-05/README.md`. The lane cursor serializes same-lane claims; throughput under broad contention was not measured. Keep #24 open until the consolidated PR is accepted in develop.

M2.06/#26 package PR #100 (`desktop/m2-06` → `desktop/milestone-m2`) merged by squash as `7d8544eeb78690cff7bebaebdb950421ddb94545`, based on `52e9745137680056860cf4d1fbf3b9ffd7c2c62a`. Final PR head was `39af70a3bc2cd23199f53f94b69902a111318bb0`; code candidate was `d0cf242aaa574bf4c5208220b60bc9ddd76b3326`. Checks `desktop-candidate` (run 40992934976) and `orchestrator` (run 40992934977) succeeded on the final head, each with one non-blocking Ubuntu runner lifecycle notice. Functional/security reviews passed; #26 remains open through consolidated acceptance in develop.

The exact local command `pwsh -NoLogo -NoProfile -File tools/m2-06/run-container-smoke.ps1` passed with exit 0 on Windows PowerShell 7.6.5, Docker Engine 28.3.0/Linux, Compose v2.38.1 and pinned Node 24.22.2/npm 11.19.1 image build base. Run ID `14b19f797dec416e888fb5b0158e1de0`; scanner checked 14 web and 13 API layers. It proved deep Angular callback refresh, immutable asset cache, public runtime config, proxy/size limits, non-root/read-only settings and clean API/worker SIGTERM. Temporary resources were absent afterward; `db-migrations-mariadb-1` remained stopped. Complete evidence and limits are in `docs/delivery/M2/packages/M2.06-evidence.md`. No registry publication or external Meta/staging/production operation occurred.

The current Docker Desktop Engine responds and Compose v2.38.1 is available. `docker info` still reports `WARNING: DOCKER_INSECURE_NO_IPTABLES_RAW is set`; therefore the completed M2.06 smoke does not prove LAN inaccessibility of loopback-published ports. Production ingress/firewall policy is Not confirmed. M2.07 must treat the actual edge/firewall as the network boundary and keep database and queue services unpublished.

M2.07/#29 and M2.08/#30 are being implemented in parallel. Their worktrees are on `desktop/m2-07` and `desktop/m2-08`, branched from `afbc3eb`; coordinator documentation commit `e77ba09` has since been pushed to `desktop/milestone-m2`, so refresh each package branch onto the current milestone tip before opening its PR. M2.07 owns Compose profiles and install/update/stop/restore/release-lock documentation. M2.08 owns CI workflows/check scripts and local guide; preserve least privilege and the required `desktop-candidate` gate. Subagents implement/review/research only and do not run tests or validations. The coordinator runs each relevant validation gate once on each stable candidate SHA. Integrate one package at a time by squash and refresh the other branch against the new milestone tip before its PR is merged.

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

The Windows skips are specifically covered on Linux. Independent functional review, security review, and isolated validation all PASS on package head `e5c6f8ab744acaf6754bf267b74aa2021ffc6f94`; implementation is code commit `05a837d96593999b14d8fdf9c4292d95d2aa237e`, and the remaining package-head delta is documentation-only. Package PR #96 was squash-integrated as `398ab42cd00b4fc181f9c49e7b4eebd6e48f88a9` into `desktop/milestone-m2`. Keep #21 open until the consolidated PR is accepted in develop.

Non-blocking advisories and owners: direct clients can intentionally reuse a valid UUID v4 `X-Request-Id` and create ambiguous log grouping; M2.04 must resolve the trust/correlation policy before business routes. `ORIGIN_NOT_ALLOWED` currently represents a rejected Host although M1.07 defines it for Origin/Fetch Metadata; generic HTTP 500 currently uses retryable `DEPENDENCY_UNAVAILABLE`. M2.04 must align both with the error catalog/OpenAPI and update consumers/tests in the same reviewed contract scope. The request drain has no deadline and can wait until an external forced kill; M2.06/M2.07 must align handler duration limits and the container stop grace period. No M2.02 business route, Meta effect, production credential, migration, or staging operation is present or claimed.
## Environment and limits

See `progress.md`. Preserve user-installed dependencies and the existing stopped MariaDB container. Use named disposable Docker projects/volumes for package test services. GitHub Projects #12 is not exposed by the available connector. Never publish images or alter shared/production staging resources without their authorization and credentials.

## Resume protocol

Before resuming, read current remote heads, attached worktrees, package PRs/checks/reviews, and this report. Re-run checks affected by changed base/content. Continue at the first dependency-eligible package; do not repeat completed work.
