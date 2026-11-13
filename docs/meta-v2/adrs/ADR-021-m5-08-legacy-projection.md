# ADR-021 — M5.08 tenant-safe legacy metadata projection

## Status

Accepted for the synthetic local slice. Production destination DDL, catalog provisioning, mapping evidence, credentials, consumer behavior and deployed equivalence are **Not confirmed**.

## Context

Issue #63 requires durable replication of central metadata through the existing outbox, with idempotency, ordering, tenant/company isolation, recoverable destination outage, tombstone and rebuild behavior. `OutboxService` already persists its event and `OUTBOX_DELIVER` job in the caller transaction. The canonical outbox v1 envelope is strict and its existing event payloads contain opaque references. The worktree contains no confirmed enterprise schema or production destination registry. The event envelope, job schema and `OUTBOX_DELIVER` ambiguity policy are not changed.

## Decision

1. Keep outbox event and destination projection separate. The normal `JobsModule` composition gives `OutboxService` a `PROJECTION_RECONCILE` scheduler that adds only `{projectionRef, sourceVersion}` through the same database manager and transaction as the event and delivery job. No projection handler/runtime is registered by this package. When supplied by a separately reviewed runtime, the handler must re-read the stored event under its tenant and load a current central snapshot before projecting. Old event payloads never supply destination IDs, rows, DSNs or secrets.
2. Resolve a target only through a preconstructed allowlist entry matched by the exact `(legacyDatabaseId, legacyCompanyId, environment)` tuple. No request or event field can create or select a connection. Missing catalog entries fail closed.
3. Project a strict metadata-only DTO: asset/config reference, legacy opaque reference, external/display metadata, limited capability labels, version/state and tombstone. Config message text, credentials, tokens, provider raw payload and DSN are excluded by the DTO and SQL selection.
4. Store a central checkpoint keyed by `(tenant, hash(full destination tuple), central resource reference)`. Version/hash comparisons fence stale and conflicting destination writes. Projection jobs use a stable tenant/resource `resourceScopeRef`, so separate events for the same resource cannot be claimed concurrently. A version conflict stays pending/retryable; each retry reloads the current tenant-owned snapshot and recalculates its checkpoint/destination version. Commit each destination-local batch transaction separately, then advance central checkpoints. Duplicate writes remain safe by version/hash.
5. Rebuild by replaying a trusted current-state scan through the same idempotent adapter, then reconcile only rows inside the exact mapped `(legacyDatabaseId, legacyCompanyId, environment)` scope. Recompute each actual hash from the projected destination columns, repair owned field/hash drift only when the trusted current version is not older, and derive expected/actual counts and hashes from the persisted fields after repair. Tombstone a stale extra only when its `CentralAssetRef` is backed by a checkpoint for the same tenant and destination; leave unknown extras untouched and report ambiguous/failed parity instead of claiming a match. Removed/revoked resources are explicit tombstones.
6. Do not configure a live worker runtime. `configuredLegacyProjectionRuntime()` stays empty until destination DDL, mapping, credentials and consumer contract are separately confirmed and reviewed. Provisional destination table names/columns exist only in the synthetic MariaDB fixture and are not created by the application migration.

## Consequences

The local harness demonstrates atomic queue intent in the caller transaction, same-resource job serialization, retry with a fresh source read after a version conflict, per-company separation when database ID is shared, independent destination failure/retry, tenant-fenced source loading, allowlisted active grants versus revoked grants, missing parent mapping failure, both active/revocation application orders, repair of field corruption with the old hash preserved, and full rebuild ownership/count/hash reporting. It does not prove production table compatibility, a deployed legacy consumer, actual mappings/credentials, source event completeness, deployed PHP equivalence, production backlog behavior, or a live worker installation. These external gates remain **Not confirmed**.

The central checkpoint migration is schema v25 after M5.06 v24 on milestone base `44ef7a4610bbaa1c3053ec0d73f66716edbc2a49`; preceding versions are #62 v21, #60 v22, #59 v23 and #61 v24. The registry and migration-unit fixture must keep this sequence contiguous. This migration creates only the central checkpoint table and does not alter enterprise destination schemas.

## Review findings and code-snapshot evidence

The independent review found two concrete correctness gaps: jobs for separate events of one tenant resource could race on the same checkpoint and lose a newer revocation, and rebuild parity could trust a stored `ContentHash` while projected columns had drifted. The fix serializes jobs by tenant/resource, keeps a version conflict retryable so the next attempt reloads the current source, and recomputes hashes from actual destination columns before repair or a `MATCHED` report. The synthetic MariaDB coverage exercises both active/revocation orders and corruption with the old hash retained.

Validation applies to functional code snapshot `047b0614be59531a5c0468cfd0d2160875e74c11` (the documentation changes recording this evidence are later and are not part of that tested code SHA). On Node `v24.22.2` and disposable MariaDB `11.8.8`, `npm run test:m5-08 --workspace=@ca-meta/api` passed 10/10 tests with no skips, including both MariaDB integration tests; `npm run typecheck --workspace=@ca-meta/api` and `git diff --check` passed. Commands and environment details are recorded in [`tools/m5-08/README.md`](../../../tools/m5-08/README.md). Destination runtime remains disabled. Production DDL/catalog, mappings, credentials, provider/deployed consumer behavior and PHP equivalence remain **Not confirmed**.

## Rollback

Keep the default adapter absent. The application migration creates only the central checkpoint table. A rollback can remove the handler/composition and leave checkpoints for inspection; no target schema or external state is dropped. Removing the local migration from a ledger that has applied it requires the normal reviewed forward-migration process; do not rewrite a deployed checksum.
