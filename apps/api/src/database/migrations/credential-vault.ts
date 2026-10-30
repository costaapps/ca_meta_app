import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { MigrationStepContext, VersionedMigration } from './migration.types.js';

const SECRET_COLUMNS = [
  'tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment',
  'ciphertext', 'nonce', 'authentication_tag', 'key_version', 'format_version', 'version', 'created_at', 'updated_at',
] as const;
const ROTATION_COLUMNS = [
  'id', 'target_key_version', 'state', 'cursor_credential_id', 'lease_owner', 'lease_token', 'lease_expires_at',
  'last_safe_error_code', 'created_at', 'updated_at', 'completed_at',
] as const;
const AUDIT_COLUMNS = [
  'id', 'tenant_id', 'credential_id', 'actor_ref', 'action', 'operation', 'key_version', 'correlation_id', 'created_at',
] as const;

async function verifyTable(
  queryRunner: QueryRunner,
  table: string,
  columns: readonly string[],
  indexes: readonly { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }[],
  foreignKeys: readonly { readonly name: string; readonly columns: readonly string[]; readonly table: string; readonly referencedColumns: readonly string[] }[],
): Promise<boolean> {
  if (!(await tableExists(queryRunner, table))) return false;
  if (!(await assertExpectedColumns(queryRunner, table, columns))) return false;
  const indexRows = await queryRunner.query(
    'SELECT index_name AS name, column_name AS columnName, non_unique AS nonUnique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; columnName: string; nonUnique: number | string }>;
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const item = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.nonUnique) === 0 };
    item.columns.push(row.columnName);
    actualIndexes.set(row.name, item);
  }
  if (actualIndexes.size !== indexes.length) return false;
  for (const expected of indexes) {
    const actual = actualIndexes.get(expected.name);
    if (!actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0')) return false;
  }
  const fkRows = await queryRunner.query(
    'SELECT constraint_name AS name, column_name AS columnName, referenced_table_name AS referencedTable, referenced_column_name AS referencedColumn FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position',
    [table],
  ) as Array<{ name: string; columnName: string; referencedTable: string; referencedColumn: string }>;
  const actualForeignKeys = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of fkRows) {
    const item = actualForeignKeys.get(row.name) ?? { columns: [], table: row.referencedTable, referencedColumns: [] };
    item.columns.push(row.columnName);
    item.referencedColumns.push(row.referencedColumn);
    actualForeignKeys.set(row.name, item);
  }
  if (actualForeignKeys.size !== foreignKeys.length) return false;
  return foreignKeys.every((expected) => {
    const actual = actualForeignKeys.get(expected.name);
    return actual?.table === expected.table && actual.columns.join('\0') === expected.columns.join('\0') &&
      actual.referencedColumns.join('\0') === expected.referencedColumns.join('\0');
  });
}

async function verifyCredentialSecrets(context: MigrationStepContext): Promise<boolean> {
  return verifyTable(context.queryRunner, 'ca_meta_credential_secrets', SECRET_COLUMNS,
    [
      { name: 'PRIMARY', columns: ['tenant_id', 'credential_id'], unique: true },
      { name: 'ix_ca_meta_secret_rotation', columns: ['key_version', 'credential_id'], unique: false },
    ],
    [{ name: 'fk_ca_meta_secret_credential', columns: ['tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_credentials', referencedColumns: ['tenant_id', 'id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'] }],
  );
}

async function verifyCredentialRotation(context: MigrationStepContext): Promise<boolean> {
  return verifyTable(context.queryRunner, 'ca_meta_credential_rotations', ROTATION_COLUMNS,
    [
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'uq_ca_meta_rotation_target_key', columns: ['target_key_version'], unique: true },
      { name: 'ix_ca_meta_rotation_state_lease', columns: ['state', 'lease_expires_at'], unique: false },
    ], [],
  );
}

async function verifyCredentialAudit(context: MigrationStepContext): Promise<boolean> {
  return verifyTable(context.queryRunner, 'ca_meta_credential_access_audit', AUDIT_COLUMNS,
    [
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'ix_ca_meta_credential_audit_ref', columns: ['tenant_id', 'credential_id', 'created_at'], unique: false },
    ], [],
  );
}

