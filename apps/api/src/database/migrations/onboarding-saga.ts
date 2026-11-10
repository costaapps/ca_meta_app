import type { DdlStep, MigrationStepContext, VersionedMigration } from './migration.types.js';
import { assertExpectedColumns, tableColumns, tableExists } from './schema-inspection.js';
import { migrationChecksum } from './migration-fingerprint.js';

const onboardingColumns = [
  'id', 'tenant_id', 'principal_id', 'portal_session_id', 'tenant_context_hash', 'flow_variant', 'configuration_ref',
  'provider_app_id', 'provider_environment',
  'auth_variant', 'capability_manifest_version', 'graph_api_version', 'saga_checkpoint_json', 'requested_capabilities', 'return_route',
  'idempotency_key_hash', 'request_hash', 'provider_state_hash', 'expires_at', 'status', 'readiness', 'steps_json',
  'next_action', 'created_at', 'last_updated_at', 'provider_state_consumed_at', 'version',
] as const;

const priorOnboardingColumns = [
  'id', 'tenant_id', 'principal_id', 'portal_session_id', 'tenant_context_hash', 'flow_variant',
  'requested_capabilities', 'return_route', 'idempotency_key_hash', 'request_hash', 'provider_state_hash',
  'expires_at', 'status', 'readiness', 'steps_json', 'next_action', 'created_at', 'last_updated_at',
  'provider_state_consumed_at', 'version',
] as const;
interface OnboardingColumnShape {
  readonly columnTypes: readonly string[];
  readonly nullable: 'YES' | 'NO';
  readonly defaults: readonly (string | null)[];
  readonly characterSets: readonly (string | null)[];
  readonly collations: readonly (string | null)[];
}

function onboardingColumnShape(
  columnType: string | readonly string[],
  nullable: 'YES' | 'NO',
  defaultValue: string | null | readonly (string | null)[],
  characterSet: string | null | readonly (string | null)[] = null,
  collation: string | null | readonly (string | null)[] = null,
): OnboardingColumnShape {
  return {
    columnTypes: typeof columnType === 'string' ? [columnType] : columnType,
    nullable,
    defaults: Array.isArray(defaultValue) ? defaultValue : [defaultValue as string | null],
    characterSets: Array.isArray(characterSet) ? characterSet : [characterSet as string | null],
    collations: Array.isArray(collation) ? collation : [collation as string | null],
  };
}

const jsonOnboardingColumnShape = (defaultValue: string | null | readonly (string | null)[]): OnboardingColumnShape =>
  onboardingColumnShape(['json', 'longtext'], 'NO', defaultValue, [null, 'utf8mb4'], [null, 'utf8mb4_bin']);

const priorOnboardingColumnShapes: Readonly<Record<string, OnboardingColumnShape>> = {
  id: onboardingColumnShape('char(36)', 'NO', null, 'ascii', 'ascii_bin'),
  tenant_id: onboardingColumnShape('char(36)', 'NO', null, 'ascii', 'ascii_bin'),
  principal_id: onboardingColumnShape('char(36)', 'NO', null, 'ascii', 'ascii_bin'),
  portal_session_id: onboardingColumnShape('char(36)', 'NO', null, 'ascii', 'ascii_bin'),
  tenant_context_hash: onboardingColumnShape('char(64)', 'NO', null, 'ascii', 'ascii_bin'),
  flow_variant: onboardingColumnShape(
    "enum('FACEBOOK_LOGIN','INSTAGRAM_VIA_FACEBOOK_LOGIN','INSTAGRAM_LOGIN','WHATSAPP_CLOUD_API','WHATSAPP_COEXISTENCE')",
    'NO', null, 'utf8mb4', 'utf8mb4_bin'),
  requested_capabilities: jsonOnboardingColumnShape(null),
  return_route: onboardingColumnShape('varchar(16)', 'NO', null, 'ascii', 'ascii_bin'),
  idempotency_key_hash: onboardingColumnShape('char(64)', 'NO', null, 'ascii', 'ascii_bin'),
  request_hash: onboardingColumnShape('char(64)', 'NO', null, 'ascii', 'ascii_bin'),
  provider_state_hash: onboardingColumnShape('char(64)', 'NO', null, 'ascii', 'ascii_bin'),
  expires_at: onboardingColumnShape('datetime(6)', 'NO', null),
  status: onboardingColumnShape(
    "enum('CREATED','AWAITING_PROVIDER','CODE_RECEIVED','EXCHANGING','ASSETS_VERIFIED','PROVISIONING','READY','PARTIAL','CANCELLED','EXPIRED','FAILED')",
    'NO', "'AWAITING_PROVIDER'", 'utf8mb4', 'utf8mb4_bin'),
  readiness: onboardingColumnShape("enum('READY','PARTIAL','UNKNOWN')", 'NO', "'UNKNOWN'", 'utf8mb4', 'utf8mb4_bin'),
  steps_json: jsonOnboardingColumnShape(null),
  next_action: onboardingColumnShape([
    "enum('WAIT','CHECK_STATUS','REAUTHORIZE','RECONCILE','RESOLVE_CONFLICT','NONE')",
    "enum('WAIT','CHECK_STATUS','REAUTHORIZE','RECONCILE','RESUME','RESOLVE_CONFLICT','NONE')",
  ], 'NO', "'WAIT'", 'utf8mb4', 'utf8mb4_bin'),
  created_at: onboardingColumnShape('datetime(6)', 'NO', null),
  last_updated_at: onboardingColumnShape('datetime(6)', 'NO', null),
  provider_state_consumed_at: onboardingColumnShape('datetime(6)', 'YES', 'NULL'),
  version: onboardingColumnShape(['bigint unsigned', 'bigint(20) unsigned'], 'NO', '1'),
};

