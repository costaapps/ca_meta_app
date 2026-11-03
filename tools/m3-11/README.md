# M3.11 legacy import preflight

This package adds a storage-neutral planner for a future authorized import and a CLI that runs only against the checked-in synthetic fixture. It does not connect to a legacy or customer database, read credential values, call Meta, or write target rows.

## Synthetic dry-run

From the repository root:

```powershell
npm run build --workspace=@ca-meta/api
npm run legacy-import:dry-run --workspace=@ca-meta/api
```

The command defaults to dry-run and accepts only `tools/m3-11/fixtures/synthetic-inventory.json`. `--apply` is rejected. The report contains HMAC references, internal target IDs, counts, allowlisted state labels and reason codes; it omits source row IDs, provider IDs, credentials, message content, DSNs and database names. The CLI uses a fixed synthetic-only HMAC key and must never be used for operational data.

Focused tests (run by the milestone coordinator on the exact candidate SHA):

```powershell
Set-Location apps/api
npx tsc -p tsconfig.test.json
node --test dist-test/test/m3-11-legacy-import.spec.js
```

## Current behavior

- A tenant is resolved only from the exact `(legacy_database_id, legacy_company_id, environment)` mapping. `IdDatabase` alone never identifies a tenant.
- One target app configuration must be bound by trusted server configuration. Missing or duplicate tenant/app mappings are quarantined.
- Facebook and WhatsApp rows can become metadata-only candidates in `CLAIMED`/unverified state. No grant, authorization, parent relation or credential is inferred.
- An Instagram source literal is quarantined because it does not distinguish Instagram Business from Creator.
- WhatsApp phone candidates require one same-tenant legacy WABA parent row. Missing, duplicate and cross-tenant parents are quarantined; the source relationship is not treated as provider verification.
- Rows with credential-presence markers require client reauthorization. Expiry `Never`, NULL and absent provider observations are `UNKNOWN`; malformed dates are `INVALID`.
- Duplicate target assets are quarantined as a group. External asset IDs stay strings and are not merged across tenant/app/environment contexts.
- Stable source-row HMACs are separate from row-payload HMACs. A future ledger can detect changed legacy rows and quarantine them rather than replacing a prior projection.
- GeneralSettings and wildcard notification rows are not read because their deployed schema and ownership remain **Not confirmed**.
- The planner and allowlisted read port are storage-neutral. The resumable runner requires one target-and-ledger adapter to atomically commit each metadata-only claim with its checkpoint; a synthetic in-memory adapter exercises interruption/resume in unit tests. The production database source, persistent ledger implementation, storage transaction and real apply mode remain gated on authorized source DDL, app/grant evidence, operator access and the follow-up schema migration. Those external items remain **Not confirmed**.

No source credentials, customer rows, production environment values or live database schema were read. The synthetic fixture is not evidence of legacy source parity, Meta grant eligibility, message capability, or production rollback.
