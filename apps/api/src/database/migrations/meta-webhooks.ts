import type { QueryRunner } from 'typeorm';
import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, VersionedMigration } from './migration.types.js';

interface IndexDefinition {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

async function verifyTable(queryRunner: QueryRunner, table: string, columns: readonly string[], indexes: readonly IndexDefinition[]): Promise<boolean> {
  if (!(await tableExists(queryRunner, table))) return false;
  await assertExpectedColumns(queryRunner, table, columns);
  const rows = await queryRunner.query(
    'SELECT index_name AS name, column_name AS column_name, non_unique AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of rows) {
    const entry = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    entry.columns.push(row.column_name);
    actual.set(row.name, entry);
  }
  for (const expected of indexes) {
    const actualIndex = actual.get(expected.name);
    if (!actualIndex || actualIndex.unique !== expected.unique || actualIndex.columns.join('\0') !== expected.columns.join('\0')) {
      throw new Error('Meta webhook migration found an incompatible index on ' + table + ' (' + expected.name + ').');
    }
  }
  return true;
}

function tableStep(id: string, table: string, columns: readonly string[], indexes: readonly IndexDefinition[], sql: string): DdlStep {
  return {
    id,
    phase: 'expand',
    sql,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, verify: verifyTable.toString() }),
    retryWhenAbsent: true,
    verify: ({ queryRunner }) => verifyTable(queryRunner, table, columns, indexes),
  };
}

