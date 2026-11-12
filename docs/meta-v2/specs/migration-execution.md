# M5.09 specification — migration execution control

Status: implementation candidate; synthetic policy and optional disposable MariaDB evidence are local only. Issue: [#64](https://github.com/costaapps/ca_meta_app/issues/64). Related work: [M3.11 legacy import](legacy-import.md), M5.05–M5.08 delivery records, and [ADR-022](../adrs/ADR-022-m5-09-migration-execution-control.md). Functional owner role: backend / data / DBA.

## Scope

Provide the control-plane primitives needed to prepare and observe an eventual authorized migration: a provenance manifest, aggregate before/after counts, restartable checkpoint mirroring, fixed-reason quarantine carried by M3.11, drift detection/reconciliation, one-writer assignments per cohort/function, a read-only shadow comparison contract, and guarded cohort rollback.

This candidate does not connect to a legacy/business database, select or provision an enterprise catalog, import credentials, create grants, register cutover adapters, route webhooks, or enable a pilot. `MIGRATION_EXECUTION_CONTROL_MIGRATION` adds only central control tables and is run only against a random local MariaDB schema by the optional harness. The API has no M5.09 HTTP/controller/runtime route.

## Provenance, counts, and recovery

- A manifest binds the M3.11 batch UUID, keyed snapshot fingerprint, source/projection versions, an operator-resolved catalog alias, plan counts and aggregate before counts. The alias is not a database/schema/DSN.
- Only aggregate counts for assets, templates, message configurations, relationships and credential references are stored/reported. After counts are immutable once recorded; report output contains no row IDs, external IDs, raw values or credentials.
- M3.11's batch/item ledger remains the checkpoint of record because each metadata-only claim or quarantine reason is committed atomically with its item sequence. M5.09 mirrors that checkpoint after commit. If a process stops between the ledgers, resume reads M3.11 and repairs the mirror; an ahead or incompatible mirror fails closed.
- Replaying a completed M3.11 plan is idempotent. The checked-in fixture and MariaDB test use synthetic records and an isolated schema only.
- M3.11 quarantines unsupported/ambiguous rows with a fixed reason code and checkpoints each reason. Quarantine does not silently convert an uncertain record into an asset or credential.

## Drift and cutover control

- Drift comparison accepts keyed source identity/payload fingerprints bound to baseline/current snapshot hashes and reports only added/changed/removed counts and those keyed references.
- Every current delta must be explicitly reconciled against the exact current snapshot hash before `switchMigrationWriter` can change an owner. A current shadow report must also be supplied for the same cohort; it must be read-only, matched, and its legacy snapshot hash must equal the reconciled current hash. Missing, mismatched, stale, malformed, unrelated or unresolved evidence is rejected. The writer row records the drift hash and candidate snapshot hash used for that transition. This is a local gate contract, not proof that a real source watermark is stable.
- The writer matrix scopes exactly one owner per tenant, channel family, consumer kind and function. Versioned compare-and-swap guards owner changes. Its table contains ownership, phase, drift snapshot hash and candidate shadow snapshot hash only; it stores no credentials or grants.
- Shadow-read ports expose only sanitized snapshots of keyed metadata/status/configuration/relationship fingerprints. There are no write, send, subscription or webhook delivery methods. Reports contain aggregate comparisons only.
- Cohort rollback requires the currently recorded version for every function, a verified route and zero unresolved external outcomes. It can recover a partial transition after interruption: rows already in `CUTOVER` return to their prior owner, while rows still in `PREPARED` or `SHADOW_READ` remain on legacy; all rows are marked rolled back. It changes route ownership/phase only; credential and grant actions are `NONE`. If the prior `CREDENTIAL_REFERENCE` owner was legacy, rollback keeps that function central to avoid reopening an old/revoked credential path. Provider effects remain unreconciled and need their own authorized operation.

## Webhook boundary

No webhook route or webhook-dispatch writer adapter is registered by this candidate. Callback sharing between legacy and central systems is **Not confirmed**. If an authorized follow-up implements ingress routing, it must validate the provider signature over the untouched raw request body before item parsing/routing and authenticate the internal envelope/ledger separately. A provider signature must not be reused as authentication for a modified internal payload. That future route must preserve the existing owner for each item until its delivery ledger and idempotency are verified.

## Acceptance evidence and limits

`apps/api/test/m5-09-migration-execution.spec.ts` exercises redaction, quarantine reason reporting, drift reconciliation, read-only shadow comparison, cutover blocks without matched current shadow evidence, writer matrix invariants, guarded partial rollback, replay and interruption/resume with a synthetic ledger. `apps/api/test/m5-09-migration-execution.integration.spec.ts` exercises persistence, checkpoint recovery, a writer CAS race, restart after a partial cutover, and safe cohort rollback in a disposable MariaDB database. Run commands and cleanup boundaries are in [`tools/m5-09/README.md`](../../../tools/m5-09/README.md).

These tests do not satisfy the real pilot, prove four Coexistence assets or other channel eligibility, establish enterprise DDL/catalog ownership, demonstrate real shadow parity, verify deployed PHP/Suite4 routing, prove Meta callback sharing, or show absence of duplicate external effects. Those issue #64 scenarios remain externally gated and **Not confirmed**. No production DDL, credential, grant, client data, provider call, message, subscription or real tenant write is authorized by this specification.