const addedOnboardingColumnShapes: Readonly<Record<string, OnboardingColumnShape>> = {
  configuration_ref: onboardingColumnShape('varchar(96)', 'NO', "'unbound'", 'ascii', 'ascii_bin'),
  provider_app_id: onboardingColumnShape('varchar(512)', 'NO', "'unbound'", 'utf8mb4', 'utf8mb4_nopad_bin'),
  provider_environment: onboardingColumnShape('varchar(16)', 'NO', "'unbound'", 'ascii', 'ascii_bin'),
  auth_variant: onboardingColumnShape('varchar(48)', 'NO', "'FACEBOOK_LOGIN_FOR_BUSINESS'", 'ascii', 'ascii_bin'),
  capability_manifest_version: onboardingColumnShape('varchar(96)', 'NO', "'unbound'", 'ascii', 'ascii_bin'),
  graph_api_version: onboardingColumnShape('varchar(16)', 'NO', "'v0.0'", 'ascii', 'ascii_bin'),
  saga_checkpoint_json: jsonOnboardingColumnShape(["'{}'", "('{}')"]),
};

function normalizeOnboardingColumnType(value: string): string {
  const normalized = value.replace(/'[^']*'|[^']+/g, (part) => part.startsWith("'") ? part : part.toLowerCase());
  return normalized.replace(/^bigint\(\d+\) unsigned$/u, 'bigint unsigned');
}

