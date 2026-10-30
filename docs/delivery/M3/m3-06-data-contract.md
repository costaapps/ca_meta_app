# M3.06 — authorization, asset and grant persistence

## Delivered contract

META_ASSETS_MIGRATION in apps/api/src/database/migrations/meta-assets.ts is schema version 7 (202610300005-meta-assets-grants-relations), following M3.04 v5 and M3.02 v6. The migration is additive and restartable through the M2.03 migration ledger. It creates authorization, secret-free credential metadata, confirmed scopes, asset-authorization links, asset grants, typed relations, append-only history, verified global identity claims and tenant-local quarantine records. It also adds a composite tenant/app/environment key to the existing assets table.

MetaAssetsModule.register(environment) is defined in apps/api/src/meta-assets/meta-assets.module.ts. It imports and re-exports JobsModule. The root API module registers MetaAssetsModule once and removes its direct JobsModule registration, avoiding a second durable-work database/outbox pool. The module exports META_ASSETS_REPOSITORY.

Integration wiring:

1. Import META_ASSETS_MIGRATION and META_ASSETS_TABLES from apps/api/src/database/migrations/meta-assets.js.
2. The M3.06 package appends META_ASSETS_MIGRATION after M3.04 v5 and M3.02 v6 in migrationsWithoutChecksums. M3.06 owns schema v7; after M3.03 and M3.07 are integrated, the current sequence is versions 1–9 (M3.03 v8, M3.07 v9).
3. Include ...META_ASSETS_TABLES in DOMAIN_TABLES.
4. Replace the root JobsModule.register(environment) with MetaAssetsModule.register(environment) (it re-exports JobsModule) and import MetaAssetsModule from ./meta-assets/meta-assets.module.js.
5. M3.07 appends META_CREDENTIAL_VAULT_MIGRATION as schema v9 after M3.03 v8, and includes ...META_CREDENTIAL_VAULT_TABLES in DOMAIN_TABLES.
6. Preserve the M3.04 session provider/migration and M3.02 retry migration/version checksums.

Historical note: the M3.06 preparation branch predated v5/v6; the current integrated registry preserves M3.04 v5, M3.02 v6, M3.06 v7, M3.03 v8 and M3.07 v9 in order. Do not use the historical preparation sequence [1, 2, 3, 4, 7].

## Tenant and evidence rules

- All Meta external identifiers remain opaque strings (VARCHAR, up to 512 characters); leading zeroes and values above JavaScript's safe integer range are preserved.
- Persisted asset kinds are allowlisted to `WHATSAPP_PHONE_NUMBER`, `WHATSAPP_BUSINESS_ACCOUNT`, `INSTAGRAM_BUSINESS_ACCOUNT`, `INSTAGRAM_CREATOR_ACCOUNT` and `FACEBOOK_PAGE`; unknown kinds are rejected until a versioned extension contract defines their storage and retention.
- The asset table's natural key remains tenant + app configuration + environment + provider + kind + external ID. Reauthorization reuses the same tenant asset row and preserves its internal ID.
- display_name is a local display field and is never overwritten by this provider upsert. Confirmed provider names update external_name.
- Browser claims create a CLAIMED relation and cannot write granted scopes, asset grants, typed relations, provider authorization IDs or a verified global ownership claim. Existing confirmed scopes and authorization state are preserved on a browser-only observation.
- An omitted asset `grants` field preserves that authorization's current grants; an explicit empty list revokes all of them. Asset history snapshots record the effective grant set after the update.
- Trusted authorization and asset proof timestamps must match the command observation at UTC microsecond precision; this prevents a caller from pairing an old provider proof with a newer `observedAt`. Authorization observations older than stored `observed_at` are rejected before writes, even if a caller omits `expectedVersion`.
- Only trusted provider adapters can issue the in-process VerifiedMetaEvidence capability. Its reference is stored as a SHA-256 digest; the provider payload/reference is not stored.
- The first verified claim reserves the app/provider/environment/kind/external-ID identity. A claim from another tenant is stored in that tenant's quarantine with CROSS_TENANT_VERIFIED_OWNER; it does not create or reassign an asset. The owning tenant ID is not copied into the quarantined candidate. Cross-tenant fanout remains disallowed until product evidence changes this policy.
- Same-tenant assets may be related to multiple authorizations. PHONE_TO_ACCOUNT and INSTAGRAM_TO_PAGE are verified relation types; an Instagram account does not require a Facebook relation.
- Composite FKs include tenant, authorization, app, provider and environment. An AssetAuthorization cannot connect an asset, authorization or credential from different tenants or app contexts.
- ca_meta_credentials contains metadata only. M3.07 owns ciphertext, key versions and credential rotation; it should extend this table rather than create a parallel credential model.
- Exact legacy asset references remain strings in ca_meta_asset_legacy_refs, are attached only by SERVICE/SYSTEM actors, and must match the tenant's existing ca_meta_tenant_legacy_maps row. Their source DDL semantics are Not confirmed; these are references only, not imported state.
- Authorization/asset history and quarantine are append-only. Application rollback is compatible with these additive tables; automatic destructive down migration is intentionally absent.

## Read and event contract

MetaAssetsRepository.listReadModels selects only explicit public metadata columns. The allowlisted AuthorizationReadModel / AssetReadModel has no credential/token/ciphertext property. Authorization, asset verification, subscription and projection states are distinct; subscription and projection start at UNKNOWN until their owning integrations update them.

A successful state change calls the existing OutboxService.appendWithin with the same TypeORM EntityManager and transaction used for authorization, asset, grant and history writes. It emits the existing connection.changed envelope (no outbox schema change). A failed commit therefore rolls back both domain rows and delivery intent. Cross-tenant asset claims report a PARTIAL connection event when the authorization itself is active.

## Reproducible local unit harness

Prerequisites: Node 24.22.2, npm 11.19.1 and the existing npm workspace install. This package adds no dependencies or lockfile changes.

From the repository root, with the project Node runtime on PATH:

- npm run typecheck --workspace=@ca-meta/api
- npm run build --workspace=@ca-meta/api
- npx tsc -p apps/api/tsconfig.test.json
- node --test apps/api/dist-test/test/m3-06-meta-assets.spec.js

Expected result: strict API/test compilation and the focused M3.06 Node test file pass. No database, provider account or production resource is needed for these unit checks. The generated API dist and dist-test directories are ignored build output.
After these checks, run tools/m3-06/cleanup.ps1 to remove only those two local output directories; it refuses linked or out-of-worktree targets.

The gated database test is `apps/api/test/m3-06-meta-assets.integration.spec.ts`. It runs in the existing M2.05/M3 disposable MariaDB profile when `M2_DURABLE_WORK_TEST=1`, calls the migration runner, then covers concurrent upsert/shared assets, confirmed scopes and grants, typed Instagram-to-Page relation persistence, omitted-grants preservation versus explicit revocation, cross-tenant FK rejection and quarantine, exact external IDs above 2^53, and rollback after outbox staging. The current integrated migration registry runs through M3.03 v8 with M3.06 v7 intact.

After the profile has compiled the API test tree and started its disposable database, run:

```powershell
node --test apps/api/dist-test/test/m3-06-meta-assets.integration.spec.js
```

The integration test was not executed in this implementation worktree; do not report a local unit test as MariaDB evidence. Actual Meta grants and real asset ownership remain Not confirmed; only synthetic provider evidence is covered here.
