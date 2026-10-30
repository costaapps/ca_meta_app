import type { BackfillStep, MigrationStepContext, VersionedMigration } from './migration.types.js';
import { assertExpectedColumns, tableColumns, tableExists } from './schema-inspection.js';
import { migrationChecksum } from './migration-fingerprint.js';
import { DURABLE_WORK_MIGRATION, DURABLE_WORK_TABLES } from './durable-work.js';
import { IDENTITY_MIGRATION } from './identity.js';
import { PORTAL_SESSIONS_MIGRATION, PORTAL_SESSION_TABLES } from './portal-sessions.js';
import { TICKET_RETRY_MIGRATION } from './ticket-retry.js';
import { META_ASSETS_MIGRATION, META_ASSETS_TABLES } from './meta-assets.js';

function ddl(
  id: string,
  phase: 'expand' | 'switch' | 'contract',
  sql: string,
  table: string,
  columns: readonly string[],
): import('./migration.types.js').DdlStep {
  return {
    id,
    phase,
    sql,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, verifyHelper: assertExpectedColumns.toString() }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => assertExpectedColumns(queryRunner, table, columns),
  };
}

const tenants = ddl(
  'create-tenants',
  'expand',
  `CREATE TABLE IF NOT EXISTS ca_meta_tenants (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  'ca_meta_tenants',
  ['id', 'status', 'version', 'created_at', 'updated_at'],
);

const legacyMaps = ddl(
  'create-tenant-legacy-maps',
  'expand',
  `CREATE TABLE IF NOT EXISTS ca_meta_tenant_legacy_maps (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    legacy_database_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    legacy_company_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_legacy_origin (legacy_database_id, legacy_company_id, environment),
    KEY ix_ca_meta_legacy_tenant (tenant_id),
    CONSTRAINT fk_ca_meta_legacy_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  'ca_meta_tenant_legacy_maps',
  ['id', 'tenant_id', 'legacy_database_id', 'legacy_company_id', 'environment', 'created_at'],
);

const appConfigurations = ddl(
  'create-app-configurations',
  'expand',
  `CREATE TABLE IF NOT EXISTS ca_meta_app_configurations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_ref VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_app_identity (tenant_id, provider, app_external_id, environment),
    UNIQUE KEY uq_ca_meta_app_tenant_context (tenant_id, id, provider, environment),
    CONSTRAINT fk_ca_meta_app_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  'ca_meta_app_configurations',
  ['id', 'tenant_id', 'provider', 'app_external_id', 'environment', 'credential_ref', 'version', 'created_at', 'updated_at'],
);

const assetCreation = ddl(
  'create-assets',
  'expand',
  `CREATE TABLE IF NOT EXISTS ca_meta_assets (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
    display_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_asset_identity (tenant_id, app_configuration_id, environment, provider, asset_kind, external_id),
    UNIQUE KEY uq_ca_meta_asset_tenant_id (tenant_id, id),
    KEY ix_ca_meta_asset_tenant_kind_created (tenant_id, asset_kind, created_at),
    CONSTRAINT fk_ca_meta_asset_app_context FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  'ca_meta_assets',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'version', 'created_at', 'updated_at'],
);

const assets: import('./migration.types.js').DdlStep = {
  ...assetCreation,
  definition: JSON.stringify({ baseDefinition: assetCreation.definition, verifyHelpers: [tableExists.toString(), tableColumns.toString(), assertExpectedColumns.toString()] }),
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_assets'))) return false;
    const actual = await tableColumns(queryRunner, 'ca_meta_assets');
    const base = ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'version', 'created_at', 'updated_at'];
    const expanded = ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'external_name', 'version', 'created_at', 'updated_at'];
    const matches = (expected: readonly string[]) => actual.length === expected.length && expected.every((column, index) => actual[index] === column);
    if (!matches(base) && !matches(expanded)) {
      throw new Error(`Migration preflight found an unexpected shape for table ca_meta_assets (${actual.join(',')}).`);
    }
    const candidateKey = await queryRunner.query(
      `SELECT column_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'ca_meta_assets'
         AND index_name = 'uq_ca_meta_asset_tenant_id' AND non_unique = 0
       ORDER BY seq_in_index`,
    ) as Array<{ name: string }>;
    if (candidateKey.map((row) => row.name).join(',') !== 'tenant_id,id') {
      throw new Error('Migration preflight found a missing or incompatible (tenant_id, id) asset candidate key.');
    }
    return true;
  },
};

const addExternalName: import('./migration.types.js').DdlStep = {
  id: 'expand-asset-external-name',
  phase: 'expand',
  sql: 'ALTER TABLE ca_meta_assets ADD COLUMN external_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER display_name, ADD INDEX ix_ca_meta_asset_external_name (external_name)',
  definitionVersion: 'v1',
  definition: JSON.stringify({ oldShape: ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'version', 'created_at', 'updated_at'], newShape: ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'external_name', 'version', 'created_at', 'updated_at'], index: ['external_name'], verifyHelpers: [assertExpectedColumns.toString(), tableColumns.toString(), tableExists.toString()] }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    const oldShape = ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'version', 'created_at', 'updated_at'];
    const newShape = ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'external_name', 'version', 'created_at', 'updated_at'];
    if (!(await tableExists(queryRunner, 'ca_meta_assets'))) {
      throw new Error('Cannot expand asset metadata before the base asset table exists.');
    }
    const actualColumns = await tableColumns(queryRunner, 'ca_meta_assets');
    if (!actualColumns.includes('external_name')) {
      await assertExpectedColumns(queryRunner, 'ca_meta_assets', oldShape);
      return false;
    }
    if (!(await assertExpectedColumns(queryRunner, 'ca_meta_assets', newShape))) return false;
    const indexRows = await queryRunner.query(
      `SELECT column_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'ca_meta_assets'
         AND index_name = 'ix_ca_meta_asset_external_name' AND non_unique = 1
       ORDER BY seq_in_index`,
    ) as Array<{ name: string }>;
    if (indexRows.map((row) => row.name).join(',') !== 'external_name') {
      throw new Error('Migration preflight found a missing or incompatible external-name backfill index.');
    }
    return true;
  },
};

