import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface ExpectedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

interface ExpectedForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly referencedColumns: readonly string[];
}

const principalsColumns = ['id', 'kind', 'issuer', 'subject', 'status', 'version', 'created_at', 'updated_at'] as const;
const membershipsColumns = ['tenant_id', 'principal_id', 'principal_kind', 'roles', 'status', 'version', 'created_at', 'updated_at', 'revoked_at'] as const;
const serviceScopeColumns = ['tenant_id', 'principal_id', 'principal_kind', 'scope', 'status', 'created_at', 'revoked_at'] as const;
const adminAuditColumns = ['id', 'authority_kind', 'actor_ref', 'tenant_id', 'action', 'target_principal_id', 'reason_code', 'idempotency_key', 'request_hash', 'result_tenant_id', 'created_at'] as const;

async function verifyKeys(
  queryRunner: QueryRunner,
  table: string,
  indexes: readonly ExpectedIndex[],
  foreignKeys: readonly ExpectedForeignKey[],
): Promise<boolean> {
  const indexRows = await queryRunner.query(
    `SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY index_name, seq_in_index`,
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const current = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    current.columns.push(row.column_name);
    actualIndexes.set(row.name, current);
  }
  for (const expected of indexes) {
    const actual = actualIndexes.get(expected.name);
    if (!actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0')) {
      throw new Error(`Migration preflight found an unexpected index on ${table} (${expected.name}).`);
    }
  }

  const foreignKeyRows = await queryRunner.query(
    `SELECT constraint_name AS name, column_name AS column_name,
            referenced_table_name AS referenced_table,
            referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL
     ORDER BY constraint_name, ordinal_position`,
    [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actualForeignKeys = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of foreignKeyRows) {
    const current = actualForeignKeys.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    current.columns.push(row.column_name);
    current.referencedColumns.push(row.referenced_column);
    actualForeignKeys.set(row.name, current);
  }
  for (const expected of foreignKeys) {
    const actual = actualForeignKeys.get(expected.name);
    if (
      !actual ||
      actual.table !== expected.table ||
      actual.columns.join('\0') !== expected.columns.join('\0') ||
      actual.referencedColumns.join('\0') !== expected.referencedColumns.join('\0')
    ) {
      throw new Error(`Migration preflight found an unexpected foreign key on ${table} (${expected.name}).`);
    }
  }
  return true;
}

function createTableStep(
  id: string,
  table: string,
  columns: readonly string[],
  indexes: readonly ExpectedIndex[],
  foreignKeys: readonly ExpectedForeignKey[],
  sql: string,
): DdlStep {
  return {
    id,
    phase: 'expand',
    sql,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys, verify: [assertExpectedColumns.toString(), verifyKeys.toString()] }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      if (!(await tableExists(queryRunner, table))) return false;
      await assertExpectedColumns(queryRunner, table, columns);
      await verifyKeys(queryRunner, table, indexes, foreignKeys);
      return true;
    },
  };
}

