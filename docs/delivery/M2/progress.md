# M2 progress

Base verified: `develop@2f0944d771ea7e98c520b20667586304e8bb9113` (2026-10-29).
Milestone branch: `desktop/milestone-m2`, initially created at that SHA.

| Package / issue | Stage | Candidate | Latest evidence | Package PR | Next action |
|---|---|---|---|---|---|
| M2.01 / #20 | Accepted in `desktop/milestone-m2` | source candidate `069b057721f4748bcae9ebfb92c621eaed5ad747`; PR head `957d00dfbf0113a41a5642282baf293532b29648` | PR #95 merged by squash as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. Checks: `desktop-candidate`, baseline, planning audit, and orchestrator success; structure skipped by workflow condition. Node 24.22.2/npm 11.19.1; clean install on unchanged lock; build 372.81 kB; 5/5 tests; typecheck/lint/bundle/routes PASS. Functional/security reviews PASS. | [#95](https://github.com/costaapps/ca_meta_app/pull/95), squash `45d32ca` | continue with M2.02; keep issue open until consolidated acceptance in develop |
| M2.02 / #21 | Follow-up P1 request-drain fix committed locally; awaiting independent re-review | runtime/test candidate 5283cf85e015a67f430bb2ea8a7720da1fab7d91 on desktop/m2-02, parent 0812c20ba125071ee6351de7687a5302b83339bd | Clean-install, root checks, MariaDB harness, and isolated Linux shutdown suite recorded below; no push or PR | none | principal to review the updated branch head; keep #21 open until consolidated acceptance in develop |
| M2.03 / #22 | Waiting on M2.02 | pending | M1.02/#11 and M1.05/#14 are included in develop | none | MariaDB migrations and recovery harness |
| M2.04 / #23 | Waiting on M2.02 | pending | M1.07/#17 is included in develop | none | canonical OpenAPI compatibility |
| M2.05 / #24 | Waiting on M2.03 | pending | M1.05/#14 and M1.09/#16 are included in develop | none | durable outbox/inbox/worker tests |
| M2.06 / #26 | Waiting on M2.04/#23 and M2.05/#24 | pending | dependencies not yet integrated | none | separate web/API images |
| M2.07 / #29 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | reproducible Compose profiles |
| M2.08 / #30 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | candidate CI |
| M2.09 / #33 | Waiting on M2.07/#29 and M2.08/#30 | pending | no Docker Hub publication authorized/configured | none | immutable release and rollback pipeline; distinguish local build from publication |
| M2.10 / #36 | Waiting on M2.09/#33 | pending | staging host, domain, DNS/TLS and authorized Meta resources Not confirmed | none | staging preparation; keep external gates open |

### M2.02 / #21 package evidence

Runtime and test candidate commit: 5283cf85e015a67f430bb2ea8a7720da1fab7d91 on desktop/m2-02, based on 0812c20ba125071ee6351de7687a5302b83339bd. It follows the earlier M2.02 package candidate documented above. The security review finding was that response close could release a request lease while an async handler continued after a client abort. RequestDrain now tracks transport and handler completion independently; SIGTERM waits until a Promise resolves or the Observable cleanup explicitly acknowledges cancellation. The ack is rejected before signal.aborted. Tests also prove a response may finish before handler work, without releasing the lease. RxJS unsubscribe/finalize is not treated as work completion; Observable cleanup must explicitly acknowledge after cancellation.

The contract decision remains unchanged in OpenAPI: GET /health and /ready only. Both return HTTP 200 with {"status":"ok"} on success; /ready returns HTTP 503 with the canonical Unavailable ErrorEnvelope on DB failure. The exact requestId/code/action fields and the consumer gate for any aliases are recorded in decisions.md. No OpenAPI file was changed.

