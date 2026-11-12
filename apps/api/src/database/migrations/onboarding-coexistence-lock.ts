import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { BackfillStep, DdlStep, MigrationStepContext, VersionedMigration } from './migration.types.js';

const tableName = 'ca_meta_onboarding_coexistence_locks';
const columns = ['tenant_id', 'onboarding_session_id', 'expires_at', 'created_at'] as const;
const indexes = [
  { name: 'PRIMARY', columns: ['tenant_id'], unique: true },
  { name: 'uq_ca_meta_onboarding_coexistence_session', columns: ['tenant_id', 'onboarding_session_id'], unique: true },
  { name: 'ix_ca_meta_onboarding_coexistence_expiry', columns: ['tenant_id', 'expires_at'], unique: false },
] as const;

async function verifyIndexes(queryRunner: QueryRunner): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique
     FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY index_name, seq_in_index`, [tableName],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of rows) {
    const index = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actual.set(row.name, index);
  }
  if (actual.size !== indexes.length || indexes.some((expected) => {
    const found = actual.get(expected.name);
    return !found || found.unique !== expected.unique || found.columns.join('\0') !== expected.columns.join('\0');
  })) throw new Error('Migration found an incompatible index on the Coexistence onboarding lock table.');
}

async function verifyForeignKeys(queryRunner: QueryRunner): Promise<void> {
  const rows = await queryRunner.query(
    `SELECT constraint_name AS name, column_name, referenced_table_name AS referenced_table,
            referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ?
       AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position`, [tableName],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actual = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of rows) {
    const value = actual.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    value.columns.push(row.column_name);
    value.referencedColumns.push(row.referenced_column);
    actual.set(row.name, value);
  }
  const expected = [
    { name: 'fk_ca_meta_coexistence_lock_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
    { name: 'fk_ca_meta_coexistence_lock_session', columns: ['tenant_id', 'onboarding_session_id'],
      table: 'ca_meta_onboarding_sessions', referencedColumns: ['tenant_id', 'id'] },
  ];
  if (actual.size !== expected.length || expected.some((shape) => {
    const found = actual.get(shape.name);
    return !found || found.table !== shape.table || found.columns.join('\0') !== shape.columns.join('\0') ||
      found.referencedColumns.join('\0') !== shape.referencedColumns.join('\0');
  })) throw new Error('Migration found an incompatible tenant/session foreign key on the Coexistence lock table.');
}

async function verifyTable(queryRunner: QueryRunner): Promise<boolean> {
  if (!(await tableExists(queryRunner, tableName))) return false;
  await assertExpectedColumns(queryRunner, tableName, columns);
  await verifyIndexes(queryRunner);
  await verifyForeignKeys(queryRunner);
  return true;
}

const validateExistingSessions = {
  id: 'validate-single-active-coexistence-session-per-tenant',
  phase: 'validate' as const,
  definitionVersion: 'v1',
  definition: JSON.stringify({ flow: 'WHATSAPP_COEXISTENCE', activeStatuses: ['CREATED', 'AWAITING_PROVIDER', 'CODE_RECEIVED',
    'EXCHANGING', 'ASSETS_VERIFIED', 'PROVISIONING', 'PARTIAL'], uniqueness: 'tenant_id' }),
  validate: async ({ queryRunner }: MigrationStepContext) => {
    const rows = await queryRunner.query(
      `SELECT tenant_id FROM ca_meta_onboarding_sessions
       WHERE flow_variant = 'WHATSAPP_COEXISTENCE'
         AND status IN ('CREATED','AWAITING_PROVIDER','CODE_RECEIVED','EXCHANGING','ASSETS_VERIFIED','PROVISIONING','PARTIAL')
         AND expires_at > UTC_TIMESTAMP(6)
       GROUP BY tenant_id HAVING COUNT(*) > 1 LIMIT 1`,
    ) as Array<{ tenant_id: string }>;
    if (rows.length > 0) throw new Error('Migration cannot add the Coexistence lock while a tenant has multiple active onboarding sessions.');
  },
};

const createLocks: DdlStep = {
  id: 'create-onboarding-coexistence-locks',
  phase: 'expand',
  definitionVersion: 'v1',
  definition: JSON.stringify({ table: tableName, columns, indexes, foreignKeys: [
    ['tenant_id', 'ca_meta_tenants', 'id'], ['tenant_id,onboarding_session_id', 'ca_meta_onboarding_sessions', 'tenant_id,id'],
  ], verify: [assertExpectedColumns.toString(), verifyIndexes.toString(), verifyForeignKeys.toString()] }),
  retryWhenAbsent: true,
  sql: `CREATE TABLE IF NOT EXISTS ${tableName} (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    onboarding_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id),
    UNIQUE KEY uq_ca_meta_onboarding_coexistence_session (tenant_id, onboarding_session_id),
    KEY ix_ca_meta_onboarding_coexistence_expiry (tenant_id, expires_at),
    CONSTRAINT fk_ca_meta_coexistence_lock_tenant FOREIGN KEY (tenant_id)
      REFERENCES ca_meta_tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_coexistence_lock_session FOREIGN KEY (tenant_id, onboarding_session_id)
      REFERENCES ca_meta_onboarding_sessions (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  verify: async ({ queryRunner }) => verifyTable(queryRunner),
};

