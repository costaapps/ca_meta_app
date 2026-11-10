import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const columns = ['id', 'tenant_id', 'authorization_id', 'asset_id', 'version', 'schema_version', 'source', 'observed_at',
  'fetched_at', 'snapshot_json', 'created_at'] as const;
const indexes = [
  { name: 'PRIMARY', columns: ['id'], unique: true },
  { name: 'uq_ca_meta_asset_observations_version', columns: ['tenant_id', 'authorization_id', 'asset_id', 'version'], unique: true },
  { name: 'ix_ca_meta_asset_observations_fetched', columns: ['tenant_id', 'authorization_id', 'asset_id', 'fetched_at'], unique: false },
  { name: 'ix_ca_meta_asset_observations_tenant_asset', columns: ['tenant_id', 'asset_id'], unique: false },
] as const;

async function verifyKeys(queryRunner: QueryRunner): Promise<void> {
  const indexRows = await queryRunner.query(
    "SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ca_meta_asset_observations' ORDER BY index_name, seq_in_index",
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const index = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actual.set(row.name, index);
  }
  if (actual.size !== indexes.length || indexes.some((expected) => {
    const found = actual.get(expected.name);
    return !found || found.unique !== expected.unique || found.columns.join('\0') !== expected.columns.join('\0');
  })) throw new Error('Migration found an incompatible index on ca_meta_asset_observations.');
  const foreignKeys = await queryRunner.query(
    "SELECT column_name AS name, referenced_table_name AS referenced_table, referenced_column_name AS referenced_column FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'ca_meta_asset_observations' AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position",
  ) as Array<{ name: string; referenced_table: string; referenced_column: string }>;
  if (foreignKeys.map((row) => `${row.name}:${row.referenced_table}:${row.referenced_column}`).join(',') !==
      'tenant_id:ca_meta_assets:tenant_id,asset_id:ca_meta_assets:id,tenant_id:ca_meta_asset_authorizations:tenant_id,authorization_id:ca_meta_asset_authorizations:authorization_id,asset_id:ca_meta_asset_authorizations:asset_id') {
    throw new Error('Migration found an incompatible tenant/authorization/asset observation foreign key.');
  }
}

const table: DdlStep = {
  id: 'create-meta-asset-observations',
  phase: 'expand',
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_asset_observations', columns, indexes, schemaVersion: 1,
    verifyHelpers: [assertExpectedColumns.toString(), tableExists.toString(), verifyKeys.toString()] }),
  retryWhenAbsent: true,
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_asset_observations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    schema_version SMALLINT UNSIGNED NOT NULL,
    source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    observed_at DATETIME(6) NULL,
    fetched_at DATETIME(6) NOT NULL,
    snapshot_json JSON NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_asset_observations_version (tenant_id, authorization_id, asset_id, version),
    KEY ix_ca_meta_asset_observations_fetched (tenant_id, authorization_id, asset_id, fetched_at),
    KEY ix_ca_meta_asset_observations_tenant_asset (tenant_id, asset_id),
    CONSTRAINT ck_ca_meta_asset_observations_source CHECK (source IN ('META_API', 'SIGNED_WEBHOOK')),
    CONSTRAINT ck_ca_meta_asset_observations_schema CHECK (schema_version = 1),
    CONSTRAINT ck_ca_meta_asset_observations_json CHECK (JSON_VALID(snapshot_json)),
    CONSTRAINT fk_ca_meta_asset_observations_asset FOREIGN KEY (tenant_id, asset_id)
      REFERENCES ca_meta_assets (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_asset_observations_authorization FOREIGN KEY (tenant_id, authorization_id, asset_id)
      REFERENCES ca_meta_asset_authorizations (tenant_id, authorization_id, asset_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_asset_observations'))) return false;
    await assertExpectedColumns(queryRunner, 'ca_meta_asset_observations', columns);
    await verifyKeys(queryRunner);
    return true;
  },
};

function appendOnlyTrigger(event: 'UPDATE' | 'DELETE'): DdlStep {
  const name = `tr_meta_asset_observation_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only observation history'";
  return {
    id: `asset-observation-no-${event.toLowerCase()}`,
    phase: 'expand',
    definitionVersion: 'v1',
    definition: JSON.stringify({ name, table: 'ca_meta_asset_observations', event, statement }),
    retryWhenAbsent: true,
    sql: `CREATE TRIGGER ${name} BEFORE ${event} ON ca_meta_asset_observations FOR EACH ROW ${statement}`,
    verify: async ({ queryRunner }) => {
      const rows = await queryRunner.query(
        'SELECT action_timing, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?',
        [name],
      ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
      if (rows.length === 0) return false;
      const row = rows[0]!;
      const normalize = (value: string) => value.toUpperCase().replace(/[\s`]+/g, '');
      if (row.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== 'ca_meta_asset_observations' ||
          normalize(row.action_statement) !== normalize(statement)) {
        throw new Error(`Migration found an incompatible append-only trigger ${name}.`);
      }
      return true;
    },
  };
}

const definition = {
  id: '202611100019-meta-asset-observations',
  schemaVersion: 19,
  minimumSupportedApiVersion: 1,
  steps: [table, appendOnlyTrigger('UPDATE'), appendOnlyTrigger('DELETE')],
} as const;

export const ASSET_OBSERVATIONS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const ASSET_OBSERVATION_TABLES = ['ca_meta_asset_observations'] as const;
