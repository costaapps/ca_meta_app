# SPEC · delivery/compose-environments

Status: implemented; candidate validation pending. Issue: [M2.07 / #29](https://github.com/costaapps/ca_meta_app/issues/29). ADRs: [ADR-003 persistence/jobs](../adrs/ADR-003-persistence-jobs.md), [ADR-005 secrets/legacy](../adrs/ADR-005-secrets-legacy.md). Contract/version: [Compose release lock](../contracts/release-lock.md), v1. Functional owner: DevOps / delivery engineering (operator not assigned). Evidence SHA: pending package commit; the coordinator runs the harness on the stable milestone candidate.

## Problem and intended behavior

Provide an operator-declared web/API/worker Compose stack with a schema-migration gate. Development can build from lockfile and mount source; npm dependencies stay in the built dev image and are not shadowed by a named node_modules volume. Staging/production consume the same immutable image digests and external configuration. MariaDB-backed jobs remain durable across application-container recreation. Production database is managed/outside this Compose project; the local MariaDB exists only in the explicit dev/test override.

## Invariants and trust boundaries

- Web is the only service with a published host port. API, worker, migration and DB have no published ports.
- `edge` connects web to API, `internal` contains DB access and `outbound` provides egress for API/worker/migration provider calls. Egress firewall policy is **Not confirmed**.
- API and worker receive identical domain/database configuration and the same runtime DB secret reference. Their current runtime parser receives the password only after the entrypoint reads a Compose secret file; secret values are not in the Compose environment model or repository. API, worker and migration endpoint host/port/database come from the same `API_DATABASE_HOST/PORT/NAME` values; only account/password differ. The API healthcheck gates `/ready` with a `Host` header derived from the first allowlisted hostname.
- Migration receives a separate DB account/secret with database-scoped DDL grants. Its host/port/database are mapped from the same `API_DATABASE_HOST/PORT/NAME` endpoint used by API/worker. It is a one-off service. API/worker wait for `service_completed_successfully`, and deployment automation requires `up --force-recreate --exit-code-from migrate migrate` to succeed before promotion.
- Worker has no HTTP listener; the API-image HTTP healthcheck is disabled for worker. Process supervision/restart is separate from the HTTP readiness probe.
- DB and queue jobs are MariaDB durable tables; no queue broker was chosen. Named volumes are project-scoped and updates never delete volumes.
- Compose on one host is a SPOF. HA, egress firewall, external ingress/TLS, DNS, managed database, secret manager, backup policy and measured RPO/RTO are **Not confirmed**.

## Release-lock data

See [release-lock contract](../contracts/release-lock.md). Current image digests are unavailable because M2.09 has not published a release. The tracked lock file is a template and fails the promotion checker until filled. Exact schema-v3 compatibility is declared; wider N/N-1 support is not inferred.

## Verifiable scenarios

| ID | Given | When | Then | Evidence artifact |
|---|---|---|---|---|
| M2.07-AC01 | Docker/Compose and a fresh local project | Run the documented harness | The shared dev image is built from the lockfile before the first stack start; web/API/worker/migration/local DB start without a developer-installed Node runtime; source mounts and unique project resources are used | `tools/m2-07/run-compose-smoke.ps1` (coordinator execution pending) |
| M2.07-AC02 | Prod Compose files and protected config | Resolve/publish services | Only web publishes ingress; DB/fila are absent from prod and app containers have no host port mapping | Compose config smoke (pending) |
| M2.07-AC03 | One API release and environment | Start API and worker | Same validated domain/database config and runtime secret; shared DB endpoint for API/migration; readiness healthcheck and web `/api/ready` succeed; worker HTTP healthcheck is disabled | Compose model plus liveness/readiness ingress and worker inspect in harness (pending) |
| M2.07-AC04 | DB target unavailable to migration | Start API/worker through Compose dependency | One-off migration exits nonzero and neither service starts; operator does not reach promotion | Failure-gate scenario in harness (pending) |
| M2.07-AC05 | Version-3 schema and one queued synthetic job | Recreate API and worker; briefly restart local DB | Schema and queued row remain in the project DB volume; no update/rollback path deletes the volume | Persistence/restart scenario in harness (pending) |

## Rollout and recovery

Use the [Compose runbook](../../runbooks/compose-environments.md). Each package release lock ties immutable images, source SHA and schema. Apply migrations explicitly before promoting app images, confirm schema compatibility before rollback, and use a forward-fix or an isolated reviewed restore for incompatible DDL. Never use `down --volumes` for routine update, stop, restore or rollback. A restore does not undo external Meta effects.

## Validation and evidence

Required candidate command: `pwsh -NoProfile -File tools/m2-07/run-compose-smoke.ps1` on a shell with Docker Engine and Compose v2. It builds a Node 24.22.2 dev image from `package-lock.json`, uses MariaDB 11.8.8 by digest, generates only synthetic secrets, and cleans only its UUID Compose project/image tag/temp directory. This author did not execute it per coordinator instruction; exact environment, SHA and result remain pending. It does not certify production restore, registry provenance, DNS/TLS/firewall, provider permissions or HA.