function normalizeCheckClause(value: string): string {
  return value.toLowerCase().replaceAll('`', '').replaceAll(/\s+/gu, '').replace(/^\((.*)\)$/u, '$1');
}
const priorOnboardingIndexes = [
  { name: 'PRIMARY', columns: ['id'], unique: true },
  { name: 'uq_ca_meta_onboarding_idempotency', columns: ['tenant_id', 'idempotency_key_hash'], unique: true },
  { name: 'uq_ca_meta_onboarding_provider_state', columns: ['provider_state_hash'], unique: true },
  { name: 'ix_ca_meta_onboarding_owner', columns: ['tenant_id', 'portal_session_id', 'principal_id'], unique: false },
  { name: 'ix_ca_meta_onboarding_expiry', columns: ['status', 'expires_at'], unique: false },
] as const;
const priorOnboardingForeignKeyIndexes = [
  { name: 'fk_ca_meta_onboarding_principal', columns: ['principal_id'], unique: false },
  { name: 'fk_ca_meta_onboarding_portal_session', columns: ['portal_session_id'], unique: false },
] as const;
const priorOnboardingForeignKeys = [
  { name: 'fk_ca_meta_onboarding_tenant', columns: ['tenant_id'], table: 'ca_meta_tenants', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_onboarding_principal', columns: ['principal_id'], table: 'ca_meta_principals', referencedColumns: ['id'] },
  { name: 'fk_ca_meta_onboarding_portal_session', columns: ['portal_session_id'], table: 'ca_meta_portal_sessions', referencedColumns: ['id'] },
] as const;

interface OnboardingColumnMetadata {
  readonly column_name: string;
  readonly column_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly character_set_name: string | null;
  readonly collation_name: string | null;
}

function assertOnboardingColumnDefinition(column: string, actual: OnboardingColumnMetadata, expected: OnboardingColumnShape): void {
  const actualType = normalizeOnboardingColumnType(actual.column_type);
  const expectedTypes = expected.columnTypes.map(normalizeOnboardingColumnType);
  if (!expectedTypes.includes(actualType) || actual.is_nullable !== expected.nullable ||
      !expected.defaults.includes(actual.column_default) || !expected.characterSets.includes(actual.character_set_name) ||
      !expected.collations.includes(actual.collation_name)) {
    throw new Error(`M4.03 migration found an unexpected definition for ca_meta_onboarding_sessions.${column}.`);
  }
}

async function verifyOnboardingColumnDefinition(
  context: MigrationStepContext,
  column: string,
  expected: OnboardingColumnShape,
): Promise<boolean> {
  const rows = await context.queryRunner.query(
    `SELECT column_name, column_type, is_nullable, column_default, character_set_name, collation_name
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions' AND column_name = ?`,
    [column],
  ) as OnboardingColumnMetadata[];
  const found = rows[0];
  if (!found) return false;
  assertOnboardingColumnDefinition(column, found, expected);
  return true;
}

async function verifyAddedOnboardingColumn(context: MigrationStepContext, column: string): Promise<boolean> {
  if (!(await tableExists(context.queryRunner, 'ca_meta_onboarding_sessions'))) return false;
  const expected = addedOnboardingColumnShapes[column];
  if (!expected) throw new Error(`M4.03 migration has no expected definition for ca_meta_onboarding_sessions.${column}.`);
  return verifyOnboardingColumnDefinition(context, column, expected);
}

function addOnboardingColumn(
  column: string,
  type: string,
  after: string,
  compatiblePriorSteps?: DdlStep['compatiblePriorSteps'],
): DdlStep {
  return {
    id: `add-onboarding-${column.replaceAll('_', '-')}`,
    phase: 'expand',
    sql: `ALTER TABLE ca_meta_onboarding_sessions ADD COLUMN ${column} ${type} AFTER ${after}`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table: 'ca_meta_onboarding_sessions', column, type, after,
      immutablePriorMigration: '202611030010-persisted-onboarding-sessions',
      compatiblePriorSteps: compatiblePriorSteps?.map(({ migrationId, stepId, verify }) => ({ migrationId, stepId, verify: verify.toString() })) }),
    retryWhenAbsent: true,
    verify: (context) => verifyAddedOnboardingColumn(context, column),
    ...(compatiblePriorSteps ? { compatiblePriorSteps } : {}),
  };
}

