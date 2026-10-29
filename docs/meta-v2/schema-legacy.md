# Legacy schema and tenant binding proposal (M1.02)

## Scope and evidence boundary

This is a **code-level schema inventory and migration proposal**, not a claim about a live database. It was prepared against the versioned PHP source present at milestone base 54787a9f18c1cb88ed881bb3a5dd207077b2facf on 2026-10-28. The relevant references are [meta_auth_helper.php](../../backend/meta_auth_helper.php#L101), [connect_facebook.php](../../backend/connect_facebook.php#L104), [connect_instagram.php](../../backend/connect_instagram.php#L102) and [connect_whatsapp.php](../../backend/connect_whatsapp.php#L169).

No production or business-database DDL, catalog access, sanitized snapshot, or approved read-only connection was supplied. Therefore physical column types, nullability, indexes, foreign keys, uniqueness, replication, and the actual distribution of rows are **Not confirmed**. Names below are fields referenced by versioned source, not a recovered schema definition. The baseline inventory is in [M1.01](../baseline/inventory.md).

Local-only backend/connect.php and backend/connect_old.php were not opened or used.

## Observed code contract and proposed mapping

| Versioned source object | Fields observed in code | Proposed destination / conversion |
|---|---|---|
| Company | CompanyUUID, IdDatabase, IdCompany | Resolve an authorized tenant to the composite (legacy_database_id, legacy_company_id). Treat CompanyUUID/company_uuid as an untrusted lookup input; it is not itself the tenant key. |
| Databases | IdDatabase, CompanyUUID | Observed in settings updates as a lookup path. Use only a server-side catalog/allowlist to reach the database. Never accept a DB name, DSN or credential from an HTTP request or event. |
| MetaConnectedPages | Id, IdDatabase, IdCompany, Type, ExternalId, ExternalName, ProfilePicture, UserAccessToken, PageAccessToken, ExpiresUserAccessTokenAt, ExpiresPageAccessTokenAt, ParentChannelId, ConnectedAt, PrivateWelcomeMessage, CommentPublicReply, CommentPrivateReply | Preserve the legacy row identity in a mapping record; scope every asset by tenant, app/environment/provider/kind and string external_asset_id. Convert ParentChannelId only to a parent verified within the same tenant. Map message configuration to a tenant-owned configuration projection. Credential columns require a separately authorized, encrypted credential migration; M1.02 neither reads nor copies their values. |
| MetaConnectedNumbers | Id, IdWaba, ExternalId, DisplayPhoneNumber, VerifiedName, QualityRating, ConnectedAt | Preserve row identity; map the phone asset to a tenant through a verified IdWaba parent in MetaConnectedPages. Keep provider values as observed metadata with source/version; do not infer physical meaning of QualityRating. |
| MetaAppReviewNotifications | Id, IdDatabase, IsRead, CreatedAt, PlatformType, OriginId, DestinationId; query also uses SELECT * | A tenant-scoped notification projection with an explicit allowlist and source mapping. The full physical column set is unknown because the endpoint returns SELECT *; unknown fields are not imported and must be inventoried/quarantined after authorized DDL review. |
| GeneralSettings | No reference found in the versioned PHP files reviewed | No current code consumer or field list is established. Do not infer columns or copy data. Add to the DDL and ownership inventory when an authorized schema source identifies its contract. |

The complete field-level disposition is in [field-mapping.csv](field-mapping.csv).

## Tenant and asset identity

A tenant map binds one new tenant_id to the complete legacy pair (IdDatabase, IdCompany). IdDatabase alone is insufficient: the same database can contain multiple companies. ExternalId is not a tenant key and must not merge those companies. Proposed mapping keys and required migration metadata are:

- Tenant origin: tenant_id plus (legacy_database_id, legacy_company_id), unique only after verified ownership evidence.
- Asset identity: (tenant_id, app_config_id, environment, provider, kind, external_asset_id).
- Legacy asset map: (tenant_id, source_table, legacy_row_id, source_version, projection_version), retaining the source row identifier without treating it as authorization. source_version is an approved source snapshot/watermark; projection_version identifies the reviewed target mapping. Both are generated migration metadata, not fields observed in legacy DDL.
- Child phone relation: (tenant_id, legacy_id_waba) resolves to a verified WhatsApp business account; unresolved or cross-tenant parents are quarantined.

If one legacy pair resolves to zero or multiple authorized tenants, quarantine it. Do not pick the most recently active/login company. If the same external ID appears under different companies, keep separate tenant candidates. If it collides within the same tenant and product kind, quarantine the whole collision group until ownership is resolved.

## Code-observed integrity risks

The synthetic classifier allowlists the `FACEBOOK`, `INSTAGRAM`, and `WHATSAPP` literals written to `MetaConnectedPages.Type` in the versioned PHP. `WHATSAPP_PHONE` is only a normalized synthetic kind for rows from the separate `MetaConnectedNumbers` table; it is not claimed as a legacy `Type` value. Physical column enum definitions and actual stored values remain **Not confirmed**.

1. MetaConnectedPages and MetaConnectedNumbers use INSERT ... ON DUPLICATE KEY UPDATE. The source does not reveal which physical unique key caused the conflict; a global ExternalId key could overwrite another company. Inspect actual index definitions before any upsert or backfill.
2. MetaConnectedNumbers rows inherit tenant scope through IdWaba; a missing or mismatched parent cannot be assigned from phone number alone.
3. The notifications query filters by IdDatabase and notification state, while the Company lookup returns IdCompany too. This code path does not constrain notifications by IdCompany and returns SELECT *. If multiple authorized companies share the database, tenant isolation and the exposed field set are Not confirmed. The future contract must identify notification ownership and use an allowlisted tenant-scoped query; unresolved rows go to quarantine.
4. The current source writes the literal Never into some expiry fields. That sentinel alone does not show whether a provider omitted a deadline, whether expiry is unknown, or whether a credential is valid.

## Ownership and sync direction proposal

During discovery, the current legacy PHP is the observed writer for the fields in field-mapping.csv; actual other writers and replication jobs are Not confirmed. Before a cutover, establish one writer per field/tenant phase. Proposed migration is one-way into the new central source after explicit authorization; a later compatibility projection is metadata-only by default and must not re-export secrets. Message settings remain tenant-owned and need an explicit conflict policy if a newer portal edit races with an older snapshot.

## Migration gate

Do not import data on the basis of this code-only proposal. Before a real migration, attach sanitized DDL and read-only catalog evidence for the central and business databases, map every physical column and actual unique index, resolve the notification owner, and run a separate operator-authorized dry-run against a read-only snapshot. The exact read-only sequence and limits are in [migration-read-only-plan.md](migration-read-only-plan.md). Current physical DDL, row counts, conflicts and production indexes remain **Not confirmed**.
