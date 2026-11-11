# ADR-021 — M5.08 tenant-safe legacy metadata projection

## Status

Accepted for the synthetic local slice. Production destination DDL, catalog provisioning, mapping evidence, credentials, consumer behavior and deployed equivalence are **Not confirmed**.

## Context

Issue #63 requires durable replication of central metadata through the existing outbox, with idempotency, ordering, tenant/company isolation, recoverable destination outage, tombstone and rebuild behavior. `OutboxService` already persists its event and `OUTBOX_DELIVER` job in the caller transaction. The canonical outbox v1 envelope is strict and its existing event payloads contain opaque references. The worktree contains no confirmed enterprise schema or production destination registry. The event envelope, job schema and `OUTBOX_DELIVER` ambiguity policy are not changed.

## Decision

1. Keep outbox event and destination projection separate. The normal `JobsModule` composition gives `OutboxService` a `PROJECTION_RECONCILE` scheduler that adds only `{projectionRef, sourceVersion}` through the same database manager and transaction as the event and delivery job. No projection handler/runtime is registered by this package. When supplied by a separately reviewed runtime, the handler must re-read the stored event under its tenant and load a current central snapshot before projecting. Old event payloads never supply destination IDs, rows, DSNs or secrets.
2. Resolve a target only through a preconstructed allowlist entry matched by the exact `(legacyDatabaseId, legacyCompanyId, environment)` tuple. No request or event field can create or select a connection. Missing catalog entries fail closed.
3. Project a strict metadata-only DTO: asset/config reference, legacy opaque reference, external/display metadata, limited capability labels, version/state and tombstone. Config message text, credentials, tokens, provider raw payload and DSN are excluded by the DTO and SQL selection.
4. Store a central checkpoint keyed by `(tenant, hash(full destination tuple), central resource reference)`. Version/hash comparisons fence stale and conflicting destination writes. Commit each destination-local batch transaction separately, then advance central checkpoints. A failed/ambiguous destination remains retryable; duplicate writes are safe by version/hash.
5. Rebuild by replaying a trusted current-state scan through the same idempotent adapter, then reconcile only rows inside the exact mapped `(legacyDatabaseId, legacyCompanyId, environment)` scope. Report expected/actual counts and hashes. Tombstone a stale extra only when its `CentralAssetRef` is backed by a checkpoint for the same tenant and destination; leave unknown extras untouched and report ambiguous/failed parity instead of claiming a match. Removed/revoked resources are explicit tombstones.
6. Do not configure a live worker runtime. `configuredLegacyProjectionRuntime()` stays empty until destination DDL, mapping, credentials and consumer contract are separately confirmed and reviewed. Provisional destination table names/columns exist only in the synthetic MariaDB fixture and are not created by the application migration.

## Consequences

The local harness demonstrates atomic queue intent in the caller transaction, per-company separation when database ID is shared, independent destination failure/retry, tenant-fenced source loading, allowlisted active grants versus revoked grants, missing parent mapping failure, current-snapshot version/tombstone behavior, and full rebuild ownership/count/hash reporting. It does not prove production table compatibility, a deployed legacy consumer, actual mappings/credentials, source event completeness, deployed PHP equivalence, production backlog behavior, or a live worker installation. These external gates remain **Not confirmed**.

The central checkpoint migration is numbered v22 only on the isolated candidate M5.05 base. The combined milestone order must be reindexed after M5.06 and other M5 packages are integrated; the intended final slot is v25 after #62 v21, #60 v22, #59 v23 and #61 v24. Do not apply this provisional version number to an already merged migration ledger.

## Rollback

Keep the default adapter absent. The application migration creates only the central checkpoint table. A rollback can remove the handler/composition and leave checkpoints for inspection; no target schema or external state is dropped. Removing the local migration from a ledger that has applied it requires the normal reviewed forward-migration process; do not rewrite a deployed checksum.
