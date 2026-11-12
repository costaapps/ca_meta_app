import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const batchColumns = [
  'batch_id', 'source_snapshot_hash', 'source_version', 'projection_version', 'catalog_ref',
  'planned_rows', 'candidate_rows', 'quarantined_rows', 'credential_reauth_rows',
  'before_assets', 'before_templates', 'before_message_configs', 'before_relationships', 'before_credential_refs',
  'after_assets', 'after_templates', 'after_message_configs', 'after_relationships', 'after_credential_refs',
  'last_completed_sequence', 'state', 'version', 'created_at', 'updated_at',
] as const;

const writerColumns = [
  'cohort_id', 'tenant_id', 'channel_family', 'consumer_kind', 'function_name', 'writer_owner',
  'previous_writer_owner', 'phase', 'shadow_read_enabled', 'shadow_read_candidate_snapshot_hash', 'legacy_route_verified',
  'unresolved_external_effects', 'drift_reconciled_snapshot_hash', 'version', 'created_at', 'updated_at',
] as const;

async function verifyIndexes(
  queryRunner: QueryRunner,
  table: string,
  expected: ReadonlyMap<string, { readonly columns: readonly string[]; readonly unique: boolean }>,
): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index`,
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const indexes = new Map<string, { readonly unique: boolean; readonly columns: string[] }>();
  for (const row of rows) {
    const found = indexes.get(row.name) ?? { unique: Number(row.non_unique) === 0, columns: [] };
    found.columns.push(row.column_name);
    indexes.set(row.name, found);
  }
  if (indexes.size !== expected.size || [...expected].some(([name, definition]) => {
    const actual = indexes.get(name);
    return !actual || actual.unique !== definition.unique || actual.columns.join('\0') !== definition.columns.join('\0');
  })) throw new Error(`Migration found an incompatible index layout for ${table}.`);
}

const batches: DdlStep = {
  id: 'create-migration-batch-manifests',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_migration_batch_manifests (
    batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_snapshot_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_version VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    projection_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    catalog_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    planned_rows INT UNSIGNED NOT NULL,
    candidate_rows INT UNSIGNED NOT NULL,
    quarantined_rows INT UNSIGNED NOT NULL,
    credential_reauth_rows INT UNSIGNED NOT NULL,
    before_assets BIGINT UNSIGNED NOT NULL,
    before_templates BIGINT UNSIGNED NOT NULL,
    before_message_configs BIGINT UNSIGNED NOT NULL,
    before_relationships BIGINT UNSIGNED NOT NULL,
    before_credential_refs BIGINT UNSIGNED NOT NULL,
    after_assets BIGINT UNSIGNED NULL,
    after_templates BIGINT UNSIGNED NULL,
    after_message_configs BIGINT UNSIGNED NULL,
    after_relationships BIGINT UNSIGNED NULL,
    after_credential_refs BIGINT UNSIGNED NULL,
    last_completed_sequence INT UNSIGNED NOT NULL DEFAULT 0,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PLANNED',
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (batch_id),
    UNIQUE KEY uq_ca_meta_migration_batch_snapshot (source_snapshot_hash, projection_version),
    KEY ix_ca_meta_migration_batch_state (state, updated_at),
    CONSTRAINT fk_ca_meta_migration_manifest_import_batch FOREIGN KEY (batch_id)
      REFERENCES ca_meta_legacy_import_batches (batch_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_migration_manifest_counts CHECK (candidate_rows + quarantined_rows = planned_rows),
    CONSTRAINT ck_ca_meta_migration_manifest_state CHECK (state IN ('PLANNED', 'APPLYING', 'PAUSED', 'COMPLETED', 'FAILED'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_migration_batch_manifests', columns: batchColumns,
    indexes: ['PRIMARY(batch_id)', 'UNIQUE(source_snapshot_hash,projection_version)', 'state,updated_at'],
    foreignKeys: ['batch_id -> ca_meta_legacy_import_batches(batch_id)'],
    safeFields: ['source snapshot hash', 'source version', 'projection version', 'catalog alias', 'aggregate counts', 'checkpoint'],
    verifier: [assertExpectedColumns.toString(), verifyIndexes.toString(), tableExists.toString()] }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_migration_batch_manifests'))) return false;
    await assertExpectedColumns(queryRunner, 'ca_meta_migration_batch_manifests', batchColumns);
    await verifyIndexes(queryRunner, 'ca_meta_migration_batch_manifests', new Map([
      ['PRIMARY', { columns: ['batch_id'], unique: true }],
      ['uq_ca_meta_migration_batch_snapshot', { columns: ['source_snapshot_hash', 'projection_version'], unique: true }],
      ['ix_ca_meta_migration_batch_state', { columns: ['state', 'updated_at'], unique: false }],
    ]));
    return true;
  },
};

const cohortWriters: DdlStep = {
  id: 'create-migration-cohort-writer-matrix',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_migration_cohort_writers (
    cohort_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    channel_family VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    consumer_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    function_name VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    writer_owner VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    previous_writer_owner VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    shadow_read_enabled TINYINT(1) NOT NULL DEFAULT 0,
    shadow_read_candidate_snapshot_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    legacy_route_verified TINYINT(1) NOT NULL DEFAULT 0,
    unresolved_external_effects INT UNSIGNED NOT NULL DEFAULT 0,
    drift_reconciled_snapshot_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, channel_family, consumer_kind, function_name),
    UNIQUE KEY uq_ca_meta_migration_cohort_function (cohort_id, function_name),
    KEY ix_ca_meta_migration_cohort_id (cohort_id),
    CONSTRAINT fk_ca_meta_migration_cohort_tenant FOREIGN KEY (tenant_id)
      REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_migration_cohort_channel CHECK (channel_family IN ('WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE', 'FACEBOOK', 'INSTAGRAM')),
    CONSTRAINT ck_ca_meta_migration_cohort_consumer CHECK (consumer_kind IN ('PORTAL', 'LEGACY_PHP', 'INTERNAL_WORKER', 'WEBHOOK_INGRESS', 'OTHER_INTERNAL')),
    CONSTRAINT ck_ca_meta_migration_cohort_function CHECK (function_name IN ('CONFIGURATION', 'CREDENTIAL_REFERENCE', 'LEGACY_PROJECTION', 'OPERATION_RELAY', 'WEBHOOK_DISPATCH')),
    CONSTRAINT ck_ca_meta_migration_cohort_writer CHECK (writer_owner IN ('LEGACY', 'CENTRAL', 'PROJECTOR', 'RELAY', 'NEW')),
    CONSTRAINT ck_ca_meta_migration_cohort_phase CHECK (phase IN ('PREPARED', 'SHADOW_READ', 'CUTOVER', 'PAUSED', 'ROLLED_BACK'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_migration_cohort_writers', columns: writerColumns,
    indexes: ['PRIMARY(tenant_id,channel_family,consumer_kind,function_name)',
      'UNIQUE(cohort_id,function_name)', 'cohort_id'],
    foreignKeys: ['tenant_id -> ca_meta_tenants(id)'],
    checks: ['channel family allowlist', 'consumer kind allowlist', 'function allowlist', 'writer owner allowlist', 'phase allowlist'],
    verifier: [assertExpectedColumns.toString(), verifyIndexes.toString(), tableExists.toString()] }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_migration_cohort_writers'))) return false;
    await assertExpectedColumns(queryRunner, 'ca_meta_migration_cohort_writers', writerColumns);
    await verifyIndexes(queryRunner, 'ca_meta_migration_cohort_writers', new Map([
      ['PRIMARY', { columns: ['tenant_id', 'channel_family', 'consumer_kind', 'function_name'], unique: true }],
      ['uq_ca_meta_migration_cohort_function', { columns: ['cohort_id', 'function_name'], unique: true }],
      ['ix_ca_meta_migration_cohort_id', { columns: ['cohort_id'], unique: false }],
    ]));
    return true;
  },
};

const definition = {
  id: '202611120026-migration-execution-control',
  schemaVersion: 26,
  minimumSupportedApiVersion: 1,
  steps: [batches, cohortWriters],
} as const;

export const MIGRATION_EXECUTION_CONTROL_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const MIGRATION_EXECUTION_CONTROL_TABLES = [
  'ca_meta_migration_batch_manifests',
  'ca_meta_migration_cohort_writers',
] as const;
