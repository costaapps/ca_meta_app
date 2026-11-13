import type { DdlStep, VersionedMigration } from './migration.types.js';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { QueryRunner } from 'typeorm';

const checkpointTable = 'ca_meta_legacy_projection_checkpoints';
const checkpointColumns = [
  'tenant_id', 'destination_key_hash', 'central_ref', 'source_version', 'projection_schema_version',
  'content_hash', 'tombstone', 'state', 'safe_error_code', 'updated_at',
] as const;
const checkpointIndexes = [
  { name: 'PRIMARY', columns: ['tenant_id', 'destination_key_hash', 'central_ref'], unique: true },
  { name: 'ix_ca_meta_projection_state_updated', columns: ['tenant_id', 'state', 'updated_at'], unique: false },
] as const;
const checkpointForeignKey = {
  name: 'fk_ca_meta_projection_tenant', column: 'tenant_id', referencedTable: 'ca_meta_tenants',
  referencedColumn: 'id', updateRule: 'RESTRICT', deleteRule: 'RESTRICT',
} as const;
const checkpointChecks = new Map([
  ['ck_ca_meta_projection_state', "statein'pending','synced','failed'"],
  ['ck_ca_meta_projection_tombstone', 'tombstonein0,1'],
]);

function normalizeCheck(value: string | Buffer): string {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  return text.toLowerCase().replace(/[\s`()]+/g, '');
}

async function verifyCheckpointStructure(queryRunner: QueryRunner): Promise<boolean> {
  if (!(await tableExists(queryRunner, checkpointTable))) return false;
  await assertExpectedColumns(queryRunner, checkpointTable, checkpointColumns);

  const indexRows = await queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index`,
    [checkpointTable],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const indexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const index = indexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    indexes.set(row.name, index);
  }
  if (indexes.size !== checkpointIndexes.length || checkpointIndexes.some((expected) => {
    const actual = indexes.get(expected.name);
    return !actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0');
  })) throw new Error('Migration found an incompatible checkpoint index or composite primary key.');

  const foreignRows = await queryRunner.query(
    `SELECT k.constraint_name AS name, k.column_name AS column_name, DATABASE() AS current_schema,
            k.referenced_table_schema AS referenced_schema, k.referenced_table_name AS referenced_table,
            k.referenced_column_name AS referenced_column, r.update_rule AS update_rule, r.delete_rule AS delete_rule
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema = k.constraint_schema AND r.table_name = k.table_name AND r.constraint_name = k.constraint_name
     WHERE k.table_schema = DATABASE() AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
     ORDER BY k.constraint_name, k.ordinal_position`,
    [checkpointTable],
  ) as Array<{ name: string; column_name: string; current_schema: string; referenced_schema: string; referenced_table: string;
    referenced_column: string; update_rule: string; delete_rule: string }>;
  if (foreignRows.length !== 1 || foreignRows[0]?.name !== checkpointForeignKey.name ||
      foreignRows[0]?.column_name !== checkpointForeignKey.column ||
      foreignRows[0]?.referenced_schema !== foreignRows[0]?.current_schema ||
      foreignRows[0]?.referenced_table !== checkpointForeignKey.referencedTable ||
      foreignRows[0]?.referenced_column !== checkpointForeignKey.referencedColumn ||
      foreignRows[0]?.update_rule.toUpperCase() !== checkpointForeignKey.updateRule ||
      foreignRows[0]?.delete_rule.toUpperCase() !== checkpointForeignKey.deleteRule) {
    throw new Error('Migration found an incompatible checkpoint tenant foreign key.');
  }

  const checkRows = await queryRunner.query(
    `SELECT tc.constraint_name AS name, cc.check_clause AS clause
     FROM information_schema.table_constraints tc
     LEFT JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = DATABASE() AND tc.table_name = ? AND tc.constraint_type = 'CHECK'`,
    [checkpointTable],
  ) as Array<{ name: string; clause: string | Buffer | null }>;
  if (checkRows.length !== checkpointChecks.size || checkRows.some((row) =>
    row.clause === null || checkpointChecks.get(row.name) !== normalizeCheck(row.clause))) {
    throw new Error('Migration found incompatible checkpoint CHECK constraints.');
  }
  return true;
}

const checkpointStep: DdlStep = {
  id: 'create-legacy-projection-checkpoints',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_legacy_projection_checkpoints (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    destination_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    central_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    source_version BIGINT UNSIGNED NOT NULL,
    projection_schema_version SMALLINT UNSIGNED NOT NULL,
    content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tombstone TINYINT(1) NOT NULL DEFAULT 0,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_error_code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, destination_key_hash, central_ref),
    KEY ix_ca_meta_projection_state_updated (tenant_id, state, updated_at),
    CONSTRAINT ck_ca_meta_projection_state CHECK (state IN ('PENDING', 'SYNCED', 'FAILED')),
    CONSTRAINT ck_ca_meta_projection_tombstone CHECK (tombstone IN (0, 1)),
    CONSTRAINT fk_ca_meta_projection_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: checkpointTable, columns: checkpointColumns, indexes: checkpointIndexes,
    foreignKey: checkpointForeignKey, checks: [...checkpointChecks],
    verify: [normalizeCheck.toString(), verifyCheckpointStructure.toString(), assertExpectedColumns.toString(), tableExists.toString()],
  }),
  retryWhenAbsent: true,
  verify: ({ queryRunner }) => verifyCheckpointStructure(queryRunner),
};

const definition = {
  id: '202611120025-legacy-projection-checkpoints',
  schemaVersion: 25,
  minimumSupportedApiVersion: 1,
  steps: [checkpointStep],
} as const;

export const LEGACY_PROJECTION_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const LEGACY_PROJECTION_TABLES = ['ca_meta_legacy_projection_checkpoints'] as const;