async function verifyCompatibleOnboardingSessionPriorShape(context: MigrationStepContext): Promise<boolean> {
  const { queryRunner } = context;
  if (!(await tableExists(queryRunner, 'ca_meta_onboarding_sessions'))) return false;

  const actualColumns = await tableColumns(queryRunner, 'ca_meta_onboarding_sessions');
  const priorColumnSet = new Set<string>(priorOnboardingColumns);
  const additionalColumns = actualColumns.filter((column) => !priorColumnSet.has(column));
  const priorColumnsRemainOrdered = actualColumns
    .filter((column) => priorColumnSet.has(column)).join('\0') === priorOnboardingColumns.join('\0');
  if (!priorColumnsRemainOrdered || additionalColumns.some((column) => !Object.hasOwn(addedOnboardingColumnShapes, column))) {
    throw new Error('M4.03 migration found an incompatible additive onboarding session shape.');
  }
  for (const column of priorOnboardingColumns) {
    const expected = priorOnboardingColumnShapes[column];
    if (!expected || !(await verifyOnboardingColumnDefinition(context, column, expected))) {
      throw new Error(`M4.03 migration could not verify prior onboarding column ${column}.`);
    }
  }
  for (const column of additionalColumns) {
    await verifyAddedOnboardingColumn(context, column);
  }

  const indexRows = await queryRunner.query(
    `SELECT index_name AS name, column_name, non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions'
     ORDER BY index_name, seq_in_index`,
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const index = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actualIndexes.set(row.name, index);
  }
  const tenantKey = actualIndexes.get('uq_ca_meta_onboarding_tenant_id');
  const expectedIndexes = [...priorOnboardingIndexes, ...priorOnboardingForeignKeyIndexes];
  if (actualIndexes.size !== expectedIndexes.length + (tenantKey ? 1 : 0) ||
      expectedIndexes.some((expected) => {
        const actual = actualIndexes.get(expected.name);
        return !actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0');
      }) || (tenantKey && (!tenantKey.unique || tenantKey.columns.join('\0') !== 'tenant_id\0id'))) {
    throw new Error('M4.03 migration found an incompatible additive onboarding index shape.');
  }

  const foreignKeyRows = await queryRunner.query(
    `SELECT constraint_name AS name, column_name, referenced_table_name AS referenced_table,
            referenced_column_name AS referenced_column
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = 'ca_meta_onboarding_sessions'
       AND referenced_table_name IS NOT NULL
     ORDER BY constraint_name, ordinal_position`,
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actualForeignKeys = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of foreignKeyRows) {
    const foreignKey = actualForeignKeys.get(row.name) ?? {
      columns: [], table: row.referenced_table, referencedColumns: [],
    };
    foreignKey.columns.push(row.column_name);
    foreignKey.referencedColumns.push(row.referenced_column);
    actualForeignKeys.set(row.name, foreignKey);
  }
  if (actualForeignKeys.size !== priorOnboardingForeignKeys.length || priorOnboardingForeignKeys.some((expected) => {
    const actual = actualForeignKeys.get(expected.name);
    return !actual || actual.table !== expected.table || actual.columns.join('\0') !== expected.columns.join('\0') ||
      actual.referencedColumns.join('\0') !== expected.referencedColumns.join('\0');
  })) {
    throw new Error('M4.03 migration found an incompatible additive onboarding foreign key shape.');
  }

  const checkRows = await queryRunner.query(
    `SELECT tc.constraint_name AS name, cc.check_clause AS clause
     FROM information_schema.table_constraints tc
     LEFT JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = DATABASE() AND tc.table_name = 'ca_meta_onboarding_sessions'
       AND tc.constraint_type = 'CHECK'`,
  ) as Array<{ name: string; clause: string | null }>;
  const expectedChecks = new Map([
    ['ck_ca_meta_onboarding_route', "return_route in ('connections','setup')"],
    ['ck_ca_meta_onboarding_version', 'version > 0'],
    ['ck_ca_meta_onboarding_expiry', 'expires_at > created_at'],
    ['ck_ca_meta_onboarding_ready', "status <> 'READY' OR readiness = 'READY'"],
    ['ck_ca_meta_onboarding_partial', "status <> 'PARTIAL' OR readiness = 'PARTIAL'"],
  ].map(([name, clause]) => [name, normalizeCheckClause(clause)]));
  const jsonColumnNames = new Set(['requested_capabilities', 'steps_json',
    ...(actualColumns.includes('saga_checkpoint_json') ? ['saga_checkpoint_json'] : [])]);
  const observedChecks = new Map<string, string>();
  for (const row of checkRows) {
    if (!row.clause) throw new Error(`M4.03 migration found an unverifiable onboarding CHECK constraint (${row.name}).`);
    const clause = normalizeCheckClause(row.clause);
    const expected = expectedChecks.get(row.name);
    if (expected !== undefined) {
      if (clause !== expected) throw new Error(`M4.03 migration found an unexpected onboarding CHECK constraint (${row.name}).`);
      observedChecks.set(row.name, clause);
      continue;
    }
    const jsonCheck = /^json_valid\(([a-z0-9_]+)\)$/u.exec(clause)?.[1];
    if (!jsonCheck || !jsonColumnNames.has(jsonCheck)) {
      throw new Error(`M4.03 migration found an unexpected onboarding CHECK constraint (${row.name}).`);
    }
  }
  if (observedChecks.size !== expectedChecks.size) {
    throw new Error('M4.03 migration found missing onboarding CHECK constraints.');
  }

  return true;
}

const compatibleOnboardingSessionPriorSteps: NonNullable<DdlStep['compatiblePriorSteps']> = [{
  migrationId: '202611030010-persisted-onboarding-sessions',
  stepId: 'create-persisted-onboarding-sessions',
  verify: verifyCompatibleOnboardingSessionPriorShape,
}];

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
    const actual = column.column_type.toLowerCase();
    const prior = "enum('wait','check_status','reauthorize','reconcile','resolve_conflict','none')";
    if (column.is_nullable !== 'NO' || column.column_default !== "'WAIT'") {
      throw new Error('M4.03 migration found an unexpected onboarding next_action definition.');
    }
    if (actual === expected) return true;
    if (actual === prior) return false;
    throw new Error('M4.03 migration found an unexpected onboarding next_action definition.');
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
    addOnboardingColumn('configuration_ref', 'VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'unbound\'', 'flow_variant',
      compatibleOnboardingSessionPriorSteps),
    addOnboardingColumn('provider_app_id', "VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'unbound'", 'configuration_ref'),
    addOnboardingColumn('provider_environment', "VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unbound'", 'provider_app_id'),
    addOnboardingColumn('auth_variant', "VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'FACEBOOK_LOGIN_FOR_BUSINESS'", 'provider_environment'),
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
