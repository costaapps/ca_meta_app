import { createHash } from 'node:crypto';
import type { BackfillStep, MigrationStepContext, VersionedMigration } from './migration.types.js';
import { assertExpectedColumns, tableColumns, tableExists } from './schema-inspection.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
    legacy_company_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
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
    app_external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
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
    external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    display_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_asset_identity (tenant_id, app_configuration_id, environment, provider, asset_kind, external_id),
    KEY ix_ca_meta_asset_tenant_kind_created (tenant_id, asset_kind, created_at),
    CONSTRAINT fk_ca_meta_asset_app_context FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  'ca_meta_assets',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'version', 'created_at', 'updated_at'],
);

const assets: import('./migration.types.js').DdlStep = {
  ...assetCreation,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_assets'))) return false;
    const actual = await tableColumns(queryRunner, 'ca_meta_assets');
    const base = ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'version', 'created_at', 'updated_at'];
    const expanded = ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'display_name', 'external_name', 'version', 'created_at', 'updated_at'];
    const matches = (expected: readonly string[]) => actual.length === expected.length && expected.every((column, index) => actual[index] === column);
    if (!matches(base) && !matches(expanded)) {
      throw new Error(`Migration preflight found an unexpected shape for table ca_meta_assets (${actual.join(',')}).`);
    }
    return true;
  },
};

const addExternalName: import('./migration.types.js').DdlStep = {
  id: 'expand-asset-external-name',
  phase: 'expand',
  sql: 'ALTER TABLE ca_meta_assets ADD COLUMN external_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER display_name',
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
    return assertExpectedColumns(queryRunner, 'ca_meta_assets', newShape);
  },
};

const backfillExternalName: BackfillStep = {
  id: 'backfill-asset-external-name',
  phase: 'backfill',
  checksum: sha256('m2-03:copy-display-name-to-external-name:v1'),
  batchSize: 200,
  runBatch: async ({ queryRunner }, cursor, batchSize) => {
    const rows = await queryRunner.query(
      cursor === null
        ? `SELECT id FROM ca_meta_assets ORDER BY id LIMIT ${batchSize}`
        : `SELECT id FROM ca_meta_assets WHERE id > ? ORDER BY id LIMIT ${batchSize}`,
      cursor === null ? [] : [cursor],
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
  checksum: sha256('m2-03:external-name-backfill-validation:v1'),
  validate: async ({ queryRunner }: MigrationStepContext): Promise<void> => {
    const rows = await queryRunner.query(
      'SELECT COUNT(*) AS `count` FROM ca_meta_assets WHERE external_name IS NOT NULL AND BINARY external_name <> BINARY display_name',
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
    steps: [addExternalName, backfillExternalName, validateExternalName],
  },
] as const;

export const MIGRATIONS: readonly VersionedMigration[] = migrationsWithoutChecksums.map((migration) => {
  const material = migration.steps.map((step) =>
    'sql' in step
      ? `${step.id}\n${step.phase}\n${step.sql}`
      : `${step.id}\n${step.phase}\n${step.checksum}`,
  ).join('\n---\n');
  return {
    ...migration,
    checksum: sha256(`${migration.id}\n${migration.schemaVersion}\n${material}`),
  };
});

export const DOMAIN_TABLES = [
  'ca_meta_tenants',
  'ca_meta_tenant_legacy_maps',
  'ca_meta_app_configurations',
  'ca_meta_assets',
] as const;

