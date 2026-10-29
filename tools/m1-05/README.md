# M1.05 — Domain and tenant-isolation PoC

This disposable harness checks the proposed M1.05 domain relationships, state rules and tenant constraints using synthetic rows in MariaDB. It never connects to Meta, Suite4, PHP, production, or an enterprise database. Fixture strings and credential ciphertext are test markers, not grants or credentials. The Compose file publishes no database port; Docker Compose creates a private project network and a project-scoped volume.

## Fixed runtime

- Docker Desktop on Windows, Docker Engine 28.3.0 and Compose 2.38.1 at the author run.
- MariaDB `11.8.8` pinned by digest: `mariadb:11.8.8@sha256:d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf` (InnoDB).
- Node `24.22.2` and npm `11.19.1` pinned in the build image by digest `node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`.
- `mysql2` 3.24.6 pinned in `package-lock.json`; npm installs in the container with `npm ci`.
- The host Node 22.17.0/npm 10.9.2 is not used for the execution. Host lockfile generation completed with a non-fatal `EBADENGINE` warning because the project deliberately declares Node 24; actual runtime is the pinned Node 24 container.

## Run on Windows PowerShell

From any directory in the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\m1-05\run.ps1
```

The script makes one lowercase Compose project name with a fresh UUID, creates an ephemeral password in the child process environment, validates the Compose config, builds and runs the test container, then removes only that same project with `down --volumes --remove-orphans`. It restores any pre-existing `M105_DB_PASSWORD` value. Passwords are never written to tracked files or printed. Database host, port, user and schema are hard-coded to the private Compose service and checked before the harness opens a connection; tests verify invalid overrides are refused first.

Equivalent manual sequence when a caller needs to inspect the compose output:

```powershell
Set-Location .\tools\m1-05
$projectName = "m105-local-poc-$([guid]::NewGuid().ToString('N'))"
$hadPassword = Test-Path Env:M105_DB_PASSWORD
$previousPassword = $env:M105_DB_PASSWORD
$env:M105_DB_PASSWORD = [guid]::NewGuid().ToString('N')
$result = 1
try {
  docker compose --project-name $projectName up --build --abort-on-container-exit --exit-code-from poc
  $result = $LASTEXITCODE
}
finally {
  docker compose --project-name $projectName down --volumes --remove-orphans
  if ($hadPassword) { $env:M105_DB_PASSWORD = $previousPassword }
  else { Remove-Item Env:M105_DB_PASSWORD -ErrorAction SilentlyContinue }
}
if ($result -ne 0) { exit $result }
```

The manual sequence must reuse its generated `$projectName` for both commands. Prefer `run.ps1`, which also runs `docker compose config --quiet` and reports cleanup failure. No `ports:` mapping exists, so the test DB cannot accept host connections.

## What it asserts

`npm test` applies `sql/schema.sql` to a fresh InnoDB schema and runs 13 named cases:

- `AC01.single-waba`: one WABA and four phone assets; four consecutive initial onboards have separate authorization/credential records, while N3 reauth adds another linked authorization/credential without replacing the previous grant. An N1-scoped capability lookup returns only its own authorization/credential; the two N3 authorizations stay explicit candidates rather than choosing a global/latest token implicitly.
- `AC01.two-waba-reauth`: two WABAs with two numbers each; each WABA has a separate authorization/credential and reauth adds a third authorization/credential only for N13.
- `AC01.exact-external-id`: a long external ID remains byte-for-byte a string, above JavaScript's safe integer range.
- `AC02.composite-fk`: MariaDB rejects a tenant-A link to an authorization from tenant B using the composite FK.
- `AC02.tenant-query`: a tenant-B scoped lookup of tenant A's asset returns zero rows.
- `AC02.route-quarantine`: the same exact provider/app/environment/kind/external ID claimed by two tenants stays as evidence in each tenant; a routed item is quarantined with no tenant/asset and no fanout.
- `AC03.transitions-readiness`: CREATED through PROVISIONING to PARTIAL, then a tenant-bound recovery `SyncJob`, new step attempt and audit permit PARTIAL → PROVISIONING → policy-derived READY with version-conditional writes; skipped/direct transitions fail; CANCELLED/EXPIRED/FAILED branches are checked; unknown required capability yields PARTIAL while unrequested optional unknown does not block the declared policy.
- `AC03.independent-states`: asset, credential and subscription status remain independent and UNKNOWN when no provider observation exists.
- `AC04.selective-revoke-tombstone`: revoking one asset grant leaves other links intact; revoking N3's prior authorization and credential leaves its successor authorization/grant intact; a checkpoint tombstone at version 8 rejects a stale version 7 projection.
- `AC05.unknown-stale`: absent/stale observation stays UNKNOWN/STALE and `expires_at = NULL` is not interpreted as never expiring.
- `AC05.inbox-outbox-replay`: a batched inbox envelope routes each item independently; duplicate item key does not add delivery, status update preserves item identity, asset revision and outbox intent commit in one MariaDB transaction, and replaying one outbox idempotency key applies a synthetic local effect once.
- `AC05.monotonic-checkpoint`: checkpoint/tombstone versions remain monotonic.
- `AC05.audit-redaction`: only safe before/after values are persisted in the audit JSON.

Expected final marker: `M1.05 MariaDB domain harness PASS`, exit code 0, with summary counts `tenants=2 assets=12 authorizations=8 credentials=8 routed-items=3 outbox-events=1 meta-calls=0 production-writes=0`. A failing assertion exits nonzero; the run script still attempts isolated cleanup.

## Local run evidence

Executed 2026-10-28 in the Desktop Windows worktree `desktop/m1-05`, with starting/base SHA `5b11671f431fe75030c63c7a5ba52d36fcb95fa0` and package code edits present in the pre-commit working snapshot. Command: `./run.ps1` from `tools/m1-05`. Compose project `m105-local-poc-96bb81f7e32c44b4878c4d71e99ba163`; Compose exit code 0. Docker Engine 28.3.0 / Compose 2.38.1; harness image ran Node 24.22.2/npm 11.19.1; database reported `11.8.8-MariaDB-ubu2404`. All 13 named `AC01`–`AC05` cases passed and the expected summary counts were printed. The runner removed that run's containers, volume and network, and restored/removed the ephemeral password environment variable. This evidence is for the pre-commit code snapshot; the milestone coordinator independently reruns checks on the committed candidate SHA.

## Relation to the acceptance matrix

[`docs/meta-v2/m1-05-state-machines.md`](../../docs/meta-v2/m1-05-state-machines.md) maps each `M1.05.AC01`–`AC05` row to Given/When/Then and these executable markers. `docs/meta-v2/acceptance-matrix.csv` retains evidence status `PLANNED`; running this PoC is local evidence for the package, not a real Meta grant or final milestone acceptance.

## Limits and next gates

This schema is proposed and harness-only; it is not a production migration, legacy DDL finding, ORM compatibility result, security review or performance/retention certification. Local assertions do not verify real provider grants, eligibility, Coexistence rules, webhook signature behavior, target subscription, credential encryption/key custody or live API responses. Validate those by the exact authorized Meta/Suite4 scenarios before activation. Exact retention durations and physical data-erasure schedules remain M1.09/M2 decisions. Before M2, validate all tenant-scoped queries and controllers, model configuration ownership, write production migrations, and run the long-handler/worker lease heartbeat and fencing scenario identified as pending by ADR-003. No test calls a provider or writes to production.
