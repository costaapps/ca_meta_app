# M2 progress

Base verified: `develop@2f0944d771ea7e98c520b20667586304e8bb9113` (2026-10-29).
Milestone branch: `desktop/milestone-m2`, initially created at that SHA.

| Package / issue | Stage | Candidate | Latest evidence | Package PR | Next action |
|---|---|---|---|---|---|
| M2.01 / #20 | Accepted in `desktop/milestone-m2` | source candidate `069b057721f4748bcae9ebfb92c621eaed5ad747`; PR head `957d00dfbf0113a41a5642282baf293532b29648` | PR #95 merged by squash as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. Checks: `desktop-candidate`, baseline, planning audit, and orchestrator success; structure skipped by workflow condition. Node 24.22.2/npm 11.19.1; clean install on unchanged lock; build 372.81 kB; 5/5 tests; typecheck/lint/bundle/routes PASS. Functional/security reviews PASS. | [#95](https://github.com/costaapps/ca_meta_app/pull/95), squash `45d32ca` | continue with M2.02; keep issue open until consolidated acceptance in develop |
| M2.02 / #21 | Local package candidate; awaiting independent functional/security reviews | final source snapshot 419fe90c784370cbc72916924adbecfcff754d9c on desktop/m2-02 (runtime commit 4a3f60f5a79d0c648287b8974095aa61df10af36); based on milestone SHA 930cfc0bc3627dfb5b50e4c104ddc65b496ef1e2 | Windows clean install/build/typecheck/test/lint/web regression and MariaDB harness passed; Linux pinned runner ran 15/15 including live SIGTERM drain; detailed evidence below | none | principal to obtain independent functional/security review on the final source snapshot, then coordinate package PR; keep #21 open until consolidated acceptance in develop |
| M2.03 / #22 | Waiting on M2.02 | pending | M1.02/#11 and M1.05/#14 are included in develop | none | MariaDB migrations and recovery harness |
| M2.04 / #23 | Waiting on M2.02 | pending | M1.07/#17 is included in develop | none | canonical OpenAPI compatibility |
| M2.05 / #24 | Waiting on M2.03 | pending | M1.05/#14 and M1.09/#16 are included in develop | none | durable outbox/inbox/worker tests |
| M2.06 / #26 | Waiting on M2.04/#23 and M2.05/#24 | pending | dependencies not yet integrated | none | separate web/API images |
| M2.07 / #29 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | reproducible Compose profiles |
| M2.08 / #30 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | candidate CI |
| M2.09 / #33 | Waiting on M2.07/#29 and M2.08/#30 | pending | no Docker Hub publication authorized/configured | none | immutable release and rollback pipeline; distinguish local build from publication |
| M2.10 / #36 | Waiting on M2.09/#33 | pending | staging host, domain, DNS/TLS and authorized Meta resources Not confirmed | none | staging preparation; keep external gates open |

### M2.02 / #21 package evidence

Final source snapshot: 419fe90c784370cbc72916924adbecfcff754d9c on desktop/m2-02, based on milestone SHA 930cfc0bc3627dfb5b50e4c104ddc65b496ef1e2. Runtime and harness changes are in 4a3f60f5a79d0c648287b8974095aa61df10af36; 419fe90c784370cbc72916924adbecfcff754d9c changes only the README and Windows POSIX-signal skip wording. No package PR or push exists.

