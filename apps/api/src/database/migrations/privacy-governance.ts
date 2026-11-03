import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface IndexShape { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }
interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly referencedColumns: readonly string[];
}

async function verifyIndexes(queryRunner: QueryRunner, table: string, expected: readonly IndexShape[]): Promise<void> {
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
      throw new Error(`Migration found an incompatible privacy index on ${table}.${index.name}.`);
    }
  }
}

async function verifyForeignKeys(queryRunner: QueryRunner, table: string, expected: readonly ForeignKeyShape[]): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT constraint_name AS name, column_name AS column_name,
            referenced_table_name AS referenced_table, referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ?
       AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position`, [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actual = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of rows) {
    const fk = actual.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    fk.columns.push(row.column_name);
    fk.referencedColumns.push(row.referenced_column);
    actual.set(row.name, fk);
  }
  for (const fk of expected) {
    const found = actual.get(fk.name);
    if (!found || found.table !== fk.table || found.columns.join('\0') !== fk.columns.join('\0') ||
      found.referencedColumns.join('\0') !== fk.referencedColumns.join('\0')) {
      throw new Error(`Migration found an incompatible privacy foreign key on ${table}.${fk.name}.`);
    }
  }
}

async function triggerExists(queryRunner: QueryRunner, name: string, table: string, event: 'UPDATE' | 'DELETE'): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT action_timing, event_manipulation, event_object_table, action_statement
     FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?`, [name],
  ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
  if (!rows[0]) return false;
  const row = rows[0];
  const statement = row.action_statement.toUpperCase().replace(/[\s`]+/g, '');
  if (row.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== table ||
    statement !== "SIGNALSQLSTATE'45000'SETMESSAGE_TEXT='APPEND-ONLYPRIVACYAUDIT'") {
    throw new Error(`Migration found an incompatible privacy append-only trigger: ${name}.`);
  }
  return true;
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
    id, phase: 'expand', sql, definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys, verify: [verifyIndexes.toString(), verifyForeignKeys.toString()] }),
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

function appendOnly(table: string, event: 'UPDATE' | 'DELETE'): DdlStep {
  const name = `tr_${table.slice('ca_meta_'.length)}_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only privacy audit'";
  return {
    id: `${table}-no-${event.toLowerCase()}`, phase: 'expand',
    sql: `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW ${statement}`,
    definitionVersion: 'v1', definition: JSON.stringify({ name, table, event, statement }), retryWhenAbsent: true,
    verify: ({ queryRunner }) => triggerExists(queryRunner, name, table, event),
  };
}

const auditEvents = tableStep('create-privacy-audit-events', 'ca_meta_audit_events',
  ['id', 'tenant_id', 'actor_ref_hash', 'action', 'target_ref', 'correlation_id', 'safe_diff', 'retention_class', 'policy_version', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_audit_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'ix_ca_meta_audit_tenant_created', columns: ['tenant_id', 'created_at', 'id'], unique: false },
    { name: 'ix_ca_meta_audit_tenant_target', columns: ['tenant_id', 'target_ref', 'created_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_audit_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_audit_events (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    correlation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    safe_diff JSON NOT NULL,
    retention_class VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_audit_tenant_id (tenant_id, id),
    KEY ix_ca_meta_audit_tenant_created (tenant_id, created_at, id),
    KEY ix_ca_meta_audit_tenant_target (tenant_id, target_ref, created_at),
    CONSTRAINT ck_ca_meta_audit_action CHECK (action IN ('AUTHORIZATION_CONNECTED', 'AUTHORIZATION_REAUTHORIZED', 'AUTHORIZATION_OBSERVED', 'ASSET_OPERATION', 'AUTHORIZATION_DISCONNECTED', 'AUTHORIZATION_DENIED', 'RETENTION_POLICY_CREATED', 'RETENTION_POLICY_ACTIVATED', 'RETENTION_PURGE_STARTED', 'RETENTION_PURGE_BATCH', 'DELETION_REQUESTED', 'DELETION_STATUS_CHANGED', 'SUPPORT_DIAGNOSTIC_ACCESS')),
    CONSTRAINT ck_ca_meta_audit_retention CHECK (retention_class IN ('SECURITY', 'OPERATIONS', 'DELETION', 'SUPPORT')),
    CONSTRAINT ck_ca_meta_audit_diff CHECK (JSON_VALID(safe_diff) AND JSON_TYPE(safe_diff) = 'OBJECT'),
    CONSTRAINT fk_ca_meta_audit_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const retentionPolicies = tableStep('create-retention-policies', 'ca_meta_retention_policies',
  ['id', 'tenant_id', 'environment', 'category', 'retention_seconds', 'policy_version', 'status', 'approval_ref', 'created_by_ref_hash', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_retention_policy_version', columns: ['tenant_id', 'environment', 'category', 'policy_version'], unique: true },
    { name: 'uq_ca_meta_retention_policy_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'ix_ca_meta_retention_policy_active', columns: ['tenant_id', 'environment', 'category', 'status'], unique: false },
  ],
  [{ name: 'fk_ca_meta_retention_policy_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_retention_policies (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    category VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    retention_seconds INT UNSIGNED NOT NULL,
    policy_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'DRAFT',
    approval_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    created_by_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_retention_policy_version (tenant_id, environment, category, policy_version),
    UNIQUE KEY uq_ca_meta_retention_policy_tenant_id (tenant_id, id),
    KEY ix_ca_meta_retention_policy_active (tenant_id, environment, category, status),
    CONSTRAINT ck_ca_meta_retention_environment CHECK (environment IN ('development', 'test', 'staging', 'production')),
    CONSTRAINT ck_ca_meta_retention_category CHECK (category = 'MAGIC_LINK_TRANSIENT'),
    CONSTRAINT ck_ca_meta_retention_duration CHECK (retention_seconds > 0),
    CONSTRAINT ck_ca_meta_retention_status CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED')),
    CONSTRAINT ck_ca_meta_retention_approval CHECK ((status = 'ACTIVE' AND approval_ref IS NOT NULL) OR status <> 'ACTIVE'),
    CONSTRAINT fk_ca_meta_retention_policy_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const retentionRuns = tableStep('create-retention-purge-runs', 'ca_meta_retention_purge_runs',
  ['id', 'tenant_id', 'policy_id', 'environment', 'category', 'cutoff_at', 'phase', 'cursor_ref', 'status', 'deleted_count', 'created_at', 'updated_at', 'completed_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_retention_run_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'ix_ca_meta_retention_run_tenant_status', columns: ['tenant_id', 'status', 'created_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_retention_run_policy', columns: ['tenant_id', 'policy_id'], table: 'ca_meta_retention_policies', referencedColumns: ['tenant_id', 'id'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_retention_purge_runs (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    category VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    cutoff_at DATETIME(6) NOT NULL,
    phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'MAIL_QUEUE',
    cursor_ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'RUNNING',
    deleted_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    completed_at DATETIME(6) NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_retention_run_tenant_id (tenant_id, id),
    KEY ix_ca_meta_retention_run_tenant_status (tenant_id, status, created_at),
    CONSTRAINT ck_ca_meta_retention_run_category CHECK (category = 'MAGIC_LINK_TRANSIENT'),
    CONSTRAINT ck_ca_meta_retention_run_phase CHECK (phase IN ('MAIL_QUEUE', 'LINKS', 'COMPLETE')),
    CONSTRAINT ck_ca_meta_retention_run_status CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED')),
    CONSTRAINT fk_ca_meta_retention_run_policy FOREIGN KEY (tenant_id, policy_id) REFERENCES ca_meta_retention_policies (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const deletionRequests = tableStep('create-deletion-requests', 'ca_meta_deletion_requests',
  ['id', 'tenant_id', 'requester_ref_hash', 'target_ref_hash', 'scope', 'reason_code', 'status', 'idempotency_key', 'request_hash', 'evidence_ref', 'requested_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_deletion_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_deletion_idempotency', columns: ['tenant_id', 'requester_ref_hash', 'idempotency_key'], unique: true },
    { name: 'ix_ca_meta_deletion_tenant_status', columns: ['tenant_id', 'status', 'requested_at'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_deletion_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_deletion_evidence', columns: ['tenant_id', 'evidence_ref'], table: 'ca_meta_audit_events', referencedColumns: ['tenant_id', 'id'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_deletion_requests (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    requester_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    scope VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason_code VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'RECEIVED',
    idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    evidence_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    requested_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_deletion_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_deletion_idempotency (tenant_id, requester_ref_hash, idempotency_key),
    KEY ix_ca_meta_deletion_tenant_status (tenant_id, status, requested_at),
    CONSTRAINT ck_ca_meta_deletion_scope CHECK (scope IN ('TENANT_DATA', 'AUTHORIZATION', 'ASSET', 'MESSAGE_HISTORY')),
    CONSTRAINT ck_ca_meta_deletion_reason CHECK (reason_code IN ('ACCOUNT_CLOSURE', 'PRIVACY_REQUEST', 'DISCONNECTION')),
    CONSTRAINT ck_ca_meta_deletion_status CHECK (status IN ('RECEIVED', 'ASSESSED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED')),
    CONSTRAINT fk_ca_meta_deletion_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_deletion_evidence FOREIGN KEY (tenant_id, evidence_ref) REFERENCES ca_meta_audit_events (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const deletionTombstones = tableStep('create-deletion-tombstones', 'ca_meta_deletion_tombstones',
  ['id', 'tenant_id', 'request_id', 'target_ref_hash', 'scope', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_tombstone_tenant_scope_target', columns: ['tenant_id', 'scope', 'target_ref_hash'], unique: true },
    { name: 'ix_ca_meta_tombstone_tenant_request', columns: ['tenant_id', 'request_id'], unique: false },
  ],
  [{ name: 'fk_ca_meta_tombstone_request', columns: ['tenant_id', 'request_id'], table: 'ca_meta_deletion_requests', referencedColumns: ['tenant_id', 'id'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_deletion_tombstones (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    scope VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_tombstone_tenant_scope_target (tenant_id, scope, target_ref_hash),
    KEY ix_ca_meta_tombstone_tenant_request (tenant_id, request_id),
    CONSTRAINT ck_ca_meta_tombstone_scope CHECK (scope IN ('TENANT_DATA', 'AUTHORIZATION', 'ASSET', 'MESSAGE_HISTORY')),
    CONSTRAINT fk_ca_meta_tombstone_request FOREIGN KEY (tenant_id, request_id) REFERENCES ca_meta_deletion_requests (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const tables = [auditEvents, retentionPolicies, retentionRuns, deletionRequests, deletionTombstones] as const;
const definition = {
  id: '202611030012-privacy-retention-deletion', schemaVersion: 12, minimumSupportedApiVersion: 1,
  steps: [
    ...tables,
    appendOnly('ca_meta_audit_events', 'UPDATE'), appendOnly('ca_meta_audit_events', 'DELETE'),
    appendOnly('ca_meta_deletion_tombstones', 'UPDATE'), appendOnly('ca_meta_deletion_tombstones', 'DELETE'),
  ],
} as const;

export const PRIVACY_GOVERNANCE_MIGRATION: VersionedMigration = {
  ...definition, checksum: migrationChecksum(definition),
};

export const PRIVACY_GOVERNANCE_TABLES = [
  'ca_meta_audit_events', 'ca_meta_retention_policies', 'ca_meta_retention_purge_runs',
  'ca_meta_deletion_requests', 'ca_meta_deletion_tombstones',
] as const;