async function triggerExists(queryRunner: QueryRunner, name: string, table: string, event: 'UPDATE' | 'DELETE'): Promise<boolean> {
  const rows = await queryRunner.query(
    'SELECT action_timing, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?',
    [name],
  ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
  if (rows.length === 0) return false;
  const row = rows[0];
  const statement = row?.action_statement.toUpperCase().replace(/[\s`]+/g, '');
  if (row?.action_timing !== 'BEFORE' || row.event_manipulation !== event || row.event_object_table !== table ||
      statement !== "SIGNALSQLSTATE'45000'SETMESSAGE_TEXT='APPEND-ONLYWEBHOOKAUDIT'") {
    throw new Error('Meta webhook migration found an incompatible replay audit trigger.');
  }
  return true;
}

function appendOnlyAuditTrigger(event: 'UPDATE' | 'DELETE'): DdlStep {
  const table = 'ca_meta_webhook_replay_audit';
  const name = `tr_meta_webhook_audit_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only webhook audit'";
  return {
    id: `meta-webhook-replay-audit-no-${event.toLowerCase()}`,
    phase: 'expand',
    sql: `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW ${statement}`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ name, table, event, statement, verify: triggerExists.toString() }),
    retryWhenAbsent: true,
    verify: ({ queryRunner }) => triggerExists(queryRunner, name, table, event),
  };
}

const deliveries = tableStep(
  'create-meta-webhook-deliveries',
  'ca_meta_webhook_deliveries',
  ['id', 'provider_app_id', 'app_configuration_ref', 'environment', 'key_reference', 'nonce', 'authentication_tag', 'ciphertext', 'raw_sha256', 'signature_verified_at', 'received_at', 'expires_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'ix_ca_meta_webhook_delivery_expiry', columns: ['expires_at', 'id'], unique: false },
    { name: 'ix_ca_meta_webhook_delivery_application', columns: ['provider_app_id', 'environment', 'received_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_webhook_deliveries (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_app_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_ref VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    key_reference VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nonce BINARY(12) NOT NULL,
    authentication_tag BINARY(16) NOT NULL,
    ciphertext MEDIUMBLOB NOT NULL,
    raw_sha256 BINARY(32) NOT NULL,
    signature_verified_at DATETIME(6) NOT NULL,
    received_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY ix_ca_meta_webhook_delivery_expiry (expires_at, id),
    KEY ix_ca_meta_webhook_delivery_application (provider_app_id, environment, received_at),
    CONSTRAINT ck_ca_meta_webhook_delivery_environment CHECK (environment IN ('development', 'test', 'staging', 'production'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const events = tableStep(
  'create-meta-webhook-events',
  'ca_meta_webhook_events',
  ['id', 'provider_app_id', 'environment', 'event_ref', 'schema_version', 'event_type', 'item_kind', 'provider_timestamp', 'provider_message_id', 'provider_status', 'provider_status_rank', 'object_type', 'field_name', 'item_identity_hash', 'payload_hash', 'delivery_id', 'item_locator_json', 'tenant_id', 'app_configuration_id', 'asset_id', 'route_state', 'process_state', 'quarantine_reason', 'attempt', 'lease_owner', 'lease_version', 'lease_until', 'next_attempt_at', 'last_error_code', 'received_at', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_webhook_item_identity', columns: ['provider_app_id', 'environment', 'item_identity_hash'], unique: true },
    { name: 'ix_ca_meta_webhook_worker', columns: ['route_state', 'process_state', 'next_attempt_at', 'received_at', 'id'], unique: false },
    { name: 'ix_ca_meta_webhook_status_order', columns: ['tenant_id', 'app_configuration_id', 'asset_id', 'provider_message_id', 'provider_timestamp', 'provider_status_rank', 'process_state'], unique: false },
    { name: 'ix_ca_meta_webhook_quarantine', columns: ['route_state', 'quarantine_reason', 'received_at', 'id'], unique: false },
    { name: 'ix_ca_meta_webhook_tenant', columns: ['tenant_id', 'route_state', 'received_at', 'id'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_webhook_events (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_app_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_ref CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    schema_version SMALLINT UNSIGNED NOT NULL,
    event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    item_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_timestamp DATETIME(6) NULL,
    provider_message_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    provider_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    provider_status_rank SMALLINT NULL,
    object_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    field_name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    item_identity_hash BINARY(32) NOT NULL,
    payload_hash BINARY(32) NOT NULL,
    delivery_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    item_locator_json JSON NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    route_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    process_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    quarantine_reason VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
    attempt INT UNSIGNED NOT NULL DEFAULT 0,
    lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    lease_until DATETIME(6) NULL,
    next_attempt_at DATETIME(6) NULL,
    last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    received_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_webhook_item_identity (provider_app_id, environment, item_identity_hash),
    KEY ix_ca_meta_webhook_worker (route_state, process_state, next_attempt_at, received_at, id),
    KEY ix_ca_meta_webhook_status_order (tenant_id, app_configuration_id, asset_id, provider_message_id, provider_timestamp, provider_status_rank, process_state),
    KEY ix_ca_meta_webhook_quarantine (route_state, quarantine_reason, received_at, id),
    KEY ix_ca_meta_webhook_tenant (tenant_id, route_state, received_at, id),
    CONSTRAINT fk_ca_meta_webhook_delivery FOREIGN KEY (delivery_id) REFERENCES ca_meta_webhook_deliveries (id)
      ON UPDATE RESTRICT ON DELETE SET NULL,
    CONSTRAINT fk_ca_meta_webhook_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_webhook_environment CHECK (environment IN ('development', 'test', 'staging', 'production')),
    CONSTRAINT ck_ca_meta_webhook_schema_version CHECK (schema_version = 1),
    CONSTRAINT ck_ca_meta_webhook_item_kind CHECK (item_kind IN ('change', 'messages', 'statuses', 'messaging')),
    CONSTRAINT ck_ca_meta_webhook_route CHECK (route_state IN ('ROUTED', 'QUARANTINED')),
    CONSTRAINT ck_ca_meta_webhook_process CHECK (process_state IN ('PENDING', 'RUNNING', 'RETRY_PENDING', 'PROCESSED', 'DEAD_LETTER', 'BLOCKED')),
    CONSTRAINT ck_ca_meta_webhook_route_context CHECK (
      (route_state = 'ROUTED' AND tenant_id IS NOT NULL AND app_configuration_id IS NOT NULL AND asset_id IS NOT NULL)
      OR (route_state = 'QUARANTINED' AND tenant_id IS NULL AND app_configuration_id IS NULL AND asset_id IS NULL)
    ),
    CONSTRAINT ck_ca_meta_webhook_route_process CHECK (
      (route_state = 'ROUTED' AND process_state <> 'BLOCKED') OR (route_state = 'QUARANTINED' AND process_state = 'BLOCKED')
    )
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const statusLocks = tableStep(
  'create-meta-webhook-status-locks',
  'ca_meta_webhook_status_locks',
  ['tenant_id', 'app_configuration_id', 'environment', 'asset_id', 'provider_message_id', 'lease_owner', 'lease_token', 'lease_version', 'lease_until', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['tenant_id', 'app_configuration_id', 'environment', 'asset_id', 'provider_message_id'], unique: true },
    { name: 'ix_ca_meta_webhook_status_lock_lease', columns: ['lease_until', 'tenant_id', 'app_configuration_id'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_webhook_status_locks (
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_configuration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider_message_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    lease_until DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, app_configuration_id, environment, asset_id, provider_message_id),
    KEY ix_ca_meta_webhook_status_lock_lease (lease_until, tenant_id, app_configuration_id),
    CONSTRAINT ck_ca_meta_webhook_status_lock_environment CHECK (environment IN ('development', 'test', 'staging', 'production')),
    CONSTRAINT ck_ca_meta_webhook_status_lock_fields CHECK (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    )
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const replayAudit = tableStep(
  'create-meta-webhook-replay-audit',
  'ca_meta_webhook_replay_audit',
  ['id', 'webhook_event_id', 'actor_ref', 'case_ref', 'outcome', 'reason_code', 'created_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'ix_ca_meta_webhook_replay_event', columns: ['webhook_event_id', 'created_at', 'id'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_webhook_replay_audit (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webhook_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    case_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    outcome VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reason_code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    KEY ix_ca_meta_webhook_replay_event (webhook_event_id, created_at, id),
    CONSTRAINT fk_ca_meta_webhook_replay_event FOREIGN KEY (webhook_event_id) REFERENCES ca_meta_webhook_events (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_webhook_replay_outcome CHECK (outcome IN ('ROUTED', 'QUARANTINED'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const definition = {
  id: '202611060010-meta-webhooks',
  schemaVersion: 17,
  minimumSupportedApiVersion: 1,
  steps: [deliveries, events, statusLocks, replayAudit, appendOnlyAuditTrigger('UPDATE'), appendOnlyAuditTrigger('DELETE')],
} as const;

export const META_WEBHOOKS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const META_WEBHOOKS_TABLES = [
  'ca_meta_webhook_deliveries', 'ca_meta_webhook_events', 'ca_meta_webhook_status_locks', 'ca_meta_webhook_replay_audit',
] as const;
