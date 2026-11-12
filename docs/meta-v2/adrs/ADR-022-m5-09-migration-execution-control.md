# ADR-022 — M5.09 migration execution control

Status: implementation candidate. Issue/spec: [#64](https://github.com/costaapps/ca_meta_app/issues/64), [migration execution control](../specs/migration-execution.md). Functional owner role: backend / data / DBA. The focused code candidate `dbd946758ee688890f66289b61247e07b979d827` passed the synthetic/MariaDB harness, API typecheck and diff-check; see the [delivery evidence](../../delivery/M5/M5.09.md). No production source was accessed.

## Context

M3.11 supplies a synthetic-only planner and a metadata-only, resumable ledger. M5.05–M5.08 provide central configuration, internal operations and legacy metadata projections, but deployed business DDL, source catalog grants, Suite4 identity, real consumer routing and Meta callback sharing are **Not confirmed**. Issue #64 calls for a real pilot, which cannot be represented by local fixtures.

## Decision

1. Keep M3.11's transactional item ledger as the authoritative batch checkpoint. Add an M5.09 manifest as sanitized provenance/aggregate reporting and mirror each committed checkpoint. Recovery resumes from M3.11 and repairs a lagging mirror; mismatched or ahead control state fails closed.
2. Store only a batch reference, keyed snapshot fingerprint, version strings, a constrained catalog alias, counts, state, version and timestamps. Never persist source row identifiers, raw source values, credential data or a DSN.
3. Track writer ownership by tenant/channel/consumer/function with versioned compare-and-swap transitions. Require both a complete drift reconciliation bound to the current source snapshot hash and a matched, read-only shadow report for the exact cohort before each owner switch. Immediately before the writer CAS, re-read the candidate through the repository's trusted read-only port and require its source version and snapshot hash to match the report; persist the evidence hashes on the writer row. Keep shadow reads behind a sanitized snapshot port that produces aggregate mismatch counts only.
4. Require current writer versions, verified compatibility routes and no unresolved external outcomes before cohort rollback. Rollback can recover a partially applied per-function cutover, provided every row is in a known `PREPARED`, `SHADOW_READ` or `CUTOVER` state and its current route is verified. It changes routing metadata only and never restores a credential/grant or claims external effects were reversed. If `CREDENTIAL_REFERENCE` previously belonged to legacy, keep it central during rollback so the old path cannot be reopened; other cut-over functions return to their previous owners and untouched functions remain on legacy.
5. Do not implement a webhook router in this package. If a later scoped change adds one, raw-body provider signature validation must precede routing, and its internal delivery envelope/ledger must be authenticated independently.
6. Keep all executable evidence synthetic. The optional MariaDB harness uses loopback only, a random empty schema and temporary least-privilege users, then removes only those generated resources. No production DDL or real pilot is part of this change.

## Consequences

- The local candidate demonstrates data/control-plane mechanics, not customer migration, provider authorization or end-to-end cutover. Issue #64 stays partially evidenced until externally authorized pilot evidence exists.
- The API exposes policy/repository classes only; no command enables production apply and no M5.09 runtime route is registered.
- The candidate re-read and control database CAS do not share a transaction. A candidate source can still change after the re-read and before the CAS; a future real adapter needs pinned-snapshot or version-CAS support to close that residual window.
- Migration numbering is provisional because #60 / M5.03 v22 is absent from this worktree. Current candidate sequence: #62 v21, #60 v22, #59 v23, #61 v24, #63 v25, #64 v26. The integrator must validate the complete final registry order and checksums before release.
- Meta's official webhook documentation was unavailable during discovery (rate limited); callback ownership/sharing is therefore **Not confirmed**. No behavior is inferred from that unavailable source.

## Revisit when

Revisit after an authorized data owner supplies confirmed source/catalog DDL and read-only access, M5.03 v22 is integrated, the final migration registry/checksums are validated, actual writers and webhook callback topology are inventoried, and product/security/operations approve a bounded pilot and rollback plan.
