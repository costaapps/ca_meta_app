import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface IndexShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

async function verifyIndexes(queryRunner: QueryRunner, table: string, expected: readonly IndexShape[]): Promise<void> {
  const rows = await queryRunner.query(
    'SELECT index_name AS name, column_name, non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { readonly columns: string[]; readonly unique: boolean }>();
  for (const row of rows) {
    const index = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actual.set(row.name, index);
  }
  if (actual.size !== expected.length || expected.some((index) => {
    const found = actual.get(index.name);
    return !found || found.unique !== index.unique || found.columns.join('\0') !== index.columns.join('\0');
  })) throw new Error(`Migration found an incompatible index on ${table}.`);
}

function tableStep(id: string, table: string, columns: readonly string[], indexes: readonly IndexShape[], sql: string): DdlStep {
  return {
    id,
    phase: 'expand',
    sql,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, helpers: [assertExpectedColumns.toString(), verifyIndexes.toString()] }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      if (!(await tableExists(queryRunner, table))) return false;
      await assertExpectedColumns(queryRunner, table, columns);
      await verifyIndexes(queryRunner, table, indexes);
      return true;
    },
  };
}

async function triggerExists(queryRunner: QueryRunner, name: string, event: 'UPDATE' | 'DELETE'): Promise<boolean> {
  const rows = await queryRunner.query(
    'SELECT action_timing, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?',
    [name],
  ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
  if (rows.length === 0) return false;
  const row = rows[0];
  const statement = row?.action_statement.toUpperCase().replace(/[\s`]+/g, '');
  if (row?.action_timing !== 'BEFORE' || row.event_manipulation !== event ||
      row.event_object_table !== 'ca_meta_asset_automation_config_versions' ||
      statement !== "SIGNALSQLSTATE'45000'SETMESSAGE_TEXT='APPEND-ONLYAUTOMATIONHISTORY'") {
    throw new Error(`Migration found an incompatible trigger ${name}.`);
  }
  return true;
}

function immutableHistoryTrigger(id: string, event: 'UPDATE' | 'DELETE'): DdlStep {
  const triggerName = `tr_ca_meta_automation_config_history_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only automation history'";
  return {
    id,
    phase: 'expand',
    sql: `CREATE TRIGGER ${triggerName} BEFORE ${event} ON ca_meta_asset_automation_config_versions FOR EACH ROW ${statement}`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ triggerName, table: 'ca_meta_asset_automation_config_versions', event, statement }),
    retryWhenAbsent: true,
    verify: ({ queryRunner }) => triggerExists(queryRunner, triggerName, event),
  };
}

const config = tableStep(
  'create-asset-automation-configs',
  'ca_meta_asset_automation_configs',
  ['tenant_id', 'asset_id', 'private_welcome_message', 'comment_public_reply', 'comment_private_reply', 'version', 'projection_state', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'asset_id'], unique: true },
    { name: 'ix_ca_meta_automation_config_projection', columns: ['projection_state', 'updated_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_asset_automation_configs (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    private_welcome_message TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    comment_public_reply TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    comment_private_reply TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    projection_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'UNKNOWN',
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NULL,
    PRIMARY KEY (tenant_id, asset_id),
    KEY ix_ca_meta_automation_config_projection (projection_state, updated_at),
    CONSTRAINT ck_ca_meta_automation_config_projection CHECK (projection_state IN ('UNKNOWN', 'PENDING', 'SYNCED', 'STALE', 'FAILED')),
    CONSTRAINT fk_ca_meta_automation_config_asset FOREIGN KEY (tenant_id, asset_id)
      REFERENCES ca_meta_assets (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const history = tableStep(
  'create-asset-automation-config-versions',
  'ca_meta_asset_automation_config_versions',
  ['tenant_id', 'asset_id', 'version', 'changed_fields_json', 'actor_ref_hash', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'asset_id', 'version'], unique: true },
    { name: 'ix_ca_meta_automation_config_history_actor', columns: ['tenant_id', 'actor_ref_hash', 'created_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_asset_automation_config_versions (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    changed_fields_json JSON NOT NULL,
    actor_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, asset_id, version),
    KEY ix_ca_meta_automation_config_history_actor (tenant_id, actor_ref_hash, created_at),
    CONSTRAINT fk_ca_meta_automation_config_history_asset FOREIGN KEY (tenant_id, asset_id)
      REFERENCES ca_meta_assets (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const definition = {
  id: '202611120023-asset-automation-config',
  schemaVersion: 23,
  minimumSupportedApiVersion: 1,
  steps: [
    config,
    history,
    immutableHistoryTrigger('automation-config-history-no-update', 'UPDATE'),
    immutableHistoryTrigger('automation-config-history-no-delete', 'DELETE'),
  ],
} as const;

export const AUTOMATION_CONFIG_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const AUTOMATION_CONFIG_TABLES = [
  'ca_meta_asset_automation_configs',
  'ca_meta_asset_automation_config_versions',
] as const;
