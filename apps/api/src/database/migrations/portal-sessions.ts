import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface ExpectedIndex { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean; }
interface ExpectedForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly referencedColumns: readonly string[];
}

async function verifyIndexes(queryRunner: QueryRunner, table: string, expected: readonly ExpectedIndex[]): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique
     FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY index_name, seq_in_index`, [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of rows) {
    const index = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actual.set(row.name, index);
  }
  for (const index of expected) {
    const found = actual.get(index.name);
    if (!found || found.unique !== index.unique || found.columns.join('\0') !== index.columns.join('\0')) {
      throw new Error(`Migration preflight found an unexpected index on ${table} (${index.name}).`);
    }
  }
}

async function verifyForeignKeys(queryRunner: QueryRunner, table: string, expected: readonly ExpectedForeignKey[]): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT constraint_name AS name, column_name AS column_name,
            referenced_table_name AS referenced_table, referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL
     ORDER BY constraint_name, ordinal_position`, [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actual = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of rows) {
    const foreignKey = actual.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    foreignKey.columns.push(row.column_name);
    foreignKey.referencedColumns.push(row.referenced_column);
    actual.set(row.name, foreignKey);
  }
  for (const foreignKey of expected) {
    const found = actual.get(foreignKey.name);
    if (!found || found.table !== foreignKey.table || found.columns.join('\0') !== foreignKey.columns.join('\0') ||
      found.referencedColumns.join('\0') !== foreignKey.referencedColumns.join('\0')) {
      throw new Error(`Migration preflight found an unexpected foreign key on ${table} (${foreignKey.name}).`);
    }
  }
}

function tableStep(
  id: string,
  table: string,
  columns: readonly string[],
  indexes: readonly ExpectedIndex[],
  sql: string,
  foreignKeys: readonly ExpectedForeignKey[] = [],
): DdlStep {
  return {
    id,
    phase: 'expand',
    sql,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys, verify: [assertExpectedColumns.toString(), verifyIndexes.toString(), verifyForeignKeys.toString()] }),
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

