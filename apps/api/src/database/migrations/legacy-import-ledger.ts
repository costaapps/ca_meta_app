import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, MigrationStepContext, VersionedMigration } from './migration.types.js';

interface IndexShape { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }
interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly referencedColumns: readonly string[];
}

export const LEGACY_IMPORT_BATCH_COLUMNS = [
  'batch_id', 'source_snapshot_hash', 'source_version', 'projection_version', 'item_count',
  'last_completed_sequence', 'state', 'version', 'created_at', 'updated_at',
] as const;
export const LEGACY_IMPORT_ITEM_COLUMNS = [
  'batch_id', 'sequence', 'source_record_hash', 'source_payload_hash', 'source_table', 'tenant_id',
  'app_configuration_id', 'environment', 'asset_kind', 'target_asset_ref', 'item_state', 'reason_code',
  'credential_disposition', 'expiry_observation', 'created_at', 'updated_at',
] as const;
export const LEGACY_IMPORT_CLAIM_COLUMNS = [
  'source_record_hash', 'source_payload_hash', 'tenant_id', 'app_configuration_id', 'provider', 'environment',
  'asset_kind', 'target_asset_ref', 'credential_disposition', 'expiry_observation', 'claim_state',
  'created_batch_id', 'created_sequence', 'version', 'created_at', 'updated_at',
] as const;