const principals = createTableStep(
  'create-principals',
  'ca_meta_principals',
  principalsColumns,
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_principal_identity', columns: ['issuer', 'subject'], unique: true },
    { name: 'uq_ca_meta_principal_kind_id', columns: ['kind', 'id'], unique: true },
  ],
  [],
  `CREATE TABLE IF NOT EXISTS ca_meta_principals (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_principal_identity (issuer, subject),
    UNIQUE KEY uq_ca_meta_principal_kind_id (kind, id),
    CONSTRAINT ck_ca_meta_principal_kind CHECK (kind IN ('USER', 'SERVICE')),
    CONSTRAINT ck_ca_meta_principal_status CHECK (status IN ('ACTIVE', 'DISABLED'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const memberships = createTableStep(
  'create-tenant-memberships',
  'ca_meta_memberships',
  membershipsColumns,
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'principal_id'], unique: true },
    { name: 'ix_ca_meta_memberships_principal_status', columns: ['principal_id', 'status'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_membership_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_membership_principal', columns: ['principal_kind', 'principal_id'], table: 'ca_meta_principals', referencedColumns: ['kind', 'id'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_memberships (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'USER',
    roles JSON NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'INVITED',
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    PRIMARY KEY (tenant_id, principal_id),
    KEY ix_ca_meta_memberships_principal_status (principal_id, status),
    CONSTRAINT ck_ca_meta_membership_user CHECK (principal_kind = 'USER'),
    CONSTRAINT ck_ca_meta_membership_roles CHECK (
      JSON_VALID(roles) AND JSON_TYPE(roles) = 'ARRAY' AND JSON_LENGTH(roles) BETWEEN 1 AND 4 AND
      JSON_LENGTH(roles) = JSON_CONTAINS(roles, JSON_QUOTE('owner')) + JSON_CONTAINS(roles, JSON_QUOTE('admin')) +
        JSON_CONTAINS(roles, JSON_QUOTE('operator')) + JSON_CONTAINS(roles, JSON_QUOTE('viewer'))
    ),
    CONSTRAINT ck_ca_meta_membership_status CHECK (status IN ('INVITED', 'ACTIVE', 'REVOKED', 'SUSPENDED')),
    CONSTRAINT fk_ca_meta_membership_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_membership_principal FOREIGN KEY (principal_kind, principal_id)
      REFERENCES ca_meta_principals (kind, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const serviceScopes = createTableStep(
  'create-service-identity-scopes',
  'ca_meta_service_identity_scopes',
  serviceScopeColumns,
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'principal_id', 'scope'], unique: true },
    { name: 'ix_ca_meta_service_scope_principal_status', columns: ['principal_id', 'status'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_service_scope_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_service_scope_principal', columns: ['principal_kind', 'principal_id'], table: 'ca_meta_principals', referencedColumns: ['kind', 'id'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_service_identity_scopes (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'SERVICE',
    scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    PRIMARY KEY (tenant_id, principal_id, scope),
    KEY ix_ca_meta_service_scope_principal_status (principal_id, status),
    CONSTRAINT ck_ca_meta_service_scope_kind CHECK (principal_kind = 'SERVICE'),
    CONSTRAINT ck_ca_meta_service_scope_status CHECK (status IN ('ACTIVE', 'REVOKED')),
    CONSTRAINT fk_ca_meta_service_scope_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_service_scope_principal FOREIGN KEY (principal_kind, principal_id)
      REFERENCES ca_meta_principals (kind, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const identityAdminAudit = createTableStep(
  'create-identity-admin-audit',
  'ca_meta_identity_admin_audit',
  adminAuditColumns,
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_identity_admin_idem', columns: ['actor_ref', 'idempotency_key'], unique: true },
    { name: 'ix_ca_meta_identity_admin_tenant_created', columns: ['tenant_id', 'created_at'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_identity_admin_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_identity_admin_target', columns: ['target_principal_id'], table: 'ca_meta_principals', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_identity_admin_result_tenant', columns: ['result_tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_identity_admin_audit (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authority_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_ref CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    reason_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result_tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_identity_admin_idem (actor_ref, idempotency_key),
    KEY ix_ca_meta_identity_admin_tenant_created (tenant_id, created_at),
    CONSTRAINT ck_ca_meta_identity_admin_authority CHECK (authority_kind IN ('PLATFORM_IDENTITY_ADMIN', 'TENANT_OWNER', 'TENANT_ADMIN')),
    CONSTRAINT ck_ca_meta_identity_admin_action CHECK (action IN ('BOOTSTRAP_TENANT', 'GRANT_MEMBERSHIP', 'REVOKE_MEMBERSHIP')),
    CONSTRAINT ck_ca_meta_identity_admin_reason CHECK (reason_code IN ('INITIAL_PROVISIONING', 'MEMBERSHIP_GRANT', 'ROLE_CHANGE', 'MEMBERSHIP_REVOCATION')),
    CONSTRAINT fk_ca_meta_identity_admin_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_identity_admin_target FOREIGN KEY (target_principal_id) REFERENCES ca_meta_principals (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_identity_admin_result_tenant FOREIGN KEY (result_tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

function auditAppendOnlyTrigger(id: string, event: 'UPDATE' | 'DELETE'): DdlStep {
  const name = `tr_ca_meta_identity_admin_audit_no_${event.toLowerCase()}`;
  return {
    id,
    phase: 'expand',
    sql: `CREATE TRIGGER ${name} BEFORE ${event} ON ca_meta_identity_admin_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity administration audit is append-only'`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ name, table: 'ca_meta_identity_admin_audit', event, appendOnly: true }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      const rows = await queryRunner.query(
        `SELECT action_timing, event_manipulation, event_object_table
         FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?`, [name],
      ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string }>;
      if (rows.length === 0) return false;
      const row = rows[0];
      if (row?.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== 'ca_meta_identity_admin_audit') {
        throw new Error(`Migration preflight found an unexpected identity audit trigger (${name}).`);
      }
      return true;
    },
  };
}

const auditNoUpdate = auditAppendOnlyTrigger('identity-admin-audit-no-update', 'UPDATE');
const auditNoDelete = auditAppendOnlyTrigger('identity-admin-audit-no-delete', 'DELETE');

const identityMigrationDefinition = {
  id: '202610300001-principals-memberships',
  schemaVersion: 4,
  minimumSupportedApiVersion: 1,
  steps: [principals, memberships, serviceScopes, identityAdminAudit, auditNoUpdate, auditNoDelete],
};

export const IDENTITY_MIGRATION: VersionedMigration = {
  ...identityMigrationDefinition,
  checksum: migrationChecksum(identityMigrationDefinition),
};
