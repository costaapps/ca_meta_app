import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import { migrationChecksum } from './migration-fingerprint.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const columns = [
  'id', 'tenant_id', 'principal_id', 'portal_session_id', 'tenant_context_hash', 'flow_variant',
  'requested_capabilities', 'return_route', 'idempotency_key_hash', 'request_hash', 'provider_state_hash',
  'expires_at', 'status', 'readiness', 'steps_json', 'next_action', 'created_at', 'last_updated_at',
  'provider_state_consumed_at', 'version',
] as const;

const indexes = [
  { name: 'PRIMARY', columns: ['id'], unique: true },
  { name: 'uq_ca_meta_onboarding_idempotency', columns: ['tenant_id', 'idempotency_key_hash'], unique: true },
  { name: 'uq_ca_meta_onboarding_provider_state', columns: ['provider_state_hash'], unique: true },
  { name: 'ix_ca_meta_onboarding_owner', columns: ['tenant_id', 'portal_session_id', 'principal_id'], unique: false },
  { name: 'ix_ca_meta_onboarding_expiry', columns: ['status', 'expires_at'], unique: false },
] as const;

const foreignKeys = [
  { name: 'fk_ca_meta_onboarding_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_onboarding_principal', columns: ['principal_id'], table: 'ca_meta_principals', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_onboarding_portal_session', columns: ['portal_session_id'], table: 'ca_meta_portal_sessions', referencedColumns: ['id'] },
] as const;

async function verifyIndexes(queryRunner: import('typeorm').QueryRunner): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions'
     ORDER BY index_name, seq_in_index`,
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of rows) {
    const value = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    value.columns.push(row.column_name);
    actual.set(row.name, value);
  }
  for (const expected of indexes) {
    const found = actual.get(expected.name);
    if (!found || found.unique !== expected.unique || found.columns.join('\0') !== expected.columns.join('\0')) {
      throw new Error(`Onboarding migration found an unexpected index (${expected.name}).`);
    }
  }
}

async function verifyForeignKeys(queryRunner: import('typeorm').QueryRunner): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT constraint_name AS name, column_name, referenced_table_name AS referenced_table,
            referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions'
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
  for (const expected of foreignKeys) {
    const found = actual.get(expected.name);
    if (!found || found.table !== expected.table || found.columns.join('\0') !== expected.columns.join('\0') ||
      found.referencedColumns.join('\0') !== expected.referencedColumns.join('\0')) {
      throw new Error(`Onboarding migration found an unexpected foreign key (${expected.name}).`);
    }
  }
}

const createOnboardingSessions: DdlStep = {
  id: 'create-persisted-onboarding-sessions',
  phase: 'expand',
  sql: `CREATE TABLE IF NOT EXISTS ca_meta_onboarding_sessions (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    portal_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_context_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    flow_variant ENUM('FACEBOOK_LOGIN','INSTAGRAM_VIA_FACEBOOK_LOGIN','INSTAGRAM_LOGIN','WHATSAPP_CLOUD_API','WHATSAPP_COEXISTENCE') NOT NULL,
    requested_capabilities JSON NOT NULL,
    return_route VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    status ENUM('CREATED','AWAITING_PROVIDER','CODE_RECEIVED','EXCHANGING','ASSETS_VERIFIED','PROVISIONING','READY','PARTIAL','CANCELLED','EXPIRED','FAILED') NOT NULL DEFAULT 'AWAITING_PROVIDER',
    readiness ENUM('READY','PARTIAL','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    steps_json JSON NOT NULL,
    next_action ENUM('WAIT','CHECK_STATUS','REAUTHORIZE','RECONCILE','RESOLVE_CONFLICT','NONE') NOT NULL DEFAULT 'WAIT',
    created_at DATETIME(6) NOT NULL,
    last_updated_at DATETIME(6) NOT NULL,
    provider_state_consumed_at DATETIME(6) NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_onboarding_idempotency (tenant_id, idempotency_key_hash),
    UNIQUE KEY uq_ca_meta_onboarding_provider_state (provider_state_hash),
    KEY ix_ca_meta_onboarding_owner (tenant_id, portal_session_id, principal_id),
    KEY ix_ca_meta_onboarding_expiry (status, expires_at),
    CONSTRAINT ck_ca_meta_onboarding_route CHECK (return_route IN ('connections','setup')),
    CONSTRAINT ck_ca_meta_onboarding_version CHECK (version > 0),
    CONSTRAINT ck_ca_meta_onboarding_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_ca_meta_onboarding_ready CHECK (status <> 'READY' OR readiness = 'READY'),
    CONSTRAINT ck_ca_meta_onboarding_partial CHECK (status <> 'PARTIAL' OR readiness = 'PARTIAL'),
    CONSTRAINT fk_ca_meta_onboarding_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_onboarding_principal FOREIGN KEY (principal_id) REFERENCES ca_meta_principals (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_onboarding_portal_session FOREIGN KEY (portal_session_id) REFERENCES ca_meta_portal_sessions (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: 'ca_meta_onboarding_sessions', columns, indexes, foreignKeys,
    constraints: ['route_allowlist', 'positive_version', 'expires_after_created', 'ready_requires_ready_evidence', 'partial_requires_partial_evidence'],
    secretStorage: 'provider state, idempotency key and request body are represented only by SHA-256 digests; authorization code is never persisted',
    verify: [assertExpectedColumns.toString(), verifyIndexes.toString(), verifyForeignKeys.toString()],
  }),
  retryWhenAbsent: true,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, 'ca_meta_onboarding_sessions'))) return false;
    await assertExpectedColumns(queryRunner, 'ca_meta_onboarding_sessions', columns);
    await verifyIndexes(queryRunner);
    await verifyForeignKeys(queryRunner);
    return true;
  },
};

const definition = {
  id: '202611030010-persisted-onboarding-sessions',
  schemaVersion: 10,
  minimumSupportedApiVersion: 1,
  steps: [createOnboardingSessions],
} as const;

export const ONBOARDING_SESSIONS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const ONBOARDING_SESSION_TABLES = ['ca_meta_onboarding_sessions'] as const;