const batchSql = `CREATE TABLE IF NOT EXISTS ca_meta_legacy_import_batches (
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_snapshot_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  projection_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_count INT UNSIGNED NOT NULL,
  last_completed_sequence INT UNSIGNED NOT NULL DEFAULT 0,
  state ENUM('PLANNED','APPLYING','PAUSED','COMPLETED','FAILED') CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PLANNED',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (batch_id),
  KEY ix_ca_meta_legacy_batch_state_updated (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;

const itemSql = `CREATE TABLE IF NOT EXISTS ca_meta_legacy_import_items (
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence INT UNSIGNED NOT NULL,
  source_record_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_table ENUM('MetaConnectedPages','MetaConnectedNumbers') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  environment ENUM('development','test','staging','production') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_kind ENUM('FACEBOOK_PAGE','WHATSAPP_BUSINESS_ACCOUNT','WHATSAPP_PHONE_NUMBER') CHARACTER SET ascii COLLATE ascii_bin NULL,
  target_asset_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_state ENUM('PLANNED','CLAIMED','REPLAYED','QUARANTINED','QUARANTINED_SOURCE_CHANGED','ROLLED_BACK') CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PLANNED',
  reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  credential_disposition ENUM('ABSENT','REQUIRES_REAUTH') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expiry_observation ENUM('OBSERVED_DATE','UNKNOWN','INVALID') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (batch_id, sequence),
  UNIQUE KEY uq_ca_meta_legacy_batch_source (batch_id, source_record_hash),
  KEY ix_ca_meta_legacy_item_source (source_record_hash),
  CONSTRAINT fk_ca_meta_legacy_item_batch FOREIGN KEY (batch_id) REFERENCES ca_meta_legacy_import_batches (batch_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;

const claimSql = `CREATE TABLE IF NOT EXISTS ca_meta_legacy_import_claims (
  source_record_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'META',
  environment ENUM('development','test','staging','production') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_kind ENUM('FACEBOOK_PAGE','WHATSAPP_BUSINESS_ACCOUNT','WHATSAPP_PHONE_NUMBER') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_asset_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  credential_disposition ENUM('ABSENT','REQUIRES_REAUTH') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expiry_observation ENUM('OBSERVED_DATE','UNKNOWN','INVALID') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_state ENUM('UNVERIFIED_METADATA_ONLY') CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'UNVERIFIED_METADATA_ONLY',
  created_batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_sequence INT UNSIGNED NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (source_record_hash),
  KEY ix_ca_meta_legacy_claim_tenant (tenant_id, app_configuration_id, provider, environment),
  KEY ix_ca_meta_legacy_claim_batch (created_batch_id, created_sequence),
  CONSTRAINT fk_ca_meta_legacy_claim_app FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)
    REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ca_meta_legacy_claim_item FOREIGN KEY (created_batch_id, created_sequence)
    REFERENCES ca_meta_legacy_import_items (batch_id, sequence) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;

async function verifyTable(
  context: MigrationStepContext,
  table: string,
  columns: readonly string[],
  indexes: readonly IndexShape[],
  foreignKeys: readonly ForeignKeyShape[],
): Promise<boolean> {
  if (!(await tableExists(context.queryRunner, table))) return false;
  if (!(await assertExpectedColumns(context.queryRunner, table, columns))) return false;
  const indexRows = await context.queryRunner.query(
    `SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique
     FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY index_name, seq_in_index`,
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const index = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actualIndexes.set(row.name, index);
  }
  if (actualIndexes.size !== indexes.length || indexes.some((expected) => {
    const actual = actualIndexes.get(expected.name);
    return !actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0');
  })) return false;
  const foreignRows = await context.queryRunner.query(
    `SELECT constraint_name AS name, column_name AS column_name, referenced_table_name AS referenced_table,
       referenced_column_name AS referenced_column FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL
     ORDER BY constraint_name, ordinal_position`,
    [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actualForeignKeys = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of foreignRows) {
    const key = actualForeignKeys.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    key.columns.push(row.column_name);
    key.referencedColumns.push(row.referenced_column);
    actualForeignKeys.set(row.name, key);
  }
  return actualForeignKeys.size === foreignKeys.length && foreignKeys.every((expected) => {
    const actual = actualForeignKeys.get(expected.name);
    return actual?.table === expected.table && actual.columns.join('\0') === expected.columns.join('\0') &&
      actual.referencedColumns.join('\0') === expected.referencedColumns.join('\0');
  });
}

function tableStep(
  id: string,
  table: string,
  columns: readonly string[],
  indexes: readonly IndexShape[],
  foreignKeys: readonly ForeignKeyShape[],
  sql: string,
): DdlStep {
  return {
    id,
    phase: 'expand',
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys, sql, verify: verifyTable.toString() }),
    retryWhenAbsent: true,
    sql,
    verify: (context) => verifyTable(context, table, columns, indexes, foreignKeys),
  };
}

const definition = {
  id: '202611040015-legacy-import-ledger',
  schemaVersion: 15,
  minimumSupportedApiVersion: 1,
  steps: [
    tableStep('create-legacy-import-batches', 'ca_meta_legacy_import_batches', LEGACY_IMPORT_BATCH_COLUMNS,
      [{ name: 'PRIMARY', columns: ['batch_id'], unique: true },
        { name: 'ix_ca_meta_legacy_batch_state_updated', columns: ['state', 'updated_at'], unique: false }], [], batchSql),
    tableStep('create-legacy-import-items', 'ca_meta_legacy_import_items', LEGACY_IMPORT_ITEM_COLUMNS,
      [{ name: 'PRIMARY', columns: ['batch_id', 'sequence'], unique: true },
        { name: 'uq_ca_meta_legacy_batch_source', columns: ['batch_id', 'source_record_hash'], unique: true },
        { name: 'ix_ca_meta_legacy_item_source', columns: ['source_record_hash'], unique: false }],
      [{ name: 'fk_ca_meta_legacy_item_batch', columns: ['batch_id'], table: 'ca_meta_legacy_import_batches', referencedColumns: ['batch_id'] }], itemSql),
    tableStep('create-legacy-import-claims', 'ca_meta_legacy_import_claims', LEGACY_IMPORT_CLAIM_COLUMNS,
      [{ name: 'PRIMARY', columns: ['source_record_hash'], unique: true },
        { name: 'ix_ca_meta_legacy_claim_tenant', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], unique: false },
        { name: 'ix_ca_meta_legacy_claim_batch', columns: ['created_batch_id', 'created_sequence'], unique: false }],
      [{ name: 'fk_ca_meta_legacy_claim_app', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'],
        table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] },
        { name: 'fk_ca_meta_legacy_claim_item', columns: ['created_batch_id', 'created_sequence'],
          table: 'ca_meta_legacy_import_items', referencedColumns: ['batch_id', 'sequence'] }], claimSql),
  ],
} as const;

export const LEGACY_IMPORT_MIGRATION: VersionedMigration = { ...definition, checksum: migrationChecksum(definition) };
export const LEGACY_IMPORT_TABLES = [
  'ca_meta_legacy_import_batches', 'ca_meta_legacy_import_items', 'ca_meta_legacy_import_claims',
] as const;
