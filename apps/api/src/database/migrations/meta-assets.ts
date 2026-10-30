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
    const entry = actualIndexes.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    entry.columns.push(row.column_name);
    actualIndexes.set(row.name, entry);
  }
  for (const expected of indexes) {
    const actual = actualIndexes.get(expected.name);
    if (!actual || actual.unique !== expected.unique || actual.columns.join('\0') !== expected.columns.join('\0')) {
      throw new Error('Migration found an incompatible index on ' + table + ' (' + expected.name + ').');
    }
  }
  const fkRows = await queryRunner.query(
    'SELECT constraint_name AS name, column_name AS column_name, referenced_table_name AS referenced_table, referenced_column_name AS referenced_column FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position',
    [table],
  ) as Array<{ name: string; column_name: string; referenced_table: string; referenced_column: string }>;
  const actualFks = new Map<string, { columns: string[]; table: string; referencedColumns: string[] }>();
  for (const row of fkRows) {
    const entry = actualFks.get(row.name) ?? { columns: [], table: row.referenced_table, referencedColumns: [] };
    entry.columns.push(row.column_name);
    entry.referencedColumns.push(row.referenced_column);
    actualFks.set(row.name, entry);
  }
  for (const expected of foreignKeys) {
    const actual = actualFks.get(expected.name);
    if (!actual || actual.table !== expected.table || actual.columns.join('\0') !== expected.columns.join('\0') ||
        actual.referencedColumns.join('\0') !== expected.referencedColumns.join('\0')) {
      throw new Error('Migration found an incompatible foreign key on ' + table + ' (' + expected.name + ').');
    }
  }
}

function tableStep(id: string, table: string, columns: readonly string[], indexes: readonly IndexShape[],
  foreignKeys: readonly ForeignKeyShape[], sql: string): DdlStep {
  return {
    id, phase: 'expand', sql, definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, foreignKeys, verifyKeys: verifyKeys.toString() }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      if (!(await tableExists(queryRunner, table))) return false;
      await assertExpectedColumns(queryRunner, table, columns);
      await verifyKeys(queryRunner, table, indexes, foreignKeys);
      return true;
    },
  };
}

function indexStep(id: string, table: string, expected: IndexShape, sql: string): DdlStep {
  return {
    id, phase: 'expand', sql, definitionVersion: 'v1',
    definition: JSON.stringify({ table, expected }), retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      if (!(await tableExists(queryRunner, table))) throw new Error('Required table is missing: ' + table);
      const rows = await queryRunner.query(
        'SELECT column_name AS column_name, non_unique AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY seq_in_index',
        [table, expected.name],
      ) as Array<{ column_name: string; non_unique: number | string }>;
      if (rows.length === 0) return false;
      if (rows.map((row) => row.column_name).join('\0') !== expected.columns.join('\0') ||
          rows.some((row) => Number(row.non_unique) !== (expected.unique ? 0 : 1))) {
        throw new Error('Migration found an incompatible index on ' + table + ' (' + expected.name + ').');
      }
      return true;
    },
  };
}

