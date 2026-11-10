import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface IndexShape { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }
interface ForeignKeyShape { readonly name: string; readonly columns: readonly string[]; readonly table: string; readonly referencedColumns: readonly string[] }

async function verifyKeys(queryRunner: QueryRunner, table: string, indexes: readonly IndexShape[], foreignKeys: readonly ForeignKeyShape[]): Promise<void> {
  const indexRows = await queryRunner.query(
    'SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const item = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    item.columns.push(row.column_name); actualIndexes.set(row.name, item);
  }
  if (actualIndexes.size !== indexes.length || indexes.some((expected) => {
    const actual = actualIndexes.get(expected.name);
    return !actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0');
  })) throw new Error('Migration found an incompatible index on ' + table + '.');

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
  })) throw new Error('Migration found an incompatible foreign key on ' + table + '.');
}

function tableStep(id: string, table: string, columns: readonly string[], indexes: readonly IndexShape[],
  foreignKeys: readonly ForeignKeyShape[], sql: string): DdlStep {
  return { id, phase: 'expand', definitionVersion: 'v1', definition: JSON.stringify({ table, columns, indexes, foreignKeys, verifyKeys: verifyKeys.toString() }),
    retryWhenAbsent: true, sql, verify: async ({ queryRunner }) => {
      if (!(await tableExists(queryRunner, table))) return false;
      await assertExpectedColumns(queryRunner, table, columns);
      await verifyKeys(queryRunner, table, indexes, foreignKeys);
      return true;
    } };
}

