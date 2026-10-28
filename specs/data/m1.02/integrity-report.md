# M1.02 — integrity and dry-run report

Status: static source review complete; database measurements **Not confirmed / not run**. Source snapshot: `6095a1990c89c39e3399c774b3a9aca6138af9a2` (the supplied base before this package's edits); package checks below ran against the deliverables in this worktree derived from that base. This base is not the final reviewed package head. The supervisor checkpoint/PR records final review provenance after its commit. This report contains no production row data, tenant UUIDs, credential values, or customer message content.

## Evidence and execution status

The worktree contains four versioned PHP files and Angular notification/channel consumers. The M1.01 package cites older revisions `2bc3beef9e7455dc0b16657214d53bdb0cf69840`, `3aef01f90163cde6602fdb638fb6a5c17acec2ea`, and `96231050488a3afcab5046d58460b966b93ab23a` as historical. They are not the source snapshot for this package. The supplied source/base revision above is the reference for static findings; this report does not claim a final reviewed HEAD or commit hash.

No database endpoint, authorized read-only account, sanitized central/company DDL, production snapshot, provider response capture, or operational writer/replication inventory was supplied. Therefore no query against live or staged business data was run. Missing evidence blocks measured counts, real index review, provider-specific deadline classification, and any import/cutover. It does not justify filling values with estimates.

| Check | Source-based result | Database result |
|---|---|---|
| `ExternalId` duplicates by `Type` and company | Composite comparison must include `IdDatabase`, `IdCompany`, and `Type`; re-use across distinct tenant pairs/types is not itself a collision. | Not confirmed; not measured. |
| Orphan/multiple WhatsApp number parents | `MetaConnectedNumbers.IdWaba` joins `MetaConnectedPages.Id`; integrity requires exactly one WABA parent in the same approved tenant. | Not confirmed; not measured. |
| `ParentChannelId` mismatch | Callback assigns the Facebook page row ID to discovered Instagram rows. Verify same tenant and Facebook type; source does not establish an FK. | Not confirmed; not measured. |
| Expiration values | Callback computes user expiry from `expires_in ?? 5184000`; page expiry is assigned the literal string `Never`. These are code facts, not proof of provider deadline semantics. | Counts of `Never`, null, malformed, or other values Not confirmed; not measured. |
| Missing credentials | Source inserts user/page token fields, but values and storage protection are not visible from SQL text. | Counts by token family Not confirmed; not measured. |
| Repeated credentials | Must compare protected keyed fingerprints in a restricted process; never report raw values. | Not confirmed; not measured. |
| `ON DUPLICATE KEY UPDATE` versus actual UNIQUE keys | Four statement occurrences across two SQL templates: page upserts in Facebook, Instagram, and WhatsApp callback paths, and one phone-number upsert. Triggering key cannot be identified from source. | Real unique keys, constraints, and index behavior Not confirmed; no `SHOW INDEX` evidence. |
| Central/company schema and replication | PHP issues table queries through bootstrap-provided PDO; no placement or replication mechanism is established. `GeneralSettings` has no checked-in consumer/writer in scanned runtime code. | Not confirmed; DDL, writers, direction, and owners absent. |

### Source risks requiring data/DDL confirmation

- `getNotifications` and `actionNotification` resolve `CompanyUUID` to `IdDatabase` only and query notifications by `IdDatabase`/notification ID, without `IdCompany` (`connect_whatsapp.php:623-635,667-673`). The Angular UI sends the company UUID but does not prove server-side membership. If companies share a database, tenant ownership is ambiguous; actual exposure depends on DDL and data and is **Not confirmed**.
- Facebook/Instagram/WhatsApp page upserts update `IdDatabase` on a duplicate-key path but not `IdCompany`; the unique key that triggers the update is **Not confirmed**. Do not assume this is safe for two companies sharing a database.
- `saveAutoReply` joins `Databases` on `IdDatabase` and filters by `CompanyUUID`, `ExternalId`, and type, without an explicit `IdCompany` predicate (`connect_whatsapp.php:563-595`). Its exact row cardinality and operational effect are **Not confirmed**.
- Phone-number upsert identity depends on an unknown unique key; the update set does not change `IdWaba`. A phone row with conflicting parents requires quarantine, not an implicit parent choice.
- `MetaAppReviewNotifications` is selected with `*`; the tracked UI consumes nine named fields. Additional physical columns cannot be mapped until sanitized DDL and all consumers are reviewed.

## Dry-run behavior contract

The companion [read-only query plan](read-only-query-plan.md) specifies a read-only snapshot, aggregate-only query results, and restricted fingerprint processing. A dry-run must be deterministic for one recorded source snapshot/watermark and report:

- source snapshot/watermark and mapping/projection contract versions;
- totals by source table, product/type, and classification;
- duplicate groups/excess rows by the full tenant/type identity;
- orphan, multiple-parent, mismatched-parent, unresolved tenant, and conflicting-source counts;
- counts of expiry evidence states (`KNOWN`, `NO_DEADLINE_RETURNED`, `UNKNOWN`) without claiming provider semantics that were not observed;
- missing-token counts by family and credential-repeat counts/fingerprints under the protected handling rule;
- quarantined rows represented by approved internal source-row IDs plus reason codes, never by token, OAuth code, DSN, database name, message body, or raw provider payload.

Dry-run must not write a marker, temp table, checkpoint, audit row, output file, or any business data. It must fail closed if read-only transaction mode cannot be verified, if a required table/column differs from the reviewed DDL, or if the source snapshot changes during measurement. Import is a separate authorized phase and is not specified as executable here.

The offline synthetic implementation is [`experiments/data/m1_02_dry_run.py`](../../../experiments/data/m1_02_dry_run.py), using [`m1_02_fixture.json`](../../../experiments/data/m1_02_fixture.json). It has no database connection or provider call and writes no files. The SQL query plan above remains a proposal and was not executed. Its first import gate is sanitized real DDL and index reconciliation against the source query templates and four observed upsert occurrences.

## Synthetic fixture matrix

The scenarios below are test inputs, not observed customer rows. They exercise the proposed mapping rule only; they do not validate database constraints or PHP runtime behavior.

| Fixture | Legacy pair | Tenant | Asset type / external ID | Expected result |
|---|---|---|---|---|
| F-A | `(DB-A, COMPANY-A)` | `TENANT-A` | `FACEBOOK / ASSET-7` | Importable only through explicit map A. |
| F-B | `(DB-A, COMPANY-B)` | `TENANT-B` | `FACEBOOK / ASSET-7` | Separate importable mapping; same `IdDatabase` and `ExternalId` cannot join A. |
| F-C | `(DB-B, COMPANY-C)` | `TENANT-C` | `FACEBOOK / ASSET-7` | Separate importable mapping; no cross-database merge. |
| F-D | `(DB-A, missing)` | ambiguous | `FACEBOOK / ASSET-7`, which exists for both A and B; a fixture-only login hint favors one candidate | Quarantined as `ambiguous_tenant_match`; the runner emits no selected tenant and does not inspect the hint. |
| F-E | `(DB-A, COMPANY-A)` | `TENANT-A` | Two source rows with the same complete `FACEBOOK / ASSET-DUPLICATE` key and opposing fixture-only login hints | Both rows quarantined as `duplicate_asset_key`; no row wins by recency. |

Expected partition: three independent asset mappings across three tenants, one duplicate-key group covering two rows, and one ambiguous incomplete-pair row. The fixture carries synthetic `legacy_company_uuid` aliases distinct from `tenant_id`; the runner resolves only from the complete database/company pair. Same-ID preservation is string-based. The executable fixture does not cover parent-row ambiguity; that remains a required production dry-run check after DDL and source data are authorized. It does not simulate PHP upsert behavior because the real unique indexes are unavailable.

## Credential report contract

An implementation of the report may read credential columns only in a least-privileged, access-controlled process. It computes a keyed HMAC fingerprint using a separately managed audit key, then emits only protected credential row IDs, per-run fingerprints, and aggregate counts. The HMAC key and credential values never enter logs, CSV, Markdown, shell output, or exported query results. Fingerprints are not authorization evidence and should be discarded/rotated under a documented retention rule. No such reporting implementation exists in this package, so its runtime behavior is **Not confirmed**; the contract is specified, not demonstrated against a database.

## Validation record

- Static review: the four tracked PHP sources were enumerated with `git ls-files 'backend/*.php'`; source columns, query use, writes, and four `ON DUPLICATE KEY UPDATE` occurrences were compared with `field-mapping.csv` and `schema-legacy.md`. The map now includes per-row file/line references. No DDL or real index was observed.
- Synthetic dry-run: `python3 experiments/data/m1_02_dry_run.py` — passed. It reported three tenants, two legacy database IDs, one database shared by two company pairs, three mapped assets across three tenants, one duplicate asset-key group, three quarantined rows (two duplicate-key rows and one ambiguous tenant match), and expiry counts `KNOWN=1`, `NO_DEADLINE_RETURNED=1`, `UNKNOWN=4`. The output states `writes_performed=false` and `provider_calls_performed=false`.
- Offline tests: `python3 -m unittest discover -s experiments/data -p 'test_m1_02*.py' -v` — 8 tests passed. They assert same-database company isolation, distinct database mapping, duplicate/ambiguous quarantine without choosing a tenant, expiry classification including literal `Never`, no external effects, all 45 mapping rows and six contract fields, all 81 line references, required artifact presence/whitespace, and no token-shaped or UUID-shaped values in the deliverables.
- Syntax: `python3 -m py_compile experiments/data/m1_02_dry_run.py experiments/data/test_m1_02_dry_run.py` — passed.
- Source traceability: the offline test parsed the nine-column CSV, confirmed all six contract fields, and resolved all 81 cited source line references. The artifact test found all seven deliverables with no trailing whitespace.
- PHP runtime, MariaDB/MySQL integration, real DDL/index reconciliation, production/staging access, and current Meta payload semantics: not executed / **Not confirmed**. Official Meta developer documentation search returned no results and direct opens were inaccessible or HTTP 429; see the companion query plan. No current provider rule is inferred from those failed requests.