- Environment: Windows PowerShell, Node v24.22.2 at C:/Users/user/AppData/Local/Codex/runtimes/node-v24.22.2, npm 11.19.1, Docker Engine 28.3.0, Docker Compose v2.38.1-desktop.1.
- npm ci: exit 0; 639 packages added, 643 audited. npm reported 40 lockfile advisories (1 low, 10 moderate, 26 high, 3 critical) and five install scripts awaiting explicit allowScripts. No audit fix was applied. npm audit --workspace=@ca-meta/api --omit=dev: exit 0, 0 production API vulnerabilities.
- npm run build: exit 0; Nest API and Angular builds passed; Angular initial bundle 372.81 kB. Ran on runtime commit 4a3f60f5a79d0c648287b8974095aa61df10af36; the later 419fe90c784370cbc72916924adbecfcff754d9c change does not alter runtime/build inputs.
- npm run typecheck: exit 0; strict API source/test and Angular ngc checks passed on 4a3f60f5a79d0c648287b8974095aa61df10af36; runtime unchanged in 419fe90c784370cbc72916924adbecfcff754d9c.
- npm test: exit 0 on final source snapshot 419fe90c784370cbc72916924adbecfcff754d9c. API Node tests: 14 passed, 0 failed, 1 skipped on Windows because POSIX SIGTERM subprocess semantics run in the Linux harness. Angular tests: 5/5 passed.
- npm run lint: exit 0; web boundary checker inspected 16 source files. npm run smoke:routes: exit 0; /setup, /channels, and /templates deep links passed. npm run check:web-bundle: exit 0; four browser files passed the bundle scan. These static/web checks were run on 4a3f60f5a79d0c648287b8974095aa61df10af36; the following commit changes only API README and skip wording.
- tools/m2-02/run-mariadb-readiness.ps1: final exit 0 on runtime commit 4a3f60f5a79d0c648287b8974095aa61df10af36 using isolated Compose project m202-api-ready-0b22e63721534127a56ed3c463ce8bd3. Invalid configuration exited safely with field names only. /ready returned 200, then the exact OpenAPI Unavailable ErrorEnvelope with HTTP 503 during DB outage; /health stayed 200; MariaDB returned healthy and /ready recovered to 200. Successful shutdown was graceful. Cleanup left no container or network for the UUID project, removed that run's temporary directory, and preserved db-migrations-mariadb-1 in exited state. An earlier diagnostic run exposed a PowerShell StrictMode missing-property handling bug in the harness; it was corrected and the final UUID run passed. Sanitized logs from the failed diagnostic run remain at C:/Users/user/AppData/Local/Temp/m2-02-readiness-7a2fed3199f5473fbd4b9a085b16f4ec.
- tools/m2-02/run-sigterm-drain-linux.ps1: exit 0 on final source snapshot 419fe90c784370cbc72916924adbecfcff754d9c. It pins node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c; npm ci added 237 packages and audited 239 in the connected container, then test:api ran in a separate --network none container. All 15 API tests passed without skips, including SIGTERM with both Connection: close and keep-alive and full in-flight response body drain. The isolated API install reported two development dependency advisories (1 moderate, 1 high); no audit fix was applied.
- git diff --check and staged diff check passed. apps/api/dist-test and apps/api/dist are ignored build outputs; no generated artifacts are committed.

The package adds no identity/session, tenant, business, migration, worker, Docker image, or Meta integration. Readiness checks MariaDB only; production credentials and deployment connectivity were not tested. The all-workspace npm audit findings remain open for reviewer triage. The HTTP path discrepancy in #21 is recorded in decisions.md; M2.04 consumers must follow canonical OpenAPI /health and /ready unless the contract is updated and reviewed.

## Environment

- Windows PowerShell checkout; GitHub connector is authenticated and reports push/admin access. `gh` CLI is not installed.
- Git identity is the configured user identity. Node 22.17.0 remains installed; the official Node 24.22.2 runtime is available at `C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2` with npm 11.19.1. Its official archive SHA-256 was verified as `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- Docker Engine 28.3.0 and Compose v2.38.1 are available. A pre-existing stopped container `db-migrations-mariadb-1` is preserved.
- Existing `node_modules` in the shared checkout is preserved; clean installs run in isolated package worktrees.
- GitHub Projects #12 operations are unavailable in the installed connector; this report and issue/PR records remain the tracking evidence.

## Acceptance boundaries

M1 is integrated at `develop@2f0944d` via merged consolidated PR #94. This permits M2 implementation; M1's external Meta, Suite4, deployment and production gates remain Not confirmed. M2.09 publication and M2.10 real staging checks are not complete without the respective external permissions and evidence.