async function triggerExists(queryRunner: QueryRunner, name: string, table: string, event: 'UPDATE' | 'DELETE'): Promise<boolean> {
  const rows = await queryRunner.query(
    'SELECT action_timing, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?',
    [name],
  ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const statement = row.action_statement.toUpperCase().replace(/[\s`]+/g, '');
  if (row.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== table ||
      statement !== "SIGNALSQLSTATE'45000'SETMESSAGE_TEXT='APPEND-ONLYHISTORY'") throw new Error('Migration found an incompatible subscription audit trigger.');
  return true;
}

function appendOnlyTrigger(event: 'UPDATE' | 'DELETE'): DdlStep {
  const table = 'ca_meta_subscription_audit';
  const name = `tr_meta_subscription_audit_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only history'";
  return { id: `subscription-audit-no-${event.toLowerCase()}`, phase: 'expand',
    definitionVersion: 'v1', definition: JSON.stringify({ name, table, event, statement }), retryWhenAbsent: true,
    sql: `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW ${statement}`,
    verify: ({ queryRunner }) => triggerExists(queryRunner, name, table, event) };
}

const target = tableStep('create-meta-subscription-targets', 'ca_meta_subscription_targets',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'target_asset_id', 'desired_state', 'desired_fields',
    'observed_state', 'observed_fields', 'reconcile_state', 'version', 'attempt_count', 'last_attempt_at', 'last_verified_at', 'next_attempt_at', 'last_safe_reason_code',
    'lock_token', 'lock_expires_at', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_subscription_target_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_subscription_target_full_context', columns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'], unique: true },
    { name: 'uq_ca_meta_subscription_target_context', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment', 'target_asset_id'], unique: true },
    { name: 'ix_ca_meta_subscription_target_asset_context', columns: ['tenant_id', 'target_asset_id', 'app_configuration_id', 'provider', 'environment'], unique: false },
    { name: 'ix_ca_meta_subscription_due', columns: ['tenant_id', 'reconcile_state', 'next_attempt_at'], unique: false },
    { name: 'ix_ca_meta_subscription_lock', columns: ['tenant_id', 'lock_expires_at'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_subscription_target_app', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] },
    { name: 'fk_ca_meta_subscription_target_asset', columns: ['tenant_id', 'target_asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_subscription_targets (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    desired_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    desired_fields LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    observed_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    observed_fields LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    reconcile_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_attempt_at DATETIME(6) NULL,
    last_verified_at DATETIME(6) NULL,
    next_attempt_at DATETIME(6) NULL,
    last_safe_reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lock_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lock_expires_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_subscription_target_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_subscription_target_full_context (tenant_id, id, app_configuration_id, provider, environment),
    UNIQUE KEY uq_ca_meta_subscription_target_context (tenant_id, app_configuration_id, provider, environment, target_asset_id),
    KEY ix_ca_meta_subscription_target_asset_context (tenant_id, target_asset_id, app_configuration_id, provider, environment),
    KEY ix_ca_meta_subscription_due (tenant_id, reconcile_state, next_attempt_at),
    KEY ix_ca_meta_subscription_lock (tenant_id, lock_expires_at),
    CONSTRAINT ck_ca_meta_subscription_target_provider CHECK (provider = 'META'),
    CONSTRAINT ck_ca_meta_subscription_target_json CHECK (JSON_VALID(desired_fields) AND JSON_VALID(observed_fields)),
    CONSTRAINT ck_ca_meta_subscription_target_state CHECK (desired_state IN ('SUBSCRIBED','UNSUBSCRIBED') AND observed_state IN ('SUBSCRIBED','UNSUBSCRIBED','UNKNOWN') AND reconcile_state IN ('PENDING','ACTIVE','PARTIAL','UNKNOWN','MANUAL_ACTION_REQUIRED')),
    CONSTRAINT fk_ca_meta_subscription_target_app FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_subscription_target_asset FOREIGN KEY (tenant_id, target_asset_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_assets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const binding = tableStep('create-meta-subscription-bindings', 'ca_meta_subscription_bindings',
  ['tenant_id', 'target_id', 'asset_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment', 'desired_fields', 'binding_state', 'version', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'target_id', 'asset_id', 'authorization_id'], unique: true },
    { name: 'ix_ca_meta_subscription_binding_target_context', columns: ['tenant_id', 'target_id', 'app_configuration_id', 'provider', 'environment'], unique: false },
    { name: 'ix_ca_meta_subscription_binding_asset', columns: ['tenant_id', 'asset_id', 'binding_state'], unique: false },
    { name: 'ix_ca_meta_subscription_binding_asset_context', columns: ['tenant_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'], unique: false },
    { name: 'ix_ca_meta_subscription_binding_grant', columns: ['tenant_id', 'authorization_id', 'binding_state'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_subscription_binding_target', columns: ['tenant_id', 'target_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_subscription_targets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
    { name: 'fk_ca_meta_subscription_binding_asset', columns: ['tenant_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
    { name: 'fk_ca_meta_subscription_binding_authorization', columns: ['tenant_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_authorizations', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_subscription_bindings (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    desired_fields LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    binding_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, target_id, asset_id, authorization_id),
    KEY ix_ca_meta_subscription_binding_target_context (tenant_id, target_id, app_configuration_id, provider, environment),
    KEY ix_ca_meta_subscription_binding_asset (tenant_id, asset_id, binding_state),
    KEY ix_ca_meta_subscription_binding_asset_context (tenant_id, asset_id, app_configuration_id, provider, environment),
    KEY ix_ca_meta_subscription_binding_grant (tenant_id, authorization_id, binding_state),
    CONSTRAINT ck_ca_meta_subscription_binding_provider CHECK (provider = 'META'),
    CONSTRAINT ck_ca_meta_subscription_binding_state CHECK (binding_state IN ('ACTIVE','REMOVED')),
    CONSTRAINT ck_ca_meta_subscription_binding_json CHECK (JSON_VALID(desired_fields)),
    CONSTRAINT fk_ca_meta_subscription_binding_target FOREIGN KEY (tenant_id, target_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_subscription_targets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_subscription_binding_asset FOREIGN KEY (tenant_id, asset_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_assets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_subscription_binding_authorization FOREIGN KEY (tenant_id, authorization_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_authorizations (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const appWebhook = tableStep('create-meta-app-webhook-configs', 'ca_meta_app_webhook_configs',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'desired_fields', 'observed_fields', 'observed_state', 'config_state', 'version', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_app_webhook_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_app_webhook_context', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], unique: true },
  ],
  [{ name: 'fk_ca_meta_app_webhook_config', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_app_webhook_configs (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    desired_fields LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    observed_fields LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    observed_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    config_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_app_webhook_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_app_webhook_context (tenant_id, app_configuration_id, provider, environment),
    CONSTRAINT ck_ca_meta_app_webhook_provider CHECK (provider = 'META'),
    CONSTRAINT ck_ca_meta_app_webhook_json CHECK (JSON_VALID(desired_fields) AND JSON_VALID(observed_fields)),
    CONSTRAINT ck_ca_meta_app_webhook_state CHECK (observed_state IN ('SUBSCRIBED','UNSUBSCRIBED','UNKNOWN') AND config_state IN ('NOT_CONFIRMED','PENDING','ACTIVE','PARTIAL')),
    CONSTRAINT fk_ca_meta_app_webhook_config FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const audit = tableStep('create-meta-subscription-audit', 'ca_meta_subscription_audit',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'target_id', 'asset_id', 'action', 'reason_code', 'before_version', 'after_version', 'actor_ref_hash', 'correlation_id', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'ix_ca_meta_subscription_audit_context', columns: ['tenant_id', 'app_configuration_id', 'created_at'], unique: false },
    { name: 'ix_ca_meta_subscription_audit_app_context', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], unique: false },
    { name: 'ix_ca_meta_subscription_audit_target', columns: ['tenant_id', 'target_id', 'created_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_subscription_audit_app', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] }],
  `CREATE TABLE IF NOT EXISTS ca_meta_subscription_audit (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    before_version BIGINT UNSIGNED NULL,
    after_version BIGINT UNSIGNED NULL,
    actor_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    correlation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id), KEY ix_ca_meta_subscription_audit_context (tenant_id, app_configuration_id, created_at),
    KEY ix_ca_meta_subscription_audit_app_context (tenant_id, app_configuration_id, provider, environment),
    KEY ix_ca_meta_subscription_audit_target (tenant_id, target_id, created_at),
    CONSTRAINT ck_ca_meta_subscription_audit_provider CHECK (provider = 'META'),
    CONSTRAINT fk_ca_meta_subscription_audit_app FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)
      REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);

const definition = { id: '202611060014-meta-subscriptions', schemaVersion: 18, minimumSupportedApiVersion: 1,
  steps: [target, binding, appWebhook, audit, appendOnlyTrigger('UPDATE'), appendOnlyTrigger('DELETE')] } as const;

export const META_SUBSCRIPTIONS_MIGRATION: VersionedMigration = { ...definition, checksum: migrationChecksum(definition) };
export const META_SUBSCRIPTIONS_TABLES = ['ca_meta_subscription_targets', 'ca_meta_subscription_bindings',
  'ca_meta_app_webhook_configs', 'ca_meta_subscription_audit'] as const;
