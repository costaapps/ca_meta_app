import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface ExpectedIndex { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean; }
interface ExpectedForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly referencedColumns: readonly string[];
}

async function verifyIndexes(queryRunner: import('typeorm').QueryRunner, table: string, expected: readonly ExpectedIndex[]): Promise<void> {
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
      throw new Error(`Magic-link migration found an unexpected index on ${table} (${index.name}).`);
    }
  }
}

async function verifyForeignKeys(
  queryRunner: import('typeorm').QueryRunner,
  table: string,
  expected: readonly ExpectedForeignKey[],
): Promise<void> {
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
      throw new Error(`Magic-link migration found an unexpected foreign key on ${table} (${foreignKey.name}).`);
    }
  }
}

function tableStep(
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

const identityAssociations = tableStep(
  'create-magic-link-identity-associations',
  'ca_meta_magic_link_identities',
  ['email_hash', 'principal_id', 'verified_at', 'revoked_at', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['email_hash'], unique: true },
    { name: 'ix_ca_meta_magic_identity_principal', columns: ['principal_id', 'revoked_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_magic_identity_principal', columns: ['principal_id'], table: 'ca_meta_principals', referencedColumns: ['id'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_magic_link_identities (
    email_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    verified_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (email_hash),
    KEY ix_ca_meta_magic_identity_principal (principal_id, revoked_at),
    CONSTRAINT fk_ca_meta_magic_identity_principal FOREIGN KEY (principal_id) REFERENCES ca_meta_principals (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const magicLinks = tableStep(
  'create-magic-links',
  'ca_meta_magic_links',
  ['id', 'token_hash', 'purpose', 'principal_id', 'tenant_id', 'membership_version', 'created_at', 'expires_at', 'attempt_count', 'max_attempts', 'consumed_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_magic_link_token_hash', columns: ['token_hash'], unique: true },
    { name: 'ix_ca_meta_magic_link_expiry', columns: ['expires_at', 'consumed_at'], unique: false },
    { name: 'ix_ca_meta_magic_link_membership', columns: ['tenant_id', 'principal_id', 'purpose'], unique: false },
  ],
  [{ name: 'fk_ca_meta_magic_link_membership', columns: ['tenant_id', 'principal_id'], table: 'ca_meta_memberships', referencedColumns: ['tenant_id', 'principal_id'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_magic_links (
    id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    purpose VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    membership_version BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
    consumed_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_magic_link_token_hash (token_hash),
    KEY ix_ca_meta_magic_link_expiry (expires_at, consumed_at),
    KEY ix_ca_meta_magic_link_membership (tenant_id, principal_id, purpose),
    CONSTRAINT ck_ca_meta_magic_link_purpose CHECK (purpose = 'PORTAL_LOGIN'),
    CONSTRAINT ck_ca_meta_magic_link_attempts CHECK (max_attempts BETWEEN 1 AND 10 AND attempt_count <= max_attempts),
    CONSTRAINT ck_ca_meta_magic_link_membership_version CHECK (membership_version > 0),
    CONSTRAINT ck_ca_meta_magic_link_expiry CHECK (expires_at > created_at),
    CONSTRAINT fk_ca_meta_magic_link_membership FOREIGN KEY (tenant_id, principal_id)
      REFERENCES ca_meta_memberships (tenant_id, principal_id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const mailQueue = tableStep(
  'create-magic-link-mail-queue',
  'ca_meta_magic_link_mail_queue',
  ['id', 'magic_link_id', 'tenant_id', 'request_fingerprint', 'window_start', 'recipient_ciphertext', 'status', 'attempt_count', 'max_attempts', 'available_at', 'lease_owner', 'lease_expires_at', 'created_at', 'delivered_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_magic_mail_link', columns: ['magic_link_id'], unique: true },
    { name: 'uq_ca_meta_magic_mail_request', columns: ['tenant_id', 'request_fingerprint', 'window_start'], unique: true },
    { name: 'ix_ca_meta_magic_mail_ready', columns: ['status', 'available_at', 'created_at'], unique: false },
    { name: 'ix_ca_meta_magic_mail_lease', columns: ['status', 'lease_expires_at'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_magic_mail_link', columns: ['magic_link_id'], table: 'ca_meta_magic_links', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_magic_mail_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_magic_link_mail_queue (
    id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    magic_link_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    window_start DATETIME(0) NOT NULL,
    recipient_ciphertext VARBINARY(512) NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 1,
    available_at DATETIME(6) NOT NULL,
    lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_expires_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    delivered_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_magic_mail_link (magic_link_id),
    UNIQUE KEY uq_ca_meta_magic_mail_request (tenant_id, request_fingerprint, window_start),
    KEY ix_ca_meta_magic_mail_ready (status, available_at, created_at),
    KEY ix_ca_meta_magic_mail_lease (status, lease_expires_at),
    CONSTRAINT ck_ca_meta_magic_mail_status CHECK (status IN ('QUEUED', 'PROCESSING', 'DELIVERED', 'DEAD')),
    CONSTRAINT ck_ca_meta_magic_mail_attempts CHECK (max_attempts = 1 AND attempt_count <= max_attempts),
    CONSTRAINT fk_ca_meta_magic_mail_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_magic_mail_link FOREIGN KEY (magic_link_id) REFERENCES ca_meta_magic_links (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const definition = {
  id: '202610300008-magic-link-invitations',
  schemaVersion: 8,
  minimumSupportedApiVersion: 1,
  steps: [identityAssociations, magicLinks, mailQueue],
} as const;

export const MAGIC_LINKS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const MAGIC_LINK_TABLES = [
  'ca_meta_magic_link_identities',
  'ca_meta_magic_links',
  'ca_meta_magic_link_mail_queue',
] as const;
