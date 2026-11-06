import type { DdlStep, MigrationStepContext, VersionedMigration } from './migration.types.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import { migrationChecksum } from './migration-fingerprint.js';

const onboardingColumns = [
  'id', 'tenant_id', 'principal_id', 'portal_session_id', 'tenant_context_hash', 'flow_variant', 'configuration_ref',
  'auth_variant', 'capability_manifest_version', 'graph_api_version', 'saga_checkpoint_json', 'requested_capabilities', 'return_route',
  'idempotency_key_hash', 'request_hash', 'provider_state_hash', 'expires_at', 'status', 'readiness', 'steps_json',
  'next_action', 'created_at', 'last_updated_at', 'provider_state_consumed_at', 'version',
] as const;

async function verifyAddedOnboardingColumn(context: MigrationStepContext, column: string, type: string): Promise<boolean> {
  if (!(await tableExists(context.queryRunner, 'ca_meta_onboarding_sessions'))) return false;
  const rows = await context.queryRunner.query(
    `SELECT column_name, column_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions' AND column_name = ?`,
    [column],
  ) as Array<{ column_name: string; column_type: string; is_nullable: string; column_default: string | null }>;
  const found = rows[0];
  if (!found) return false;
  const expectedType = type.match(/^(VARCHAR\(\d+\)|JSON)/i)?.[1]?.toLowerCase();
  const actualType = found.column_type.toLowerCase();
  const typeMatches = expectedType === 'json' ? actualType === 'json' || actualType === 'longtext' : actualType === expectedType;
  if (!expectedType || !typeMatches || found.is_nullable !== 'NO') {
    throw new Error(`M4.03 migration found an unexpected definition for ca_meta_onboarding_sessions.${column}.`);
  }
  return true;
}

function addOnboardingColumn(column: string, type: string, after: string): DdlStep {
  return {
    id: `add-onboarding-${column.replaceAll('_', '-')}`,
    phase: 'expand',
    sql: `ALTER TABLE ca_meta_onboarding_sessions ADD COLUMN ${column} ${type} AFTER ${after}`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table: 'ca_meta_onboarding_sessions', column, type, after, immutablePriorMigration: '202611030010-persisted-onboarding-sessions' }),
    retryWhenAbsent: true,
    verify: (context) => verifyAddedOnboardingColumn(context, column, type),
  };
}

async function verifyOnboardingTenantKey(context: MigrationStepContext): Promise<boolean> {
  if (!(await tableExists(context.queryRunner, 'ca_meta_onboarding_sessions'))) return false;
  await assertExpectedColumns(context.queryRunner, 'ca_meta_onboarding_sessions', onboardingColumns);
  const rows = await context.queryRunner.query(
    `SELECT column_name AS name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions'
       AND index_name = 'uq_ca_meta_onboarding_tenant_id' AND non_unique = 0
     ORDER BY seq_in_index`,
  ) as Array<{ name: string }>;
  if (rows.length === 0) return false;
  if (rows.map((row) => row.name).join(',') !== 'tenant_id,id') {
    throw new Error('M4.03 migration found an unexpected onboarding tenant candidate key.');
  }
  return true;
}

const addTenantCandidateKey: DdlStep = {
  id: 'add-onboarding-tenant-candidate-key',
  phase: 'expand',
  sql: 'ALTER TABLE ca_meta_onboarding_sessions ADD UNIQUE KEY uq_ca_meta_onboarding_tenant_id (tenant_id, id)',
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_onboarding_sessions', index: 'uq_ca_meta_onboarding_tenant_id', columns: ['tenant_id', 'id'] }),
  retryWhenAbsent: true,
  verify: verifyOnboardingTenantKey,
};

const extendOnboardingRecoveryActions: DdlStep = {
  id: 'extend-onboarding-next-actions',
  phase: 'expand',
  sql: "ALTER TABLE ca_meta_onboarding_sessions MODIFY COLUMN next_action ENUM('WAIT','CHECK_STATUS','REAUTHORIZE','RECONCILE','RESUME','RESOLVE_CONFLICT','NONE') NOT NULL DEFAULT 'WAIT'",
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: 'ca_meta_onboarding_sessions', column: 'next_action',
    enum: ['WAIT', 'CHECK_STATUS', 'REAUTHORIZE', 'RECONCILE', 'RESUME', 'RESOLVE_CONFLICT', 'NONE'],
    default: 'WAIT', purpose: 'Expose safe resume after a reconciled NO_EFFECT result.' }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_onboarding_sessions'))) return false;
    const rows = await queryRunner.query(
      `SELECT column_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions' AND column_name = 'next_action'`,
    ) as Array<{ column_type: string; is_nullable: string; column_default: string | null }>;
    const column = rows[0];
    if (!column) return false;
    const expected = "enum('wait','check_status','reauthorize','reconcile','resume','resolve_conflict','none')";
    if (column.column_type.toLowerCase() !== expected || column.is_nullable !== 'NO' || column.column_default !== 'WAIT') {
      throw new Error('M4.03 migration found an unexpected onboarding next_action definition.');
    }
    return true;
  },
};

const codeColumns = [
  'code_ref', 'tenant_id', 'onboarding_id', 'idempotency_key_hash', 'request_hash', 'code_hash', 'key_version',
  'nonce', 'ciphertext', 'authentication_tag', 'expires_at', 'created_at', 'consumed_at',
] as const;

