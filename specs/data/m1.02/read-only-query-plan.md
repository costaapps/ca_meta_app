# M1.02 — read-only integrity query plan

Status: proposed plan; **not executed**. Source snapshot: `6095a1990c89c39e3399c774b3a9aca6138af9a2` (provided base before package edits). This plan does not authorize access to production or supply executable connection details.

## Preconditions and safe selection

1. Obtain sanitized, versioned DDL and index definitions for `Company`, `Database`/`Databases`, `MetaConnectedPages`, `MetaConnectedNumbers`, `GeneralSettings`, and `MetaAppReviewNotifications` in central and company stores. Confirm server/version, table/column types, keys, collation, timezone, and actual table names. Source SQL currently names `Databases` (plural); do not assume it equals `Database`.
2. Obtain an approved internal catalog entry and a least-privileged read-only identity from the responsible DBA. Resolve the tenant map from the authorized internal catalog using the complete `(source_system, environment, legacy_database_id, legacy_company_id)` tuple. This repository does not contain that operational catalog.
3. Never accept a database name, schema name, host, DSN, credential, tenant mapping, or arbitrary SQL identifier from HTTP, browser storage, webhook/event payload, or CLI argument. Bind values as parameters. Table/column identifiers are fixed reviewed source, not request data.
4. Use a read-only transaction and a consistent snapshot supported by the confirmed engine. Verify read-only mode before querying; abort on any write-capable fallback. Do not create temporary tables, write checkpoints, use `INTO OUTFILE`, or emit raw rows. Run only after backup/operational approval where required.
5. First query metadata only (`SHOW CREATE TABLE`, `SHOW INDEX`, or engine-equivalent) in the authorized environment. Sanitize names/values as policy requires. Compare actual unique indexes against all four upsert statements before interpreting duplicate behavior. If source and reviewed DDL disagree, stop and revise this plan.

## Query sequence

The SQL below is a review template for MySQL/MariaDB-style syntax observed in PDO source. It must be adjusted only after DDL/version confirmation. Use bound parameters for any selected scope. Each result returns aggregate counts only; do not include grouping keys, raw external IDs, message text, token columns, DSNs, or database names in result sets.

### A. Establish mapping cardinality

After confirming column types and table names, calculate aggregate counts for:

```sql
SELECT COUNT(*) AS duplicate_company_uuid_groups
FROM (
  SELECT CompanyUUID
  FROM Company
  GROUP BY CompanyUUID
  HAVING COUNT(*) > 1
) AS d;
```

Compare `Company` and `Databases` pair resolution in a restricted query that returns only totals for missing or mismatching pairs. Preserve `CompanyUUID` only as a restricted legacy alias attached after the full pair is authorized; compare the `Databases.CompanyUUID` value as a consistency check. Do not print UUIDs or IDs. The tenant map is valid only when a complete legacy pair resolves to exactly one authorized tenant. Two companies sharing `IdDatabase` remain different mapping keys.

### B. Duplicate external assets

For `MetaConnectedPages`, group by `IdDatabase`, `IdCompany`, `Type`, and `ExternalId`; for numbers derive the company pair from exactly one valid WABA parent and group by that pair plus the number type and `ExternalId`. Return only duplicate-group count and excess-row count:

```sql
SELECT COUNT(*) AS duplicate_groups,
       COALESCE(SUM(row_count - 1), 0) AS excess_rows
FROM (
  SELECT COUNT(*) AS row_count
  FROM MetaConnectedPages
  GROUP BY IdDatabase, IdCompany, `Type`, ExternalId
  HAVING COUNT(*) > 1
) AS duplicates;
```

Also count external IDs repeated across different complete tenant/type keys as informational reuse, not as a global uniqueness violation. Do not emit the external IDs. Apply the same rule to number IDs after resolving their parent; no grouping by `ExternalId` alone may drive ownership.

### C. Child and parent integrity

With actual DDL confirmed, aggregate counts for:

