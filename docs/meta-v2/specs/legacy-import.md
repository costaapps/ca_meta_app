# M3.11 specification — legacy import preflight

Status: implementation candidate; synthetic planner and schema-v15 MariaDB ledger are implemented, exact-candidate review and final CI are pending. Issue: [#39](https://github.com/costaapps/ca_meta_app/issues/39). Related contract: [legacy schema](../schema-legacy.md), [read-only preflight](../migration-read-only-plan.md), and [ADR-005](../adrs/ADR-005-secrets-legacy.md). Functional owner role: backend / data / DBA.

## Scope

Prepare a bounded planner, sanitized report and resumable metadata-only ledger for a later, separately authorized import. This slice plans from a typed snapshot through a storage-neutral read port, resolves exact tenant/app bindings, classifies asset rows and emits a deterministic plan. The delivered CLI only reads the repository's synthetic fixture and runs in dry-run mode. The MariaDB adapter stores an unverified claim record and checkpoint; it does not create a trusted target asset or authorization.

The source database adapter, production credentials, source DDL, Meta grant verification, credential import, trusted asset writes, production rollback and production command are not implemented. The v15 ledger stores only sanitized batch/item metadata and unverified claims. It cannot confer provider verification or authorization. GeneralSettings and notification `SELECT *` are excluded because their deployed schema and ownership are **Not confirmed**.

## Input and trust boundary

- A source reader receives an operator-resolved catalog alias and snapshot version. It does not accept a database name, host, DSN, username or password from a request.
- The snapshot contract allows only a `MetaConnectedPages`/`MetaConnectedNumbers` allowlist. Raw `UserAccessToken` and `PageAccessToken` fields are rejected. The reader may return only credential-presence booleans and allowlisted expiry strings.
- Each row binds to exactly one `tenant_id` through `(legacy_database_id, legacy_company_id, environment)` and one server-owned app configuration. `IdDatabase`, `CompanyUUID`, external IDs, display names and row activity are not identity or authorization evidence.
- The report contains internal target references, counts, fixed state/reason labels and HMAC references. HMAC key material is supplied outside this repository in a future operational adapter. Raw legacy row IDs, provider IDs, messages, DSNs and credential values are excluded.
- Each internal item separates an HMAC of stable source-row identity from an HMAC of its allowlisted payload. The persistent ledger compares them across snapshots and also compares tenant/app/kind context; an unchanged claim is replayed idempotently and a changed payload/context is quarantined rather than overwriting the first claim.
- Schema v15 stores only those HMACs, batch/source-version metadata, internal tenant/app/target references, fixed kind/expiry/reauth classifications, and fixed state/reason labels. It does not store legacy row IDs, external/provider IDs, credential values, or raw source payloads.

## Classification and write boundary

- Facebook rows and WhatsApp business-account rows may become metadata-only asset claims. They carry no grant, authorization, credential or verified relationship.
- Instagram's legacy literal does not distinguish Business from Creator, so it is quarantined.
- Phone rows require one matching same-tenant WhatsApp parent row; a source pointer alone does not create a provider-verified relation.
- Missing/ambiguous tenant or app mappings, unsupported kinds, duplicates, orphan parents and cross-tenant parents are quarantined as complete conflict groups.
- `Never`, NULL and missing provider observations map to expiry `UNKNOWN`; malformed timestamps map to `INVALID`. Neither proves a credential is healthy.
- Credential columns are reduced to presence markers. A present credential is reported as requiring client reauthorization; it is not copied, hashed, resolved, encrypted or sent to the vault.
- The ledger adapter requires an active tenant and exact server-owned Meta app configuration before recording a claim. It does not write credentials, grants, authorization rows or trusted assets, so it cannot overwrite a newer reauthorization. A later separately authorized importer must add its own transactionally enforced credential/secret/reauthorization fence. Ledger rollback removes only an unverified claim created by that batch and cannot reverse Meta effects or revive a revoked credential.

## Evidence and limits

Synthetic tests are in `apps/api/test/m3-11-legacy-import.spec.ts`; MariaDB fixture coverage is in `apps/api/test/m3-11-legacy-import.integration.spec.ts`; the executable sample is `tools/m3-11/fixtures/synthetic-inventory.json`. Recommended commands are in [`tools/m3-11/README.md`](../../../tools/m3-11/README.md). The fixture demonstrates two companies in one legacy database, duplicate targets, unknown kind, missing mapping, cross-tenant/orphan WABA links, credential presence and unknown expiry. The MariaDB fixture demonstrates commit interruption/resume, idempotent source/payload replay and changed-payload quarantine without storing fixture identifiers or raw values.

Actual legacy DDL, catalog allowlists, read-only database access, source snapshot/watermark, grant/asset evidence, secret custody and production rollback are **Not confirmed**. Synthetic output is not source parity or provider capability proof. M5 owns execution against any authorized real source.
