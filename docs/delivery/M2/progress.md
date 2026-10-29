# M2 progress

Base verified: `develop@2f0944d771ea7e98c520b20667586304e8bb9113` (2026-10-29).
Milestone branch: `desktop/milestone-m2`, initially created at that SHA.

| Package / issue | Stage | Candidate | Latest evidence | Package PR | Next action |
|---|---|---|---|---|---|
| M2.01 / #20 | Implementing | `desktop/m2-01` from `af941f29e1b0862f46f299eb08ae544d1af1f04a` | Baseline on Node 24.22.2/npm 11.19.1: clean `npm ci` PASS (501 packages; 46 inherited audit findings), `npm run build` PASS, `npm test -- --watch=false` PASS (2 files / 5 tests). | none | preserve Angular baseline in apps/web; candidate checks pending |
| M2.02 / #21 | Waiting on M2.01 | pending | M1.07/#17 is included in develop | none | implement Nest boundary and safe config |
| M2.03 / #22 | Waiting on M2.02 | pending | M1.02/#11 and M1.05/#14 are included in develop | none | MariaDB migrations and recovery harness |
| M2.04 / #23 | Waiting on M2.02 | pending | M1.07/#17 is included in develop | none | canonical OpenAPI compatibility |
| M2.05 / #24 | Waiting on M2.03 | pending | M1.05/#14 and M1.09/#16 are included in develop | none | durable outbox/inbox/worker tests |
| M2.06 / #26 | Waiting on M2.04/#23 and M2.05/#24 | pending | dependencies not yet integrated | none | separate web/API images |
| M2.07 / #29 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | reproducible Compose profiles |
| M2.08 / #30 | Waiting on M2.06/#26 | pending | dependencies not yet integrated | none | candidate CI |
| M2.09 / #33 | Waiting on M2.07/#29 and M2.08/#30 | pending | no Docker Hub publication authorized/configured | none | immutable release and rollback pipeline; distinguish local build from publication |
| M2.10 / #36 | Waiting on M2.09/#33 | pending | staging host, domain, DNS/TLS and authorized Meta resources Not confirmed | none | staging preparation; keep external gates open |

## Environment

- Windows PowerShell checkout; GitHub connector is authenticated and reports push/admin access. `gh` CLI is not installed.
- Git identity is the configured user identity. Node 22.17.0 remains installed; the official Node 24.22.2 runtime is available at `C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2` with npm 11.19.1. Its official archive SHA-256 was verified as `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`.
- Docker Engine 28.3.0 and Compose v2.38.1 are available. A pre-existing stopped container `db-migrations-mariadb-1` is preserved.
- Existing `node_modules` in the shared checkout is preserved; clean installs run in isolated package worktrees.
- GitHub Projects #12 operations are unavailable in the installed connector; this report and issue/PR records remain the tracking evidence.

## Acceptance boundaries

M1 is integrated at `develop@2f0944d` via merged consolidated PR #94. This permits M2 implementation; M1's external Meta, Suite4, deployment and production gates remain Not confirmed. M2.09 publication and M2.10 real staging checks are not complete without the respective external permissions and evidence.