const createCredentialSecrets = {
  id: 'create-credential-secret-envelope',
  phase: 'expand' as const,
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_credential_secrets', columns: SECRET_COLUMNS, uniqueness: ['tenant_id', 'credential_id'], gcm: 'AES-256-GCM nonce=12 tag=16', aad: ['key_version', 'tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment', 'credential_family'] }),
  retryWhenAbsent: true as const,
  sql: [
    'CREATE TABLE IF NOT EXISTS ca_meta_credential_secrets (',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' ciphertext VARBINARY(16384) NOT NULL, nonce BINARY(12) NOT NULL, authentication_tag BINARY(16) NOT NULL,',
    ' key_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' format_version SMALLINT UNSIGNED NOT NULL DEFAULT 1, version BIGINT UNSIGNED NOT NULL DEFAULT 1,',
    ' created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,',
    ' PRIMARY KEY (tenant_id, credential_id), KEY ix_ca_meta_secret_rotation (key_version, credential_id),',
    ' CONSTRAINT ck_ca_meta_secret_format CHECK (format_version = 1),',
    ' CONSTRAINT fk_ca_meta_secret_credential FOREIGN KEY (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_credentials (tenant_id, id, authorization_id, app_configuration_id, provider, environment)',
    '   ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
  verify: async (context: MigrationStepContext) => verifyCredentialSecrets(context),
};

const createCredentialRotations = {
  id: 'create-credential-key-rotations',
  phase: 'expand' as const,
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_credential_rotations', columns: ROTATION_COLUMNS, lease: 'owner+token+expiry', checkpoint: 'cursor_credential_id' }),
  retryWhenAbsent: true as const,
  sql: [
    'CREATE TABLE IF NOT EXISTS ca_meta_credential_rotations (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' target_key_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' cursor_credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,',
    ' lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,',
    ' lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, lease_expires_at DATETIME(6) NULL,',
    ' last_safe_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,',
    ' created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL, completed_at DATETIME(6) NULL,',
    ' PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_rotation_target_key (target_key_version),',
    ' KEY ix_ca_meta_rotation_state_lease (state, lease_expires_at),',
    ` CONSTRAINT ck_ca_meta_rotation_state CHECK (state IN ('RUNNING', 'PAUSED', 'COMPLETED')),`,
    ' CONSTRAINT ck_ca_meta_rotation_lease CHECK (',
    '   (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL) OR',
    '   (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)',
    ' )',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
  verify: async (context: MigrationStepContext) => verifyCredentialRotation(context),
};

const createCredentialAccessAudit = {
  id: 'create-credential-access-audit',
  phase: 'expand' as const,
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_credential_access_audit', columns: AUDIT_COLUMNS, content: 'metadata-only; no secret, ciphertext, nonce, or provider payload' }),
  retryWhenAbsent: true as const,
  sql: [
    'CREATE TABLE IF NOT EXISTS ca_meta_credential_access_audit (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' actor_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' action VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' operation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' key_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' correlation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,',
    ' created_at DATETIME(6) NOT NULL,',
    ' PRIMARY KEY (id), KEY ix_ca_meta_credential_audit_ref (tenant_id, credential_id, created_at),',
    " CONSTRAINT ck_ca_meta_credential_audit_action CHECK (action IN ('STORE', 'DECRYPT', 'ROTATE'))",
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
  verify: async (context: MigrationStepContext) => verifyCredentialAudit(context),
};

const steps = [createCredentialSecrets, createCredentialRotations, createCredentialAccessAudit] as const;
const migration = {
  id: '202610300009-credential-vault',
  schemaVersion: 9,
  minimumSupportedApiVersion: 1,
  steps,
} as const;

export const META_CREDENTIAL_VAULT_MIGRATION: VersionedMigration = {
  ...migration,
  checksum: migrationChecksum(migration),
};

export const META_CREDENTIAL_VAULT_TABLES = [
  'ca_meta_credential_secrets', 'ca_meta_credential_rotations', 'ca_meta_credential_access_audit',
] as const;