const preAuth = tableStep(
  'create-portal-pre-auth',
  'ca_meta_portal_pre_auth',
  ['id', 'challenge_hash', 'browser_cookie_hash', 'entry_mode', 'created_at', 'expires_at', 'consumed_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_portal_pre_auth_challenge', columns: ['challenge_hash'], unique: true },
    { name: 'ix_ca_meta_portal_pre_auth_expiry', columns: ['expires_at', 'consumed_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_portal_pre_auth (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    challenge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    browser_cookie_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    entry_mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_portal_pre_auth_challenge (challenge_hash),
    KEY ix_ca_meta_portal_pre_auth_expiry (expires_at, consumed_at),
    CONSTRAINT ck_ca_meta_portal_pre_auth_mode CHECK (entry_mode IN ('PORTAL_TOP_LEVEL', 'SUITE4_EMBED')),
    CONSTRAINT ck_ca_meta_portal_pre_auth_expiry CHECK (expires_at > created_at)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const portalSessionColumns = [
  'id', 'principal_id', 'tenant_id', 'secret_hash', 'csrf_token_hash', 'context_ref_hash', 'context_version',
  'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'revoked_at',
] as const;
const portalSessionColumnsWithEntryMode = [
  'id', 'principal_id', 'tenant_id', 'secret_hash', 'csrf_token_hash', 'context_ref_hash', 'context_version',
  'entry_mode', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'revoked_at',
] as const;
const portalSessionIndexes = [
  { name: 'PRIMARY', columns: ['id'], unique: true },
  { name: 'uq_ca_meta_portal_session_secret', columns: ['secret_hash'], unique: true },
  { name: 'ix_ca_meta_portal_session_principal', columns: ['principal_id', 'revoked_at', 'created_at'], unique: false },
  { name: 'ix_ca_meta_portal_session_expiry', columns: ['idle_expires_at', 'absolute_expires_at'], unique: false },
] as const;
const portalSessionForeignKeys = [
  { name: 'fk_ca_meta_portal_session_principal', columns: ['principal_id'], table: 'ca_meta_principals', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_portal_session_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
] as const;

const sessions = tableStep(
  'create-portal-sessions',
  'ca_meta_portal_sessions',
  portalSessionColumns,
  portalSessionIndexes,
  `CREATE TABLE IF NOT EXISTS ca_meta_portal_sessions (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    secret_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    csrf_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    context_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    context_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    last_seen_at DATETIME(6) NOT NULL,
    idle_expires_at DATETIME(6) NOT NULL,
    absolute_expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_portal_session_secret (secret_hash),
    KEY ix_ca_meta_portal_session_principal (principal_id, revoked_at, created_at),
    KEY ix_ca_meta_portal_session_expiry (idle_expires_at, absolute_expires_at),
    CONSTRAINT ck_ca_meta_portal_session_context CHECK (context_version > 0),
    CONSTRAINT ck_ca_meta_portal_session_expiry CHECK (idle_expires_at <= absolute_expires_at),
    CONSTRAINT fk_ca_meta_portal_session_principal FOREIGN KEY (principal_id) REFERENCES ca_meta_principals (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_portal_session_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  portalSessionForeignKeys,
);

/** Verify the v5 portal-session structure after the additive v9 entry_mode migration. */
export async function verifyPortalSessionTableWithEntryMode(queryRunner: QueryRunner): Promise<boolean> {
  const table = 'ca_meta_portal_sessions';
  if (!(await tableExists(queryRunner, table))) return false;
  await assertExpectedColumns(queryRunner, table, portalSessionColumnsWithEntryMode);
  await verifyIndexes(queryRunner, table, portalSessionIndexes);
  await verifyForeignKeys(queryRunner, table, portalSessionForeignKeys);
  return true;
}

const ticketJtiColumns = ['issuer', 'jti_hash', 'pre_auth_id', 'session_id', 'ticket_expires_at', 'consumed_at'] as const;
const ticketJtiIndexes = [
  { name: 'PRIMARY', columns: ['issuer', 'jti_hash'], unique: true },
  { name: 'ix_ca_meta_portal_jti_expiry', columns: ['ticket_expires_at'], unique: false },
] as const;
const ticketJtiForeignKeys = [
  { name: 'fk_ca_meta_portal_jti_preauth', columns: ['pre_auth_id'], table: 'ca_meta_portal_pre_auth', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_portal_jti_session', columns: ['session_id'], table: 'ca_meta_portal_sessions', referencedColumns: ['id'] },
] as const;

const ticketJtis = tableStep(
  'create-portal-ticket-jtis',
  'ca_meta_portal_ticket_jtis',
  ticketJtiColumns,
  ticketJtiIndexes,
  `CREATE TABLE IF NOT EXISTS ca_meta_portal_ticket_jtis (
    issuer VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    jti_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    pre_auth_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ticket_expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NOT NULL,
    PRIMARY KEY (issuer, jti_hash),
    KEY ix_ca_meta_portal_jti_expiry (ticket_expires_at),
    CONSTRAINT fk_ca_meta_portal_jti_preauth FOREIGN KEY (pre_auth_id) REFERENCES ca_meta_portal_pre_auth (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_portal_jti_session FOREIGN KEY (session_id) REFERENCES ca_meta_portal_sessions (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  ticketJtiForeignKeys,
);

/** Validate the table's exact schema for a migration version without rewriting the checksummed v5 verifier. */
export async function verifyPortalTicketJtiTableShape(
  queryRunner: QueryRunner,
  version: 'v5' | 'v6',
): Promise<boolean> {
  const table = 'ca_meta_portal_ticket_jtis';
  if (!(await tableExists(queryRunner, table))) return false;
  const expected = version === 'v5'
    ? ticketJtiColumns
    : ['issuer', 'jti_hash', 'ticket_sha256', 'pre_auth_id', 'session_id', 'ticket_expires_at', 'consumed_at'];
  const actual = await tableColumns(queryRunner, table);
  if (actual.length !== expected.length || expected.some((column, index) => actual[index] !== column)) {
    throw new Error(`Migration preflight found an unexpected shape for table ${table} (${actual.join(',')}).`);
  }
  await verifyIndexes(queryRunner, table, ticketJtiIndexes);
  await verifyForeignKeys(queryRunner, table, ticketJtiForeignKeys);
  return true;
}

const abuseBuckets = tableStep(
  'create-abuse-limit-buckets',
  'ca_meta_abuse_limit_buckets',
  ['policy', 'dimension_hash', 'window_start', 'request_count', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['policy', 'dimension_hash', 'window_start'], unique: true },
    { name: 'ix_ca_meta_abuse_limit_updated', columns: ['updated_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_abuse_limit_buckets (
    policy VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    dimension_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    window_start DATETIME(6) NOT NULL,
    request_count INT UNSIGNED NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (policy, dimension_hash, window_start),
    KEY ix_ca_meta_abuse_limit_updated (updated_at),
    CONSTRAINT ck_ca_meta_abuse_limit_count CHECK (request_count > 0)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const definition = {
  id: '202610300002-portal-sessions-and-abuse-limits',
  schemaVersion: 5,
  minimumSupportedApiVersion: 1,
  steps: [preAuth, sessions, ticketJtis, abuseBuckets],
} as const;

export const PORTAL_SESSIONS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const PORTAL_SESSION_TABLES = [
  'ca_meta_portal_pre_auth',
  'ca_meta_portal_sessions',
  'ca_meta_portal_ticket_jtis',
  'ca_meta_abuse_limit_buckets',
] as const;
