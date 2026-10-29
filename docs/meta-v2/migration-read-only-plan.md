# Read-only legacy inspection and migration preflight

This is a plan for a later, explicitly authorized read-only inspection. It is **not an executable production command**, and M1.02 has not connected to any production or business database. Current host, catalog names, DSNs, credentials, DDL, and data are **Not confirmed**.

## Guardrails

- A migration operator resolves database connections from an internal allowlist/catalog. No HTTP parameter, browser value, webhook, or fixture may select a database name, host, DSN, username, or secret.
- Use a principal with catalog and row SELECT only; verify grants before the session. Do not run DDL, INSERT, UPDATE, DELETE, REPLACE, LOCK TABLES, provider calls, or export full rows.
- Read only schema/metadata and aggregate counts. Never select, log, hash, copy, or print token values, app secrets, DSNs, phone numbers, names, URLs, message text, raw notifications, or raw IDs.
- Use stable source snapshot/watermark and record source version, time and catalog reference in a restricted operations ledger. Keep only counts and approved hashes of non-secret, non-PII fields.
- Capture errors without query parameter values or row contents. Abort on missing tenant pair, ambiguous owner, unknown column, permission mismatch or changed schema.
- Never use a production write connection in the dry-run harness. The current Python harness accepts synthetic-only JSON and has zero database dependencies.

## Planned read sequence

1. **Confirm scope and access.** Obtain written authorization for the exact central/business catalogs and a snapshot time. Inspect effective database grants and confirm read-only. Resolve catalog references server-side.
2. **Inventory physical schema.** Query the database metadata catalog for columns, types, nullability, indexes and foreign keys for Company, Databases, MetaConnectedPages, MetaConnectedNumbers, GeneralSettings, and MetaAppReviewNotifications. Record DDL revision and compare to the fields in [field-mapping.csv](field-mapping.csv). Do not infer tables or columns from a guessed deployment.
3. **Check tenant map.** Aggregate by (IdDatabase, IdCompany) from the approved Company catalog. Confirm every proposed tenant pair is unique and authorized. Count companies per database. Do not emit CompanyUUID values.
4. **Check asset integrity.** Aggregate counts for missing owner pairs, duplicated (IdDatabase, IdCompany, Type, ExternalId), dangling ParentChannelId, dangling IdWaba, unknown Type, and parent rows with another tenant pair. Return counts/reason codes only. External ID values remain inside the restricted session.
5. **Check notification ownership.** Inventory all physical columns behind current SELECT *. Verify that every row can be bound to one tenant using approved ownership data. Because current PHP filters this table by IdDatabase only, quarantine rows whose owner is not independently provable; do not expose wildcard rows in reports.
6. **Check expiry and credential presence.** For expiry fields, count known parseable observations, explicit provider responses without a deadline, unknown/null, invalid values and legacy sentinels such as Never. Without provider evidence, classify Never as unknown. For credential columns, select only null/present booleans and aggregate counts scoped to internal tenant IDs; never select the value or produce an unkeyed hash.
7. **Check actual upsert indexes.** Compare catalog unique indexes to every ON DUPLICATE KEY UPDATE; flag any key that omits tenant context. Do not run an upsert to test the result.
8. **Produce a restricted dry-run report.** Include source snapshot/version, counts, conflict counts, quarantine counts, and hashes only for an approved non-secret/non-PII field allowlist. Do not include row-level identifiers or raw values in general logs. Review the report with the data owner and security reviewer.
9. **Reconcile before approval.** Resolve all tenant ambiguity and define a change watermark or snapshot delta strategy. Repeat read-only counts after reconciliation; record query text/version and reviewer sign-off. Real migration remains a separate authorized package and operation.

## Required output

A sanitized report records schema/catalog revision, query/tool versions, time window, total rows per table, duplicate/orphan/ambiguity counts, credential presence counts (never values), expiry classification counts and explicit not-confirmed items. It must not contain source records, credentials, contact details, message content, raw IDs, DSNs or database names.

## Stop conditions

Do not proceed to a real import if tenant ownership is ambiguous; if multiple companies share a database and only IdDatabase is available; if any physical column or unique key remains unexplained; if the notification owner is unknown; if token family/expiry evidence is missing; if data changes since the snapshot are not reconciled; or if the read-only privilege boundary cannot be verified.