Environment: Windows PowerShell, explicit Node 24.22.2 at C:/Users/user/AppData/Local/Codex/runtimes/node-v24.22.2, npm 11.19.1. The clean-install and root checks ran against the complete working-tree snapshot later committed as 5283cf85e015a67f430bb2ea8a7720da1fab7d91; at execution time Git HEAD was its parent 0812c20ba125071ee6351de7687a5302b83339bd with those changes in the working tree. The exact evidence is:

- npm ci: exit 0; 639 packages added, 643 audited. npm reported 40 advisories (1 low, 10 moderate, 26 high, 3 critical), five install scripts awaiting allowScripts, and one TAR_ENTRY_ERROR lstat warning for node_modules/zod/v4; installation completed. No audit fix was applied.
- npm run build: exit 0 for API and Angular; initial Angular bundle 372.81 kB.
- npm run typecheck: exit 0 for API source/tests and Angular.
- npm test -- --watch=false: exit 0; API 14 passed, 0 failed, four POSIX SIGTERM subprocess cases explicitly skipped on Windows; Angular 5/5 passed. The workflow's appended flag did not break node --test.
- npm run lint: exit 0; web boundary scanner inspected 16 source files.
- npm run smoke:routes: exit 0 for /setup, /channels, and /templates.
- npm run check:web-bundle: exit 0; four browser files passed.
- npm audit --workspace=@ca-meta/api --omit=dev: exit 0; zero production API vulnerabilities.

The MariaDB integration harness ran after the runtime fix, using isolated Compose project m202-api-ready-a674e72b7dc3426aaa8df63cc52eddb9. It exited 0: invalid startup settings logged field names only; /ready returned 200, then the exact 503 Unavailable ErrorEnvelope during DB outage; /health stayed 200; MariaDB health became healthy and /ready recovered to 200. The harness removed only that UUID project's container/network/volumes and temporary log directory. Follow-up inspection found no project container, network, or volume. The unrelated db-migrations-mariadb-1 remained Exited (0) 3 months ago.

The Linux runner was updated only to print its synthetic run UUID and exact temporary volume names. It pins node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c, performs npm ci in a network-enabled container, then tests in a separate --network none container. Final run tools/m2-02/run-sigterm-drain-linux.ps1 exited 0: 18 passed, 0 failed, 0 skipped. It covered both Connection: close/keep-alive full response drain; client-aborted Promise handler; response-finished handler still running; and Observable unsubscribe with pre-abort ack rejected and post-cleanup ack accepted. Run UUID cc466ae24e434b31ab9dd222411339c5 used volumes m202-sigterm-root-cc466ae24e434b31ab9dd222411339c5 and m202-sigterm-api-cc466ae24e434b31ab9dd222411339c5; both were absent after cleanup. The isolated install audited 239 packages and reported two development advisories (1 moderate, 1 high); no audit fix was applied.

git diff --check and the staged/code-commit diff checks passed. apps/api/dist-test and other build outputs are ignored; no generated artifacts are tracked. No package push or PR exists. Independent re-review is still required on the final branch head. Do not treat the local evidence as deployment, production credential, migration, provider, or Meta verification.
## Environment

- Windows PowerShell checkout; GitHub connector is authenticated and reports push/admin access. `gh` CLI is not installed.
- Git identity is the configured user identity. Node 22.17.0 remains installed; the official Node 24.22.2 runtime is available at `C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2` with npm 11.19.1. Its official archive SHA-256 was verified as `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- Docker Engine 28.3.0 and Compose v2.38.1 are available. A pre-existing stopped container `db-migrations-mariadb-1` is preserved.
- Existing `node_modules` in the shared checkout is preserved; clean installs run in isolated package worktrees.
- GitHub Projects #12 operations are unavailable in the installed connector; this report and issue/PR records remain the tracking evidence.

## Acceptance boundaries

M1 is integrated at `develop@2f0944d` via merged consolidated PR #94. This permits M2 implementation; M1's external Meta, Suite4, deployment and production gates remain Not confirmed. M2.09 publication and M2.10 real staging checks are not complete without the respective external permissions and evidence.