const backfillLocks: BackfillStep = {
  id: 'backfill-active-onboarding-coexistence-locks',
  phase: 'backfill',
  definitionVersion: 'v1',
  definition: JSON.stringify({ source: 'ca_meta_onboarding_sessions', destination: tableName,
    filter: "WHATSAPP_COEXISTENCE and active and not expired", cursor: 'tenant_id', batchSize: 100 }),
  batchSize: 100,
  runBatch: async ({ queryRunner }, cursor, batchSize) => {
    const cursorFilter = cursor === null ? '' : 'AND tenant_id > ?';
    const parameters = cursor === null ? [batchSize] : [cursor, batchSize];
    const rows = await queryRunner.query(
      `SELECT tenant_id, id, expires_at FROM ca_meta_onboarding_sessions
       WHERE flow_variant = 'WHATSAPP_COEXISTENCE'
         AND status IN ('CREATED','AWAITING_PROVIDER','CODE_RECEIVED','EXCHANGING','ASSETS_VERIFIED','PROVISIONING','PARTIAL')
         AND expires_at > UTC_TIMESTAMP(6) ${cursorFilter}
       ORDER BY tenant_id LIMIT ?`, parameters,
    ) as Array<{ tenant_id: string; id: string; expires_at: string | Date }>;
    for (const row of rows) {
      await queryRunner.query(
        `INSERT IGNORE INTO ${tableName} (tenant_id, onboarding_session_id, expires_at, created_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP(6))`, [row.tenant_id, row.id, row.expires_at],
      );
    }
    return { nextCursor: rows.at(-1)?.tenant_id ?? cursor, done: rows.length < batchSize };
  },
};

const terminalRelease: DdlStep = {
  id: 'release-coexistence-lock-on-terminal-onboarding-status',
  phase: 'expand',
  definitionVersion: 'v1',
  definition: JSON.stringify({ trigger: 'tr_ca_meta_onboarding_coexistence_lock_release', table: 'ca_meta_onboarding_sessions',
    timing: 'AFTER UPDATE', terminal: ['READY', 'CANCELLED', 'EXPIRED', 'FAILED'], action: 'delete matching tenant/session lock' }),
  retryWhenAbsent: true,
  sql: `CREATE TRIGGER tr_ca_meta_onboarding_coexistence_lock_release
    AFTER UPDATE ON ca_meta_onboarding_sessions FOR EACH ROW
    DELETE FROM ${tableName}
    WHERE tenant_id = NEW.tenant_id AND onboarding_session_id = NEW.id
      AND NEW.status IN ('READY','CANCELLED','EXPIRED','FAILED')`,
  verify: async ({ queryRunner }) => {
    if (!(await tableExists(queryRunner, tableName))) throw new Error('Coexistence lock table is missing before terminal-release trigger verification.');
    const rows = await queryRunner.query(
      `SELECT action_timing, event_manipulation, event_object_table, action_statement
       FROM information_schema.triggers WHERE trigger_schema = DATABASE()
         AND trigger_name = 'tr_ca_meta_onboarding_coexistence_lock_release'`,
    ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
    if (rows.length === 0) return false;
    const row = rows[0]!;
    const normalize = (value: string) => value.toUpperCase().replace(/[\s`]+/g, '');
    if (row.action_timing !== 'AFTER' || row.event_manipulation !== 'UPDATE' ||
        row.event_object_table !== 'ca_meta_onboarding_sessions' ||
        !normalize(row.action_statement).includes('DELETEFROMCA_META_ONBOARDING_COEXISTENCE_LOCKS') ||
        !normalize(row.action_statement).includes('TENANT_ID=NEW.TENANT_ID') ||
        !normalize(row.action_statement).includes('ONBOARDING_SESSION_ID=NEW.ID') ||
        !normalize(row.action_statement).includes("NEW.STATUSIN('READY','CANCELLED','EXPIRED','FAILED')")) {
      throw new Error('Migration found an incompatible terminal-release trigger for the Coexistence lock.');
    }
    return true;
  },
};

const definition = {
  id: '202611120022-onboarding-coexistence-serialization',
  schemaVersion: 22,
  minimumSupportedApiVersion: 1,
  steps: [validateExistingSessions, createLocks, backfillLocks, terminalRelease],
} as const;

export const ONBOARDING_COEXISTENCE_LOCK_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const ONBOARDING_COEXISTENCE_LOCK_TABLES = [tableName] as const;
