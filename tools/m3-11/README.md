# M3.11 legacy import preflight

This package adds a storage-neutral planner, a MariaDB batch/item/claim ledger for sanitized plans, and a CLI that still runs only against the checked-in synthetic fixture. The ledger is not a production importer: it records an `UNVERIFIED_METADATA_ONLY` candidate claim and its checkpoint, but never creates a trusted `ca_meta_assets` row, authorization, grant, relation, or credential. No legacy/customer database is connected, no credential value is read, and no Meta call is made.

## Synthetic dry-run

From the repository root:

```powershell
npm run build --workspace=@ca-meta/api
npm run legacy-import:dry-run --workspace=@ca-meta/api
npm run test:m3-11 --workspace=@ca-meta/api
```

The command defaults to dry-run and accepts only `tools/m3-11/fixtures/synthetic-inventory.json`. `--apply` is rejected. The report contains HMAC references, internal target IDs, counts, allowlisted state labels and reason codes; it omits source row IDs, provider IDs, credentials, message content, DSNs and database names. The CLI uses a fixed synthetic-only HMAC key and must never be used for operational data. The focused script runs the unit planner/runner fixture.

Focused tests (run by the milestone coordinator on the exact candidate SHA):

```powershell
Set-Location apps/api
npx tsc -p tsconfig.test.json
node --test dist-test/test/m3-11-legacy-import.spec.js
```

The persistent MariaDB fixture is part of the disposable M2.05 profile, which applies schema v15 and emits `artifacts/test-results/m3-11-legacy-import.junit.xml` plus LCOV:

```powershell
powershell -ExecutionPolicy Bypass -File tools/m2-05/run-mariadb-tests.ps1
```

## Current behavior

- A tenant is resolved only from the exact `(legacy_database_id, legacy_company_id, environment)` mapping. `IdDatabase` alone never identifies a tenant.
- One target app configuration must be bound by trusted server configuration. Missing or duplicate tenant/app mappings are quarantined.
- Facebook and WhatsApp rows can become metadata-only candidates in `CLAIMED`/unverified state. No grant, authorization, parent relation or credential is inferred.
- An Instagram source literal is quarantined because it does not distinguish Instagram Business from Creator.
- WhatsApp phone candidates require one same-tenant legacy WABA parent row. Missing, duplicate and cross-tenant parents are quarantined; the source relationship is not treated as provider verification.
- Rows with credential-presence markers require client reauthorization. Expiry `Never`, NULL and absent provider observations are `UNKNOWN`; malformed dates are `INVALID`.
- Duplicate target assets are quarantined as a group. External asset IDs stay strings and are not merged across tenant/app/environment contexts.
- Stable source-row HMACs are separate from row-payload HMACs. Schema v15 stores batches, per-sequence item hashes/checkpoints, and one unique metadata-only claim per source HMAC. Equal payload/context is idempotently replayed; changed payload or tenant/app target context is quarantined while preserving the first claim.
- The ledger does not store raw legacy row IDs, provider IDs, external IDs, credential values, or source payloads. It stores only source/payload HMACs, internal tenant/app/target references, a fixed kind, credential/expiry classifications and fixed state/reason values. The claim is explicitly unverified and is not a trusted asset or Meta authorization.
- GeneralSettings and wildcard notification rows are not read because their deployed schema and ownership remain **Not confirmed**.
- The planner and allowlisted read port are storage-neutral. The resumable runner's MariaDB adapter commits each candidate claim/item outcome and its checkpoint in one InnoDB transaction. The focused MariaDB fixture exercises interruption/resume, duplicate replay, changed-payload quarantine and absence of source identifiers/payload markers in persisted rows. The production source adapter, source DDL, live app/grant evidence, operator access and real import/apply operation remain **Not confirmed** and out of this scope.

Schema version 15 contains the legacy-import batches, items and metadata-only claims tables. This branch began from schema v13 while the M3.03 v14 change was being integrated separately; the coordinator must rebase v15 onto the accepted v14 migration and run the integrated schema 1–15 validation before candidate acceptance.

No source credentials, customer rows, production environment values or live database schema were read. The synthetic fixture is not evidence of legacy source parity, Meta grant eligibility, message capability, or production rollback.