function triggerStep(
  id: string,
  event: 'INSERT' | 'UPDATE',
  statement: string,
): import('./migration.types.js').DdlStep {
  const triggerName = `tr_ca_meta_asset_external_name_${event.toLowerCase()}`;
  const normalize = (value: string) => value.toUpperCase().replace(/[\s`]+/g, '');
  return {
    id,
    phase: 'expand',
    definitionVersion: 'v1',
    definition: JSON.stringify({ triggerName, event, statement, normalize: normalize.toString() }),
    retryWhenAbsent: true,
    sql: `CREATE TRIGGER ${triggerName} BEFORE ${event} ON ca_meta_assets FOR EACH ROW ${statement}`,
    verify: async ({ queryRunner }) => {
      const rows = await queryRunner.query(
        `SELECT action_timing, event_manipulation, event_object_table, action_statement
         FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?`,
        [triggerName],
      ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
      if (rows.length === 0) return false;
      const row = rows[0];
      if (!row || row.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== 'ca_meta_assets' ||
        normalize(row.action_statement) !== normalize(statement)) {
        throw new Error(`Migration preflight found an unexpected shape for trigger ${triggerName}.`);
      }
      return true;
    },
  };
}

const syncExternalNameOnInsert = triggerStep(
  'sync-asset-external-name-insert',
  'INSERT',
  'SET NEW.external_name = COALESCE(NEW.external_name, NEW.display_name)',
);

const syncExternalNameOnUpdate = triggerStep(
  'sync-asset-external-name-update',
  'UPDATE',
  'SET NEW.external_name = IF(NOT (BINARY NEW.display_name <=> BINARY OLD.display_name) AND (BINARY NEW.external_name <=> BINARY OLD.external_name), NEW.display_name, NEW.external_name)',
);

const backfillExternalName: BackfillStep = {
  id: 'backfill-asset-external-name',
  phase: 'backfill',
  definitionVersion: 'v1',
  definition: JSON.stringify({ selector: 'external_name IS NULL AND display_name IS NOT NULL', checkpoint: 'diagnostic-only-rescan' }),
  batchSize: 200,
  runBatch: async ({ queryRunner }, cursor, batchSize) => {
    // Triggers cover writes after expand; repeatedly selecting remaining NULLs also repairs rows written in the DDL-to-trigger gap.
    void cursor;
    const rows = await queryRunner.query(
      `SELECT id FROM ca_meta_assets WHERE external_name IS NULL AND display_name IS NOT NULL ORDER BY id LIMIT ${batchSize}`,
    ) as Array<{ id: string }>;
    if (rows.length === 0) return { nextCursor: cursor, done: true };
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    await queryRunner.query(
      `UPDATE ca_meta_assets SET external_name = display_name WHERE id IN (${placeholders}) AND external_name IS NULL`,
      ids,
    );
    return { nextCursor: ids[ids.length - 1] ?? cursor, done: false };
  },
};

const validateExternalName = {
  id: 'validate-asset-external-name-backfill',
  phase: 'validate' as const,
  definitionVersion: 'v1',
  definition: JSON.stringify({ predicate: 'NOT (BINARY external_name <=> BINARY display_name)' }),
  validate: async ({ queryRunner }: MigrationStepContext): Promise<void> => {
    const rows = await queryRunner.query(
      'SELECT COUNT(*) AS `count` FROM ca_meta_assets WHERE NOT (BINARY external_name <=> BINARY display_name)',
    ) as Array<{ count: string | number }>;
    if (Number(rows[0]?.count ?? 0) !== 0) throw new Error('Backfilled asset names failed validation.');
  },
};

const migrationsWithoutChecksums = [
  {
    id: '202610290001-initial-domain-schema',
    schemaVersion: 1,
    minimumSupportedApiVersion: 1,
    steps: [tenants, legacyMaps, appConfigurations, assets],
  },
  {
    id: '202610290002-expand-asset-name',
    schemaVersion: 2,
    minimumSupportedApiVersion: 1,
    steps: [addExternalName, syncExternalNameOnInsert, syncExternalNameOnUpdate, backfillExternalName, validateExternalName],
  },
  DURABLE_WORK_MIGRATION,
  IDENTITY_MIGRATION,
  PORTAL_SESSIONS_MIGRATION,
  TICKET_RETRY_MIGRATION,
  META_ASSETS_MIGRATION,
] as const;

export const MIGRATIONS: readonly VersionedMigration[] = migrationsWithoutChecksums.map((migration) => ({
  ...migration,
  checksum: migrationChecksum(migration),
}));

export const DOMAIN_TABLES = [
  'ca_meta_tenants',
  'ca_meta_tenant_legacy_maps',
  'ca_meta_app_configurations',
  'ca_meta_assets',
  'ca_meta_principals',
  'ca_meta_memberships',
  'ca_meta_service_identity_scopes',
  'ca_meta_identity_admin_audit',
  ...PORTAL_SESSION_TABLES,
  ...META_ASSETS_TABLES,
  ...DURABLE_WORK_TABLES,
] as const;