const codeIndexes = [
  { name: 'PRIMARY', columns: ['code_ref'], unique: true },
  { name: 'uq_ca_meta_onboarding_code_session', columns: ['tenant_id', 'onboarding_id'], unique: true },
  { name: 'uq_ca_meta_onboarding_code_idempotency', columns: ['tenant_id', 'idempotency_key_hash'], unique: true },
  { name: 'ix_ca_meta_onboarding_code_expiry', columns: ['expires_at'], unique: false },
] as const;

const codeForeignKeys = [
  { name: 'fk_ca_meta_onboarding_code_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_onboarding_code_session', columns: ['tenant_id', 'onboarding_id'], table: 'ca_meta_onboarding_sessions', referencedColumns: ['tenant_id', 'id'] },
] as const;

async function verifyCodeIndexes(context: MigrationStepContext): Promise<void> {
  const rows = await context.queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_codes'
     ORDER BY index_name, seq_in_index`,
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of rows) {
    const value = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    value.columns.push(row.column_name);
    actual.set(row.name, value);
  }
  for (const expected of codeIndexes) {
    const found = actual.get(expected.name);
    if (!found || found.unique !== expected.unique || found.columns.join('\0') !== expected.columns.join('\0')) {
      throw new Error(`M4.03 migration found an unexpected index (${expected.name}).`);
    }
  }
}

async function verifyCodeForeignKeys(context: MigrationStepContext): Promise<void> {
  const rows = await context.queryRunner.query(
    `SELECT constraint_name AS name, column_name, referenced_table_name AS referenced_table,
            referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_codes'
       AND referenced_table_name IS NOT NULL
     ORDER BY constraint_name, ordinal_position`,
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actual = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of rows) {
    const value = actual.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    value.columns.push(row.column_name);
    value.referencedColumns.push(row.referenced_column);
    actual.set(row.name, value);
  }
  for (const expected of codeForeignKeys) {
    const found = actual.get(expected.name);
    if (!found || found.table !== expected.table || found.columns.join('\0') !== expected.columns.join('\0') ||
      found.referencedColumns.join('\0') !== expected.referencedColumns.join('\0')) {
      throw new Error(`M4.03 migration found an unexpected foreign key (${expected.name}).`);
    }
  }
}

const createCodeEnvelopes: DdlStep = {
  id: 'create-onboarding-code-envelopes',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_onboarding_codes (
    code_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    onboarding_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    key_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    nonce BINARY(12) NULL,
    ciphertext VARBINARY(16384) NULL,
    authentication_tag BINARY(16) NULL,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    PRIMARY KEY (code_ref),
    UNIQUE KEY uq_ca_meta_onboarding_code_session (tenant_id, onboarding_id),
    UNIQUE KEY uq_ca_meta_onboarding_code_idempotency (tenant_id, idempotency_key_hash),
    KEY ix_ca_meta_onboarding_code_expiry (expires_at),
    CONSTRAINT ck_ca_meta_onboarding_code_version CHECK (key_version > 0),
    CONSTRAINT ck_ca_meta_onboarding_code_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_ca_meta_onboarding_code_envelope CHECK (
      (consumed_at IS NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND authentication_tag IS NOT NULL) OR
      (consumed_at IS NOT NULL AND nonce IS NULL AND ciphertext IS NULL AND authentication_tag IS NULL)
    ),
    CONSTRAINT fk_ca_meta_onboarding_code_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_onboarding_code_session FOREIGN KEY (tenant_id, onboarding_id)
      REFERENCES ca_meta_onboarding_sessions (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: 'ca_meta_onboarding_codes', columns: codeColumns, indexes: codeIndexes, foreignKeys: codeForeignKeys,
    envelope: 'AES-256-GCM; raw code absent; NULL envelope only after atomic one-use consumption; expiry <= onboarding expiry',
    verification: [assertExpectedColumns.toString(), verifyCodeIndexes.toString(), verifyCodeForeignKeys.toString()],
  }),
  retryWhenAbsent: true,
  verify: async (context) => {
    if (!(await tableExists(context.queryRunner, 'ca_meta_onboarding_codes'))) return false;
    await assertExpectedColumns(context.queryRunner, 'ca_meta_onboarding_codes', codeColumns);
    await verifyCodeIndexes(context);
    await verifyCodeForeignKeys(context);
    return true;
  },
};

const definition = {
  id: '202611060014-m4-03-onboarding-saga',
  schemaVersion: 16,
  minimumSupportedApiVersion: 1,
  steps: [
    addOnboardingColumn('configuration_ref', 'VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'unbound\'', 'flow_variant'),
    addOnboardingColumn('auth_variant', "VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'FACEBOOK_LOGIN_FOR_BUSINESS'", 'configuration_ref'),
    addOnboardingColumn('capability_manifest_version', "VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unbound'", 'auth_variant'),
    addOnboardingColumn('graph_api_version', "VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'v0.0'", 'capability_manifest_version'),
    addOnboardingColumn('saga_checkpoint_json', "JSON NOT NULL DEFAULT ('{}')", 'graph_api_version'),
    addTenantCandidateKey,
    extendOnboardingRecoveryActions,
    createCodeEnvelopes,
  ],
} as const;

export const ONBOARDING_SAGA_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const ONBOARDING_CODE_TABLES = ['ca_meta_onboarding_codes'] as const;
