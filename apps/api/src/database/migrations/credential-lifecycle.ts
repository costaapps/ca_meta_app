import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

const LIFECYCLE_COLUMNS = [
  'tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment',
  'issued_at', 'expires_at', 'expiry_state', 'data_access_expires_at', 'health_state', 'health_source', 'health_observed_at',
  'expiry_source', 'expiry_observed_at', 'data_access_expiry_source', 'data_access_expiry_observed_at',
  'last_checked_at', 'last_safe_reason_code', 'next_check_at', 'check_attempts', 'schedule_generation',
  'version', 'lease_owner', 'lease_token', 'lease_expires_at', 'created_at', 'updated_at',
] as const;
const REAUTH_COLUMNS = [
  'id', 'tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment',
  'dedupe_key', 'reason_code', 'status', 'occurrences', 'version', 'created_at', 'updated_at', 'resolved_at',
] as const;

interface IndexShape { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }
interface ForeignKeyShape { readonly name: string; readonly columns: readonly string[]; readonly table: string; readonly referencedColumns: readonly string[] }

const FLOW_VARIANT_TYPE = "enum('FACEBOOK','INSTAGRAM','WHATSAPP_EXCLUSIVE','WHATSAPP_COEXISTENCE')";
const AUTH_VARIANT_TYPE = "enum('FACEBOOK_LOGIN_FOR_BUSINESS','INSTAGRAM_LOGIN','WHATSAPP_EMBEDDED_SIGNUP','WHATSAPP_BUSINESS_APP_ONBOARDING')";
const AUTHORIZATION_COLUMNS_WITH_FLOW = [
  'id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'flow_variant', 'auth_variant',
  'provider_authorization_id', 'authorization_state', 'version', 'observed_at', 'created_at', 'updated_at',
] as const;
const AUTHORIZATION_INDEXES: readonly IndexShape[] = [
  { name: 'PRIMARY', columns: ['id'], unique: true },
  { name: 'uq_ca_meta_authorization_context', columns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'], unique: true },
  { name: 'uq_ca_meta_authorization_tenant_id', columns: ['tenant_id', 'id'], unique: true },
  { name: 'uq_ca_meta_authorization_external', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment', 'provider_authorization_id'], unique: true },
  { name: 'ix_ca_meta_authorization_tenant_state', columns: ['tenant_id', 'authorization_state', 'updated_at'], unique: false },
];
const AUTHORIZATION_FOREIGN_KEYS: readonly ForeignKeyShape[] = [
  { name: 'fk_ca_meta_authorization_app', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'],
    table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] },
];

async function verifyAuthorizationFlowContext(queryRunner: QueryRunner): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT column_name, data_type, column_type, is_nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_authorizations'
       AND column_name IN ('flow_variant', 'auth_variant') ORDER BY column_name`,
  ) as Array<{ column_name: string; data_type: string; column_type: string; is_nullable: string }>;
  if (rows.length === 0) return false;
  if (rows.length !== 2 || rows.some((row) => row.data_type !== 'enum' || row.is_nullable !== 'YES' ||
      (row.column_name === 'flow_variant' && row.column_type !== FLOW_VARIANT_TYPE) ||
      (row.column_name === 'auth_variant' && row.column_type !== AUTH_VARIANT_TYPE))) {
    throw new Error('Migration found an incompatible authorization flow/auth variant shape.');
  }
  return true;
}

async function verifyAuthorizationTableWithFlowContext({ queryRunner }: import('./migration.types.js').MigrationStepContext): Promise<boolean> {
  if (!(await verifyAuthorizationFlowContext(queryRunner))) return false;
  return verifyTable(queryRunner, 'ca_meta_authorizations', AUTHORIZATION_COLUMNS_WITH_FLOW,
    AUTHORIZATION_INDEXES, AUTHORIZATION_FOREIGN_KEYS);
}

const compatibleAuthorizationPriorSteps: NonNullable<DdlStep['compatiblePriorSteps']> = [{
  migrationId: '202610300005-meta-assets-grants-relations',
  stepId: 'create-meta-authorizations',
  verify: verifyAuthorizationTableWithFlowContext,
}];

const addAuthorizationFlowContext: DdlStep = {
  id: 'add-authorization-flow-auth-context',
  phase: 'expand',
  definitionVersion: 'v1',
  definition: JSON.stringify({
    table: 'ca_meta_authorizations',
    columns: [
      { name: 'flow_variant', type: FLOW_VARIANT_TYPE, nullable: true },
      { name: 'auth_variant', type: AUTH_VARIANT_TYPE, nullable: true },
    ],
    purpose: 'Select credential policy from exact server-persisted flow/auth/family context; existing rows stay unknown.',
    verify: verifyAuthorizationTableWithFlowContext.toString(),
    compatiblePriorSteps: compatibleAuthorizationPriorSteps.map(({ migrationId, stepId, verify }) => ({
      migrationId, stepId, verify: verify.toString(),
    })),
  }),
  retryWhenAbsent: true,
  sql: `ALTER TABLE ca_meta_authorizations
    ADD COLUMN flow_variant ${FLOW_VARIANT_TYPE} NULL AFTER environment,
    ADD COLUMN auth_variant ${AUTH_VARIANT_TYPE} NULL AFTER flow_variant`,
  verify: verifyAuthorizationTableWithFlowContext,
  compatiblePriorSteps: compatibleAuthorizationPriorSteps,
};

async function verifyTable(queryRunner: QueryRunner, table: string, columns: readonly string[],
  indexes: readonly IndexShape[], foreignKeys: readonly ForeignKeyShape[]): Promise<boolean> {
  if (!(await tableExists(queryRunner, table))) return false;
  if (!(await assertExpectedColumns(queryRunner, table, columns))) return false;
  const indexRows = await queryRunner.query(
    'SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const item = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    item.columns.push(row.column_name);
    actualIndexes.set(row.name, item);
  }
  if (actualIndexes.size !== indexes.length || indexes.some((expected) => {
    const actual = actualIndexes.get(expected.name);
    return !actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0');
  })) return false;
  const fkRows = await queryRunner.query(
    'SELECT constraint_name AS name, column_name AS column_name, referenced_table_name AS referenced_table, referenced_column_name AS referenced_column FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position',
    [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actualFks = new Map<string, { columns: string[]; table: string; referenced: string[] }>();
  for (const row of fkRows) {
    const item = actualFks.get(row.name) ?? { columns: [], table: row.referenced_table, referenced: [] };
    item.columns.push(row.column_name); item.referenced.push(row.referenced_column); actualFks.set(row.name, item);
  }
  if (actualFks.size !== foreignKeys.length || foreignKeys.some((expected) => {
    const actual = actualFks.get(expected.name);
    return !actual || actual.table !== expected.table || actual.columns.join('\0') !== expected.columns.join('\0') ||
      actual.referenced.join('\0') !== expected.referencedColumns.join('\0');
  })) return false;
  return true;
}

function tableStep(id: string, table: string, columns: readonly string[], indexes: readonly IndexShape[],
  foreignKeys: readonly ForeignKeyShape[], sql: string): DdlStep {
  return {
    id,
    phase: 'expand',
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys, sql }),
    retryWhenAbsent: true,
    sql,
    verify: async ({ queryRunner }) => verifyTable(queryRunner, table, columns, indexes, foreignKeys),
  };
}

const createLifecycle = tableStep('create-credential-lifecycle', 'ca_meta_credential_lifecycle', LIFECYCLE_COLUMNS,
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'credential_id'], unique: true },
    { name: 'ix_ca_meta_credential_lifecycle_due', columns: ['next_check_at', 'lease_expires_at', 'tenant_id', 'credential_id'], unique: false },
  ],
  [{ name: 'fk_ca_meta_lifecycle_credential', columns: ['tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'],
    table: 'ca_meta_credentials', referencedColumns: ['tenant_id', 'id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_credential_lifecycle (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at DATETIME(6) NULL, expires_at DATETIME(6) NULL,
    expiry_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'UNKNOWN',
    data_access_expires_at DATETIME(6) NULL,
    health_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'UNKNOWN',
    health_source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL, health_observed_at DATETIME(6) NULL,
    expiry_source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL, expiry_observed_at DATETIME(6) NULL,
    data_access_expiry_source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    data_access_expiry_observed_at DATETIME(6) NULL,
    last_checked_at DATETIME(6) NULL, last_safe_reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    next_check_at DATETIME(6) NULL, check_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    schedule_generation BIGINT UNSIGNED NOT NULL DEFAULT 0, version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, lease_expires_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, credential_id),
    KEY ix_ca_meta_credential_lifecycle_due (next_check_at, lease_expires_at, tenant_id, credential_id),
    CONSTRAINT ck_ca_meta_lifecycle_health CHECK (health_state IN ('HEALTHY','EXPIRING','EXPIRED','REVOKED','ACTION_REQUIRED','UNKNOWN','STALE')),
    CONSTRAINT ck_ca_meta_lifecycle_expiry CHECK (expiry_state IN ('KNOWN','PROVIDER_NO_EXPIRY','UNKNOWN','STALE')),
    CONSTRAINT ck_ca_meta_lifecycle_lease CHECK ((lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL) OR
      (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CONSTRAINT fk_ca_meta_lifecycle_credential FOREIGN KEY (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_credentials (tenant_id, id, authorization_id, app_configuration_id, provider, environment)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const createReauthIntent = tableStep('create-credential-reauth-intents', 'ca_meta_credential_reauth_intents', REAUTH_COLUMNS,
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_reauth_dedupe', columns: ['tenant_id', 'dedupe_key'], unique: true },
    { name: 'ix_ca_meta_reauth_pending', columns: ['tenant_id', 'status', 'updated_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_reauth_credential', columns: ['tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'],
    table: 'ca_meta_credentials', referencedColumns: ['tenant_id', 'id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_credential_reauth_intents (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    dedupe_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    occurrences INT UNSIGNED NOT NULL DEFAULT 1, version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL, resolved_at DATETIME(6) NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_reauth_dedupe (tenant_id, dedupe_key),
    KEY ix_ca_meta_reauth_pending (tenant_id, status, updated_at),
    CONSTRAINT ck_ca_meta_reauth_status CHECK (status IN ('PENDING','ACKNOWLEDGED','RESOLVED')),
    CONSTRAINT fk_ca_meta_reauth_credential FOREIGN KEY (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_credentials (tenant_id, id, authorization_id, app_configuration_id, provider, environment)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const definition = {
  id: '202611030013-credential-lifecycle', schemaVersion: 13, minimumSupportedApiVersion: 1,
  steps: [addAuthorizationFlowContext, createLifecycle, createReauthIntent],
} as const;

export const CREDENTIAL_LIFECYCLE_MIGRATION: VersionedMigration = { ...definition, checksum: migrationChecksum(definition) };
export const CREDENTIAL_LIFECYCLE_TABLES = ['ca_meta_credential_lifecycle', 'ca_meta_credential_reauth_intents'] as const;