async function triggerExists(queryRunner: QueryRunner, name: string, table: string, event: 'UPDATE' | 'DELETE'): Promise<boolean> {
  const rows = await queryRunner.query(
    'SELECT action_timing, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?',
    [name],
  ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
  if (rows.length === 0) return false;
  const row = rows[0];
  const statement = row?.action_statement.toUpperCase().replace(/[\s\x60]+/g, '');
  if (row?.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== table ||
      statement !== "SIGNALSQLSTATE'45000'SETMESSAGE_TEXT='APPEND-ONLYHISTORY'") {
    throw new Error('Migration found an incompatible append-only trigger (' + name + ').');
  }
  return true;
}

function appendOnlyTrigger(table: string, event: 'UPDATE' | 'DELETE'): DdlStep {
  const name = 'tr_' + table.slice('ca_meta_'.length) + '_no_' + event.toLowerCase();
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only history'";
  return {
    id: table + '-no-' + event.toLowerCase(), phase: 'expand',
    sql: 'CREATE TRIGGER ' + name + ' BEFORE ' + event + ' ON ' + table + ' FOR EACH ROW ' + statement,
    definitionVersion: 'v1', definition: JSON.stringify({ name, table, event, statement }), retryWhenAbsent: true,
    verify: ({ queryRunner }) => triggerExists(queryRunner, name, table, event),
  };
}

const assetContextIndex = indexStep(
  'add-asset-context-key', 'ca_meta_assets',
  { name: 'uq_ca_meta_asset_context', columns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'], unique: true },
  'ALTER TABLE ca_meta_assets ADD UNIQUE KEY uq_ca_meta_asset_context (tenant_id, id, app_configuration_id, provider, environment)',
);

const authorizations = tableStep(
  'create-meta-authorizations', 'ca_meta_authorizations',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'provider_authorization_id', 'authorization_state', 'version', 'observed_at', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_authorization_context', columns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'], unique: true },
    { name: 'uq_ca_meta_authorization_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_authorization_external', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment', 'provider_authorization_id'], unique: true },
    { name: 'ix_ca_meta_authorization_tenant_state', columns: ['tenant_id', 'authorization_state', 'updated_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_authorization_app', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_authorizations (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider_authorization_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,',
    ' authorization_state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'UNKNOWN\',',
    ' version BIGINT UNSIGNED NOT NULL DEFAULT 1, observed_at DATETIME(6) NOT NULL,',
    ' created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL, PRIMARY KEY (id),',
    ' UNIQUE KEY uq_ca_meta_authorization_context (tenant_id, id, app_configuration_id, provider, environment), UNIQUE KEY uq_ca_meta_authorization_tenant_id (tenant_id, id),',
    ' UNIQUE KEY uq_ca_meta_authorization_external (tenant_id, app_configuration_id, provider, environment, provider_authorization_id),',
    ' KEY ix_ca_meta_authorization_tenant_state (tenant_id, authorization_state, updated_at),',
    ' CONSTRAINT ck_ca_meta_authorization_provider CHECK (provider = \'META\'),',
    ' CONSTRAINT ck_ca_meta_authorization_state CHECK (authorization_state IN (\'ACTIVE\', \'PARTIAL\', \'REAUTH_REQUIRED\', \'UNKNOWN\', \'REVOKED\', \'DISCONNECTED\')),',
    ' CONSTRAINT fk_ca_meta_authorization_app FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const credentials = tableStep(
  'create-meta-credential-metadata', 'ca_meta_credentials',
  ['id', 'tenant_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment', 'family', 'status', 'version', 'created_at', 'updated_at', 'revoked_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_credential_auth_context', columns: ['tenant_id', 'id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], unique: true },
    { name: 'ix_ca_meta_credential_auth_state', columns: ['tenant_id', 'authorization_id', 'status'], unique: false },
  ],
  [{ name: 'fk_ca_meta_credential_authorization', columns: ['tenant_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_authorizations', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_credentials (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' family VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'ACTIVE\',',
    ' version BIGINT UNSIGNED NOT NULL DEFAULT 1, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL, revoked_at DATETIME(6) NULL,',
    ' PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_credential_auth_context (tenant_id, id, authorization_id, app_configuration_id, provider, environment),',
    ' KEY ix_ca_meta_credential_auth_state (tenant_id, authorization_id, status),',
    ' CONSTRAINT ck_ca_meta_credential_status CHECK (status IN (\'ACTIVE\', \'REVOKED\', \'REAUTH_REQUIRED\', \'UNKNOWN\')),',
    ' CONSTRAINT fk_ca_meta_credential_authorization FOREIGN KEY (tenant_id, authorization_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_authorizations (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const authorizationScopes = tableStep(
  'create-meta-authorization-scopes', 'ca_meta_authorization_scopes',
  ['tenant_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment', 'scope_name', 'status', 'source', 'observed_at', 'version'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'authorization_id', 'scope_name'], unique: true },
    { name: 'ix_ca_meta_scope_tenant_status', columns: ['tenant_id', 'status', 'scope_name'], unique: false },
  ],
  [{ name: 'fk_ca_meta_scope_authorization', columns: ['tenant_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_authorizations', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_authorization_scopes (',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, scope_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,',
    ' status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' observed_at DATETIME(6) NOT NULL, version BIGINT UNSIGNED NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, authorization_id, scope_name),',
    ' KEY ix_ca_meta_scope_tenant_status (tenant_id, status, scope_name),',
    ' CONSTRAINT ck_ca_meta_scope_status CHECK (status IN (\'GRANTED\', \'REVOKED\')),',
    ' CONSTRAINT ck_ca_meta_scope_source CHECK (source IN (\'META_API\', \'SIGNED_WEBHOOK\')),',
    ' CONSTRAINT fk_ca_meta_scope_authorization FOREIGN KEY (tenant_id, authorization_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_authorizations (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const authorizationHistory = tableStep(
  'create-meta-authorization-history', 'ca_meta_authorization_history',
  ['id', 'tenant_id', 'authorization_id', 'version', 'source', 'snapshot_json', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_authorization_history_version', columns: ['tenant_id', 'authorization_id', 'version'], unique: true },
    { name: 'ix_ca_meta_authorization_history_created', columns: ['tenant_id', 'created_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_authorization_history_authorization', columns: ['tenant_id', 'authorization_id'], table: 'ca_meta_authorizations', referencedColumns: ['tenant_id', 'id'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_authorization_history (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, version BIGINT UNSIGNED NOT NULL,',
    ' source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, snapshot_json JSON NOT NULL, created_at DATETIME(6) NOT NULL,',
    ' PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_authorization_history_version (tenant_id, authorization_id, version),',
    ' KEY ix_ca_meta_authorization_history_created (tenant_id, created_at),',
    ' CONSTRAINT ck_ca_meta_authorization_history_source CHECK (source IN (\'META_API\', \'SIGNED_WEBHOOK\', \'BROWSER_CLAIM\')),',
    ' CONSTRAINT ck_ca_meta_authorization_history_json CHECK (JSON_VALID(snapshot_json)),',
    ' CONSTRAINT fk_ca_meta_authorization_history_authorization FOREIGN KEY (tenant_id, authorization_id)',
    '   REFERENCES ca_meta_authorizations (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const assetAuthorizations = tableStep(
  'create-asset-authorizations', 'ca_meta_asset_authorizations',
  ['tenant_id', 'authorization_id', 'asset_id', 'app_configuration_id', 'provider', 'environment', 'credential_id', 'state', 'verification_state', 'verification_source', 'verification_ref_hash', 'verified_at', 'subscription_state', 'projection_state', 'version', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'authorization_id', 'asset_id'], unique: true },
    { name: 'uq_ca_meta_asset_auth_context', columns: ['tenant_id', 'authorization_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'], unique: true },
    { name: 'ix_ca_meta_asset_auth_asset_state', columns: ['tenant_id', 'asset_id', 'state'], unique: false },
    { name: 'ix_ca_meta_asset_auth_subscription', columns: ['tenant_id', 'subscription_state', 'updated_at'], unique: false },
    { name: 'ix_ca_meta_asset_auth_projection', columns: ['tenant_id', 'projection_state', 'updated_at'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_asset_auth_authorization', columns: ['tenant_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_authorizations', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
    { name: 'fk_ca_meta_asset_auth_asset', columns: ['tenant_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
    { name: 'fk_ca_meta_asset_auth_credential', columns: ['tenant_id', 'credential_id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_credentials', referencedColumns: ['tenant_id', 'id', 'authorization_id', 'app_configuration_id', 'provider', 'environment'] },
  ],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_authorizations (',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'ACTIVE\',',
    ' verification_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'CLAIMED\',',
    ' verification_source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'BROWSER_CLAIM\',',
    ' verification_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL, verified_at DATETIME(6) NULL,',
    ' subscription_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'UNKNOWN\',',
    ' projection_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'UNKNOWN\',',
    ' version BIGINT UNSIGNED NOT NULL DEFAULT 1, created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,',
    ' PRIMARY KEY (tenant_id, authorization_id, asset_id),',
    ' UNIQUE KEY uq_ca_meta_asset_auth_context (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment),',
    ' KEY ix_ca_meta_asset_auth_asset_state (tenant_id, asset_id, state),',
    ' KEY ix_ca_meta_asset_auth_subscription (tenant_id, subscription_state, updated_at),',
    ' KEY ix_ca_meta_asset_auth_projection (tenant_id, projection_state, updated_at),',
    ' CONSTRAINT ck_ca_meta_asset_auth_state CHECK (state IN (\'ACTIVE\', \'REVOKED\', \'QUARANTINED\')),',
    ' CONSTRAINT ck_ca_meta_asset_auth_verification CHECK (verification_state IN (\'CLAIMED\', \'VERIFIED\')),',
    ' CONSTRAINT ck_ca_meta_asset_auth_source CHECK (verification_source IN (\'BROWSER_CLAIM\', \'META_API\', \'SIGNED_WEBHOOK\')),',
    ' CONSTRAINT ck_ca_meta_asset_auth_subscription CHECK (subscription_state IN (\'UNKNOWN\', \'PENDING\', \'ACTIVE\', \'FAILED\', \'REMOVED\')),',
    ' CONSTRAINT ck_ca_meta_asset_auth_projection CHECK (projection_state IN (\'UNKNOWN\', \'PENDING\', \'SYNCED\', \'STALE\', \'FAILED\')),',
    ' CONSTRAINT fk_ca_meta_asset_auth_authorization FOREIGN KEY (tenant_id, authorization_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_authorizations (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,',
    ' CONSTRAINT fk_ca_meta_asset_auth_asset FOREIGN KEY (tenant_id, asset_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_assets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,',
    ' CONSTRAINT fk_ca_meta_asset_auth_credential FOREIGN KEY (tenant_id, credential_id, authorization_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_credentials (tenant_id, id, authorization_id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const assetGrants = tableStep(
  'create-meta-asset-grants', 'ca_meta_asset_grants',
  ['tenant_id', 'authorization_id', 'asset_id', 'app_configuration_id', 'provider', 'environment', 'grant_name', 'status', 'source', 'observed_at', 'version'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'authorization_id', 'asset_id', 'grant_name'], unique: true },
    { name: 'ix_ca_meta_asset_grant_tenant_status', columns: ['tenant_id', 'status', 'grant_name'], unique: false },
  ],
  [{ name: 'fk_ca_meta_asset_grant_relation', columns: ['tenant_id', 'authorization_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_asset_authorizations', referencedColumns: ['tenant_id', 'authorization_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_grants (',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' grant_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, observed_at DATETIME(6) NOT NULL, version BIGINT UNSIGNED NOT NULL DEFAULT 1,',
    ' PRIMARY KEY (tenant_id, authorization_id, asset_id, grant_name), KEY ix_ca_meta_asset_grant_tenant_status (tenant_id, status, grant_name),',
    ' CONSTRAINT ck_ca_meta_asset_grant_status CHECK (status IN (\'GRANTED\', \'REVOKED\')),',
    ' CONSTRAINT ck_ca_meta_asset_grant_source CHECK (source IN (\'META_API\', \'SIGNED_WEBHOOK\')),',
    ' CONSTRAINT fk_ca_meta_asset_grant_relation FOREIGN KEY (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_asset_authorizations (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const assetRelations = tableStep(
  'create-meta-asset-relations', 'ca_meta_asset_relations',
  ['tenant_id', 'source_asset_id', 'target_asset_id', 'app_configuration_id', 'provider', 'environment', 'relation_type', 'verification_source', 'verification_ref_hash', 'verified_at', 'version'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'source_asset_id', 'target_asset_id', 'relation_type'], unique: true },
    { name: 'ix_ca_meta_asset_relation_target', columns: ['tenant_id', 'target_asset_id', 'relation_type'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_asset_relation_source', columns: ['tenant_id', 'source_asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
    { name: 'fk_ca_meta_asset_relation_target', columns: ['tenant_id', 'target_asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] },
  ],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_relations (',
    ' tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, source_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' target_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' relation_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, verification_source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' verification_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, verified_at DATETIME(6) NOT NULL, version BIGINT UNSIGNED NOT NULL DEFAULT 1,',
    ' PRIMARY KEY (tenant_id, source_asset_id, target_asset_id, relation_type), KEY ix_ca_meta_asset_relation_target (tenant_id, target_asset_id, relation_type),',
    ' CONSTRAINT ck_ca_meta_asset_relation_type CHECK (relation_type IN (\'PHONE_TO_ACCOUNT\', \'INSTAGRAM_TO_PAGE\')),',
    ' CONSTRAINT ck_ca_meta_asset_relation_source CHECK (verification_source IN (\'META_API\', \'SIGNED_WEBHOOK\')),',
    ' CONSTRAINT fk_ca_meta_asset_relation_source FOREIGN KEY (tenant_id, source_asset_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_assets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT,',
    ' CONSTRAINT fk_ca_meta_asset_relation_target FOREIGN KEY (tenant_id, target_asset_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_assets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const identityClaims = tableStep(
  'create-meta-asset-identity-claims', 'ca_meta_asset_identity_claims',
  ['identity_hash', 'provider', 'app_external_id', 'environment', 'asset_kind', 'external_id', 'tenant_id', 'asset_id', 'app_configuration_id', 'verification_source', 'verification_ref_hash', 'verified_at', 'version'],
  [
    { name: 'PRIMARY', columns: ['identity_hash'], unique: true },
    { name: 'uq_ca_meta_asset_identity_owner', columns: ['tenant_id', 'asset_id'], unique: true },
  ],
  [{ name: 'fk_ca_meta_asset_identity_owner', columns: ['tenant_id', 'asset_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id', 'app_configuration_id', 'provider', 'environment'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_identity_claims (',
    ' identity_hash BINARY(32) NOT NULL, provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' app_external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,',
    ' environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, asset_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL, tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' verification_source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, verification_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' verified_at DATETIME(6) NOT NULL, version BIGINT UNSIGNED NOT NULL DEFAULT 1, PRIMARY KEY (identity_hash),',
    ' UNIQUE KEY uq_ca_meta_asset_identity_owner (tenant_id, asset_id),',
    ' CONSTRAINT ck_ca_meta_asset_identity_source CHECK (verification_source IN (\'META_API\', \'SIGNED_WEBHOOK\')),',
    ' CONSTRAINT fk_ca_meta_asset_identity_owner FOREIGN KEY (tenant_id, asset_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_assets (tenant_id, id, app_configuration_id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const claimQuarantine = tableStep(
  'create-meta-asset-claim-quarantine', 'ca_meta_asset_claim_quarantine',
  ['id', 'tenant_id', 'app_configuration_id', 'provider', 'environment', 'asset_kind', 'external_id', 'identity_hash', 'reason_code', 'source', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_asset_quarantine_candidate', columns: ['tenant_id', 'identity_hash'], unique: true },
    { name: 'ix_ca_meta_asset_quarantine_tenant_created', columns: ['tenant_id', 'created_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_asset_quarantine_app', columns: ['tenant_id', 'app_configuration_id', 'provider', 'environment'], table: 'ca_meta_app_configurations', referencedColumns: ['tenant_id', 'id', 'provider', 'environment'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_claim_quarantine (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, asset_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' external_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL, identity_hash BINARY(32) NOT NULL,',
    ' reason_code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT \'CROSS_TENANT_VERIFIED_OWNER\',',
    ' source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at DATETIME(6) NOT NULL, PRIMARY KEY (id),',
    ' UNIQUE KEY uq_ca_meta_asset_quarantine_candidate (tenant_id, identity_hash),',
    ' KEY ix_ca_meta_asset_quarantine_tenant_created (tenant_id, created_at),',
    ' CONSTRAINT ck_ca_meta_asset_quarantine_reason CHECK (reason_code = \'CROSS_TENANT_VERIFIED_OWNER\'),',
    ' CONSTRAINT ck_ca_meta_asset_quarantine_source CHECK (source IN (\'META_API\', \'SIGNED_WEBHOOK\', \'BROWSER_CLAIM\')),',
    ' CONSTRAINT fk_ca_meta_asset_quarantine_app FOREIGN KEY (tenant_id, app_configuration_id, provider, environment)',
    '   REFERENCES ca_meta_app_configurations (tenant_id, id, provider, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);

const assetHistory = tableStep(
  'create-meta-asset-history', 'ca_meta_asset_history',
  ['id', 'tenant_id', 'asset_id', 'version', 'source', 'snapshot_json', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_asset_history_version', columns: ['tenant_id', 'asset_id', 'version'], unique: true },
    { name: 'ix_ca_meta_asset_history_created', columns: ['tenant_id', 'created_at'], unique: false },
  ],
  [{ name: 'fk_ca_meta_asset_history_asset', columns: ['tenant_id', 'asset_id'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id'] }],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_history (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, version BIGINT UNSIGNED NOT NULL,',
    ' source VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, snapshot_json JSON NOT NULL, created_at DATETIME(6) NOT NULL,',
    ' PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_asset_history_version (tenant_id, asset_id, version),',
    ' KEY ix_ca_meta_asset_history_created (tenant_id, created_at),',
    ' CONSTRAINT ck_ca_meta_asset_history_source CHECK (source IN (\'META_API\', \'SIGNED_WEBHOOK\', \'BROWSER_CLAIM\')),',
    ' CONSTRAINT ck_ca_meta_asset_history_json CHECK (JSON_VALID(snapshot_json)),',
    ' CONSTRAINT fk_ca_meta_asset_history_asset FOREIGN KEY (tenant_id, asset_id)',
    '   REFERENCES ca_meta_assets (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);


const legacyMapContextIndex = indexStep(
  'add-legacy-tenant-origin-key', 'ca_meta_tenant_legacy_maps',
  { name: 'uq_ca_meta_legacy_tenant_origin', columns: ['tenant_id', 'legacy_database_id', 'legacy_company_id', 'environment'], unique: true },
  'ALTER TABLE ca_meta_tenant_legacy_maps ADD UNIQUE KEY uq_ca_meta_legacy_tenant_origin (tenant_id, legacy_database_id, legacy_company_id, environment)',
);

const assetLegacyReferences = tableStep(
  'create-meta-asset-legacy-references', 'ca_meta_asset_legacy_refs',
  ['id', 'tenant_id', 'asset_id', 'legacy_database_id', 'legacy_company_id', 'environment', 'legacy_asset_ref', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_legacy_asset_reference', columns: ['tenant_id', 'legacy_database_id', 'legacy_company_id', 'environment', 'legacy_asset_ref'], unique: true },
    { name: 'ix_ca_meta_legacy_asset_asset', columns: ['tenant_id', 'asset_id'], unique: false },
  ],
  [
    { name: 'fk_ca_meta_legacy_asset_owner', columns: ['tenant_id', 'asset_id'], table: 'ca_meta_assets', referencedColumns: ['tenant_id', 'id'] },
    { name: 'fk_ca_meta_legacy_asset_tenant_mapping', columns: ['tenant_id', 'legacy_database_id', 'legacy_company_id', 'environment'], table: 'ca_meta_tenant_legacy_maps', referencedColumns: ['tenant_id', 'legacy_database_id', 'legacy_company_id', 'environment'] },
  ],
  [
    'CREATE TABLE IF NOT EXISTS ca_meta_asset_legacy_refs (',
    ' id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, legacy_database_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' legacy_company_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL, environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
    ' legacy_asset_ref VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL, created_at DATETIME(6) NOT NULL,',
    ' PRIMARY KEY (id), UNIQUE KEY uq_ca_meta_legacy_asset_reference (tenant_id, legacy_database_id, legacy_company_id, environment, legacy_asset_ref),',
    ' KEY ix_ca_meta_legacy_asset_asset (tenant_id, asset_id),',
    ' CONSTRAINT fk_ca_meta_legacy_asset_owner FOREIGN KEY (tenant_id, asset_id) REFERENCES ca_meta_assets (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,',
    ' CONSTRAINT fk_ca_meta_legacy_asset_tenant_mapping FOREIGN KEY (tenant_id, legacy_database_id, legacy_company_id, environment)',
    '   REFERENCES ca_meta_tenant_legacy_maps (tenant_id, legacy_database_id, legacy_company_id, environment) ON UPDATE RESTRICT ON DELETE RESTRICT',
    ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin',
  ].join('\n'),
);
const historyTriggers = [
  appendOnlyTrigger('ca_meta_authorization_history', 'UPDATE'),
  appendOnlyTrigger('ca_meta_authorization_history', 'DELETE'),
  appendOnlyTrigger('ca_meta_asset_history', 'UPDATE'),
  appendOnlyTrigger('ca_meta_asset_history', 'DELETE'),
  appendOnlyTrigger('ca_meta_asset_legacy_refs', 'UPDATE'),
  appendOnlyTrigger('ca_meta_asset_legacy_refs', 'DELETE'),
  appendOnlyTrigger('ca_meta_asset_claim_quarantine', 'UPDATE'),
  appendOnlyTrigger('ca_meta_asset_claim_quarantine', 'DELETE'),
] as const;

const definition = {
  id: '202610300005-meta-assets-grants-relations',
  schemaVersion: 7,
  minimumSupportedApiVersion: 1,
  steps: [assetContextIndex, legacyMapContextIndex, authorizations, credentials, authorizationScopes, authorizationHistory,
    assetAuthorizations, assetGrants, assetRelations, identityClaims, claimQuarantine, assetLegacyReferences, assetHistory, ...historyTriggers],
} as const;

export const META_ASSETS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const META_ASSETS_TABLES = [
  'ca_meta_authorizations', 'ca_meta_credentials', 'ca_meta_authorization_scopes',
  'ca_meta_authorization_history', 'ca_meta_asset_authorizations', 'ca_meta_asset_grants',
  'ca_meta_asset_relations', 'ca_meta_asset_identity_claims', 'ca_meta_asset_claim_quarantine',
  'ca_meta_asset_legacy_refs', 'ca_meta_asset_history',
] as const;