- numbers with no `MetaConnectedPages.Id = IdWaba` parent;
- numbers with more than one candidate parent, if the actual join permits it;
- numbers whose parent type is not `WHATSAPP` or whose approved tenant pair differs;
- Instagram pages whose non-null `ParentChannelId` is missing, not a `FACEBOOK` page, or has a different `(IdDatabase, IdCompany)` pair;
- notification rows whose `IdDatabase` maps to zero or multiple authorized companies, and notifications whose destination cannot resolve to one tenant-scoped asset.

Return aggregate counts and protected internal row references only for separately authorized quarantine review. Do not auto-repair, assign to the most recent login, or use `ConnectedAt` as a conflict resolver.

### D. Expiry and missing-token counts

Only after DDL confirms these columns can hold/compare the observed legacy representations, count null/empty token fields and exact legacy `Never` sentinels without selecting their contents. Treat the code's `5184000` fallback timestamp and literal `Never` as source-origin ambiguity. Preserve raw evidence in protected processing and count normalized evidence states separately. A stored date alone does not prove that Meta returned it.

Provider-specific classification requires a successfully captured, versioned response contract for the relevant token family. A successfully observed response with a confirmed deadline maps to `KNOWN`; a confirmed response with no applicable deadline maps to `NO_DEADLINE_RETURNED`; missing, unavailable, unparseable, or provenance-free evidence maps to `UNKNOWN`. Do not query or call Meta as part of this read-only database plan.

### E. Repeated credential detection

Do not issue an ordinary SQL result containing token values or an unkeyed token hash. A separately reviewed restricted process may stream only the required credential columns and row IDs from a read-only cursor, compute a keyed HMAC fingerprint in process, and emit protected internal IDs, a per-run fingerprint, and duplicate counts. Suppress raw driver values from logs/errors/traces and discard buffers after comparison. If this handling cannot be guaranteed, skip this check and report it blocked; never substitute token output or plain hashes.

### F. Dry-run summary

Aggregate the results by table/type/status and include the snapshot/watermark, query-plan version, source DDL fingerprint, and mapping/projection versions. No write, DDL, migration, temporary table, staging copy, or external provider request is part of dry-run. A proposed import may start only from an explicitly approved later phase and must use a checkpointed, tenant-safe transaction at its destination.

## Offline synthetic experiment

The companion [`m1_02_dry_run.py`](../../../experiments/data/m1_02_dry_run.py) consumes only [`m1_02_fixture.json`](../../../experiments/data/m1_02_fixture.json). It does not connect to a database, call a provider, or write files. It exercises the proposed algorithm with two companies sharing `DB-A`, a third company in `DB-B`, the same synthetic provider ID across all three tenant keys, duplicate rows inside one complete key, an incoming asset with an incomplete company pair, and expiry evidence cases. `fixture_only_login_hint` exists only to show that recency is ignored; it is not a legacy column or migration field.

Run the synthetic experiment and its offline tests from the repository root:

```bash
python3 experiments/data/m1_02_dry_run.py
python3 -m unittest discover -s experiments/data -p 'test_m1_02*.py' -v
```

The runner validates expected counts and prints only synthetic aggregate counts and synthetic internal fixture row IDs with quarantine reason codes. A passing run proves this decision logic for the fixture only. It is not database evidence, DDL reconciliation, provider evidence, or authorization to migrate.

## Validation and external source status

No database command was run for this plan: no authorized read-only connection, operational DDL, or snapshot was supplied. No SQL text above is claimed to have executed or to match production types/indexes. The real unique-index comparison against four upsert statements and all data counts remain **Not confirmed**.

On 2026-10-28, current primary Meta documentation was requested from the official [access-token debugging and error-handling guide](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/debugging-and-error-handling/), [Graph API `debug_token` reference](https://developers.facebook.com/docs/graph-api/reference/debug_token/), [access-token guide](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/), and [WhatsApp Cloud API getting-started guide](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started). Search returned no results; direct opens returned inaccessible-page errors, including HTTP 429. Therefore current Meta field names and the meaning of an omitted/no-expiry value are **Not confirmed**. The three-state classification above is a safe internal evidence model, not a claim about a current Meta response contract. Verify the provider contract and app/token-family behavior before importing or acting on any credential.
