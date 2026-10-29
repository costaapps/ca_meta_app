# M2 progress

Base verified: `develop@2f0944d771ea7e98c520b20667586304e8bb9113` (2026-10-29).
Milestone branch: `desktop/milestone-m2`, initially created at that SHA.

| Package / issue | Stage | Candidate | Latest evidence | Package PR | Next action |
|---|---|---|---|---|---|
| M2.01 / #20 | Accepted in `desktop/milestone-m2` | source candidate `069b057721f4748bcae9ebfb92c621eaed5ad747`; PR head `957d00dfbf0113a41a5642282baf293532b29648` | PR #95 merged by squash as `45d32ca7f6b4ad004b52d6f675644139e17c10ca`. Checks: `desktop-candidate`, baseline, planning audit, and orchestrator success; structure skipped by workflow condition. Node 24.22.2/npm 11.19.1; clean install on unchanged lock; build 372.81 kB; 5/5 tests; typecheck/lint/bundle/routes PASS. Functional/security reviews PASS. | [#95](https://github.com/costaapps/ca_meta_app/pull/95), squash `45d32ca` | continue with M2.02; keep issue open until consolidated acceptance in develop |
| M2.02 / #21 | Local package candidate; awaiting independent functional/security reviews | source commit `301fee08bcb8c40453ce4b95c1cbf210a48da312` on `desktop/m2-02`, based on milestone SHA `930cfc0bc3627dfb5b50e4c104ddc65b496ef1e2` | Local source-snapshot evidence below; no package PR or push yet | none | principal to obtain reviews and run candidate checks, then prepare package PR to `desktop/milestone-m2`; keep issue open until consolidated acceptance in develop |
| M2.03 / #22 | Waiting on M2.02 | pending | M1.02/#11 and M1.05/#14 are included in develop | none | MariaDB migrations and recovery harness |
| M2.04 / #23 | Waiting on M2.02 | pending | M1.07/#17 is included in develop | none | canonical OpenAPI compatibility |
| M2.05 / #24 | Waiting on M2.03 | pending | M1.05/#14 and M1.09/#16 are included in develop | none | durable outbox/inbox/worker tests |
| M2.06 / #26 | Waiting on M2.04/#23 and M2.05/#24 | pending | dependencies not yet integrated | none | separate web/API images |
| M2.07 / #29 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | reproducible Compose profiles |
| M2.08 / #30 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | candidate CI |
| M2.09 / #33 | Waiting on M2.07/#29 and M2.08/#30 | pending | no Docker Hub publication authorized/configured | none | immutable release and rollback pipeline; distinguish local build from publication |
| M2.10 / #36 | Waiting on M2.09/#33 | pending | staging host, domain, DNS/TLS and authorized Meta resources Not confirmed | none | staging preparation; keep external gates open |

### M2.02 / #21 package evidence

The implementation source is commit `301fee08bcb8c40453ce4b95c1cbf210a48da312`. The evidence below was run on that source tree in the M2.02 worktree; the follow-up edit to this progress report records the results and does not change API/runtime files.

- Environment: Windows PowerShell, Node `v24.22.2` at the configured Codex runtime path, npm `11.19.1`, Docker Engine `28.3.0`, Compose `v2.38.1`.
- `npm ci`: exit 0; 639 packages added, 643 audited. npm reported 40 lockfile advisories (1 low, 10 moderate, 26 high, 3 critical) and five install scripts awaiting explicit `allowScripts`. No audit fix was applied. `npm audit --workspace=@ca-meta/api --omit=dev`: exit 0, 0 production API advisories.
- `npm run build`: exit 0; Nest API build and Angular build succeeded, Angular initial bundle 372.81 kB.
- `npm run typecheck`: exit 0; strict API source/test typecheck and Angular `ngc --noEmit` succeeded.
- `npm test`: exit 0; API Node test runner 10/10 (including nested config checks), Angular 5/5.
- `npm run lint`: exit 0; web boundary checker inspected 16 files.
- `tools/m2-02/run-mariadb-readiness.ps1`: exit 0 under unique Compose project `m202-api-ready-abbee213002e44a28833d4b90671ff19`; invalid-config boot exited safely with field names only and no synthetic password marker. MariaDB readiness returned `200 {status:ok}` → `503 {status:unavailable}` while stopped; `/health` remained 200; after MariaDB health became `healthy`, readiness returned `200 {status:ok}`. Cleanup left 0 containers in the UUID project and preserved `db-migrations-mariadb-1` in `exited` state.
- `git diff --check` and staged diff whitespace check passed. `apps/api/dist-test/` is ignored; there are no generated test artifacts in the candidate.

The package intentionally has no identity/session, tenant, business, migration, worker, Docker image, or Meta integration. The API readiness probe checks only MariaDB; production credentials and deployment connectivity were not tested. The all-workspace npm audit counts above remain open for reviewer triage even though the API production dependency audit is clean. The HTTP path discrepancy in #21 is recorded in `decisions.md`; M2.04 consumers must follow canonical OpenAPI `/health` and `/ready` unless the contract is updated and reviewed.

## Environment

- Windows PowerShell checkout; GitHub connector is authenticated and reports push/admin access. `gh` CLI is not installed.
- Git identity is the configured user identity. Node 22.17.0 remains installed; the official Node 24.22.2 runtime is available at `C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2` with npm 11.19.1. Its official archive SHA-256 was verified as `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- Docker Engine 28.3.0 and Compose v2.38.1 are available. A pre-existing stopped container `db-migrations-mariadb-1` is preserved.
- Existing `node_modules` in the shared checkout is preserved; clean installs run in isolated package worktrees.
- GitHub Projects #12 operations are unavailable in the installed connector; this report and issue/PR records remain the tracking evidence.

## Acceptance boundaries

M1 is integrated at `develop@2f0944d` via merged consolidated PR #94. This permits M2 implementation; M1's external Meta, Suite4, deployment and production gates remain Not confirmed. M2.09 publication and M2.10 real staging checks are not complete without the respective external permissions and evidence.
