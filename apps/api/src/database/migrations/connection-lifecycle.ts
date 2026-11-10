import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const commandColumns = [
  'id', 'tenant_id', 'actor_ref_hash', 'authorization_id', 'asset_id', 'onboarding_session_id', 'operation',
  'idempotency_key_hash', 'request_hash', 'local_state', 'cleanup_state', 'safe_reason_code', 'created_at', 'updated_at',
] as const;
const callbackColumns = [
  'app_configuration_ref_hash', 'event_ref_hash', 'payload_ref_hash', 'callback_kind', 'receipt_state', 'created_at', 'updated_at',
] as const;

interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly referencedColumns: readonly string[];
  readonly updateRule: 'RESTRICT';
  readonly deleteRule: 'RESTRICT';
}

async function verifyIndexes(queryRunner: QueryRunner, table: string,
  expected: readonly { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }[]): Promise<void> {
  const rows = await queryRunner.query(
    'SELECT index_name AS name, column_name, non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
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

async function verifyForeignKeys(queryRunner: QueryRunner, table: string,
  expected: readonly ForeignKeyShape[]): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT k.constraint_name AS name, k.column_name AS column_name,
            k.referenced_table_name AS referenced_table, k.referenced_column_name AS referenced_column,
            r.update_rule AS update_rule, r.delete_rule AS delete_rule
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema = k.constraint_schema AND r.table_name = k.table_name AND r.constraint_name = k.constraint_name
     WHERE k.table_schema = DATABASE() AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
     ORDER BY k.constraint_name, k.ordinal_position`,
    [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string; update_rule: string; delete_rule: string }>;
  const actual = new Map<string, { columns: string[]; table: string; referencedColumns: string[]; updateRule: string; deleteRule: string }>();
  for (const row of rows) {
    const foreignKey = actual.get(row.name) ?? {
      columns: [], table: row.referenced_table, referencedColumns: [], updateRule: row.update_rule, deleteRule: row.delete_rule,
    };
    foreignKey.columns.push(row.column_name);
    foreignKey.referencedColumns.push(row.referenced_column);
    actual.set(row.name, foreignKey);
  }
  if (actual.size !== expected.length || expected.some((foreignKey) => {
    const found = actual.get(foreignKey.name);
    return !found || found.table !== foreignKey.table || found.columns.join('\0') !== foreignKey.columns.join('\0') ||
      found.referencedColumns.join('\0') !== foreignKey.referencedColumns.join('\0') ||
      found.updateRule.toUpperCase() !== foreignKey.updateRule || found.deleteRule.toUpperCase() !== foreignKey.deleteRule;
  })) throw new Error(`Migration found an incompatible foreign key on ${table}.`);
}

function tableStep(id: string, table: string, columns: readonly string[], indexes: readonly {
  readonly name: string; readonly columns: readonly string[]; readonly unique: boolean;
}[], sql: string, foreignKeys: readonly ForeignKeyShape[] = []): DdlStep {
  return {
    id, phase: 'expand', sql, definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys,
      verify: [assertExpectedColumns.toString(), verifyIndexes.toString(), verifyForeignKeys.toString()] }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      if (!(await tableExists(queryRunner, table))) return false;
      await assertExpectedColumns(queryRunner, table, columns);
      await verifyIndexes(queryRunner, table, indexes);
      await verifyForeignKeys(queryRunner, table, foreignKeys);
      return true;
    },
  };
}

const commandIndexes = [
  { name: 'PRIMARY', columns: ['id'], unique: true },
  { name: 'uq_ca_meta_connection_command_idempotency', columns: ['tenant_id', 'actor_ref_hash', 'idempotency_key_hash'], unique: true },
  { name: 'uq_ca_meta_connection_command_onboarding', columns: ['onboarding_session_id'], unique: true },
  { name: 'ix_ca_meta_connection_command_asset', columns: ['tenant_id', 'authorization_id', 'asset_id'], unique: false },
  { name: 'ix_ca_meta_connection_command_cleanup', columns: ['tenant_id', 'cleanup_state', 'updated_at'], unique: false },
  { name: 'ix_ca_meta_connection_command_authorization', columns: ['tenant_id', 'authorization_id', 'created_at'], unique: false },
] as const;

const callbackIndexes = [
  { name: 'PRIMARY', columns: ['app_configuration_ref_hash', 'event_ref_hash'], unique: true },
  { name: 'ix_ca_meta_lifecycle_callback_state', columns: ['receipt_state', 'updated_at'], unique: false },
] as const;

const commandForeignKeys: readonly ForeignKeyShape[] = [
  { name: 'fk_ca_meta_connection_command_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants',
    referencedColumns: ['id'], updateRule: 'RESTRICT', deleteRule: 'RESTRICT' },
  { name: 'fk_ca_meta_connection_command_authorization', columns: ['tenant_id', 'authorization_id'],
    table: 'ca_meta_authorizations', referencedColumns: ['tenant_id', 'id'], updateRule: 'RESTRICT', deleteRule: 'RESTRICT' },
  { name: 'fk_ca_meta_connection_command_asset', columns: ['tenant_id', 'authorization_id', 'asset_id'],
    table: 'ca_meta_asset_authorizations', referencedColumns: ['tenant_id', 'authorization_id', 'asset_id'],
    updateRule: 'RESTRICT', deleteRule: 'RESTRICT' },
  { name: 'fk_ca_meta_connection_command_onboarding', columns: ['onboarding_session_id'],
    table: 'ca_meta_onboarding_sessions', referencedColumns: ['id'], updateRule: 'RESTRICT', deleteRule: 'RESTRICT' },
];

const commands = tableStep(
  'create-meta-connection-lifecycle-commands', 'ca_meta_connection_lifecycle_commands', commandColumns, commandIndexes,
  `CREATE TABLE IF NOT EXISTS ca_meta_connection_lifecycle_commands (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    onboarding_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    operation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    local_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    cleanup_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    safe_reason_code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_connection_command_idempotency (tenant_id, actor_ref_hash, idempotency_key_hash),
    UNIQUE KEY uq_ca_meta_connection_command_onboarding (onboarding_session_id),
    KEY ix_ca_meta_connection_command_asset (tenant_id, authorization_id, asset_id),
    KEY ix_ca_meta_connection_command_cleanup (tenant_id, cleanup_state, updated_at),
    KEY ix_ca_meta_connection_command_authorization (tenant_id, authorization_id, created_at),
    CONSTRAINT ck_ca_meta_connection_command_operation CHECK (operation IN ('DISCONNECT_ASSET', 'DISCONNECT_AUTHORIZATION', 'REAUTHORIZE')),
    CONSTRAINT ck_ca_meta_connection_command_local_state CHECK (local_state IN ('DISCONNECTED', 'SESSION_CREATED')),
    CONSTRAINT ck_ca_meta_connection_command_cleanup CHECK (cleanup_state IS NULL OR cleanup_state IN ('BLOCKED', 'PENDING', 'FAILED', 'UNKNOWN', 'CONFIRMED')),
    CONSTRAINT fk_ca_meta_connection_command_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_connection_command_authorization FOREIGN KEY (tenant_id, authorization_id)
      REFERENCES ca_meta_authorizations (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_connection_command_asset FOREIGN KEY (tenant_id, authorization_id, asset_id)
      REFERENCES ca_meta_asset_authorizations (tenant_id, authorization_id, asset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_connection_command_onboarding FOREIGN KEY (onboarding_session_id)
      REFERENCES ca_meta_onboarding_sessions (id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`, commandForeignKeys,
);

const callbacks = tableStep(
  'create-meta-lifecycle-callback-receipts', 'ca_meta_lifecycle_callback_receipts', callbackColumns, callbackIndexes,
  `CREATE TABLE IF NOT EXISTS ca_meta_lifecycle_callback_receipts (
    app_configuration_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    callback_kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    receipt_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (app_configuration_ref_hash, event_ref_hash),
    KEY ix_ca_meta_lifecycle_callback_state (receipt_state, updated_at),
    CONSTRAINT ck_ca_meta_lifecycle_callback_kind CHECK (callback_kind IN ('DEAUTHORIZATION', 'DATA_DELETION')),
    CONSTRAINT ck_ca_meta_lifecycle_callback_state CHECK (receipt_state IN ('RECEIVED', 'APPLIED', 'UNMAPPED'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const definition = {
  id: '202611100020-meta-connection-lifecycle',
  schemaVersion: 20,
  minimumSupportedApiVersion: 1,
  steps: [commands, callbacks],
} as const;

export const CONNECTION_LIFECYCLE_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const CONNECTION_LIFECYCLE_TABLES = [
  'ca_meta_connection_lifecycle_commands', 'ca_meta_lifecycle_callback_receipts',
] as const;
