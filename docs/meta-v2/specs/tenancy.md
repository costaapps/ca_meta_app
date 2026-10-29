# SPEC — Tenant context and resource isolation

Status: proposed. Issues: [#11](https://github.com/costaapps/ca_meta_app/issues/11), [#14](https://github.com/costaapps/ca_meta_app/issues/14), [#15](https://github.com/costaapps/ca_meta_app/issues/15). Contracts: [domain model](../m1-05-domain-model.md), [identity](../identity-contract.md), [endpoint security crosswalk](../endpoint-security-crosswalk.md). Functional owner: data/DBA and security roles; people unassigned. Production DDL and Suite4 membership are **Not confirmed**.

## Problem and scope

Keep each authorization, connection, asset, job, event and projection within the tenant established by a verified session and membership. This spec defines query/write boundaries and the future legacy organization mapping; it does not claim the synthetic MariaDB schema is production DDL.

## Invariants

- Every tenant-scoped query includes server-resolved `tenant_id`; resource ID alone is never authorization.
- Membership is checked at request/job execution boundaries and context changes advance a server-owned context version. Browser values cannot select another tenant.
- Composite constraints carry tenant plus aggregate IDs, and app/environment where required. External IDs remain exact UTF-8 strings.
- Ambiguous assets/events are quarantined without last-login selection or multi-tenant fanout.
- A tenant label is display metadata only. Missing safe label disables context switch and tenant mutations until the session can identify the active business reliably.

## Contract and data

Canonical references are `m1-05-domain-model.md`, `m1-05-state-machines.md`, session/connection/asset routes in `contracts/openapi.yaml`, and `endpoint-security-crosswalk.csv`. Legacy `IdDatabase`/`IdCompany` to tenant mapping remains per `field-mapping.csv` and `schema-legacy.md`; real DDL, row ownership and write precedence must be proven before import.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| TEN-01 | Two businesses share a legacy database | Member lists or reads an asset | Only assets authorized for the session tenant are returned | M1.02 same-database fixture; M1.05 composite-FK PoC |
| TEN-02 | A valid resource ID belongs to another tenant | Caller requests or mutates it | Safe denial, zero side effect, no existence leak | M1.05/06 adversarial tests |
| TEN-03 | Browser tab has stale tenant context | It resumes an onboarding write | `CONTEXT_CHANGED`; no write until current session context is re-read | M1.06 harness; M1.08 fixture |

## Implementation, migration and recovery

Implement session-resolved context and scoped repositories before migrating records. Dry-run maps legacy keys and reports duplicates/orphans without writes; conflicts quarantine. During rollout there is one authorized writer per tenant/resource/field. Roll back by disabling only the affected cohort and reconciling checkpoints; never copy a record to another tenant to repair ambiguity. Production DDL, membership, and consumer ownership remain external gates.
