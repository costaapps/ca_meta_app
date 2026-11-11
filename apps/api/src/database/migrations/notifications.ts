import { migrationChecksum } from './migration-fingerprint.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';
import type { DdlStep, MigrationStepContext, VersionedMigration } from './migration.types.js';

interface IndexDefinition {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

async function verifyTable(queryRunner: import('typeorm').QueryRunner, table: string,
  columns: readonly string[], indexes: readonly IndexDefinition[]): Promise<boolean> {
  if (!(await tableExists(queryRunner, table))) return false;
  await assertExpectedColumns(queryRunner, table, columns);
  const rows = await queryRunner.query(
    'SELECT index_name AS name, column_name, non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
    [table],
  ) as Array<{ name: string; column_name: string; non_unique: number | string }>;
  const actual = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of rows) {
    const index = actual.get(row.name) ?? { columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(row.column_name);
    actual.set(row.name, index);
  }
  for (const expected of indexes) {
    const index = actual.get(expected.name);
    if (!index || index.unique !== expected.unique || index.columns.join('\0') !== expected.columns.join('\0')) {
      throw new Error(`Notification migration found an incompatible index on ${table}.${expected.name}.`);
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

const notifications = tableStep(
  'create-tenant-notifications',
  'ca_meta_notifications',
  ['id', 'tenant_id', 'asset_id', 'kind', 'message_ref', 'provider_target_ref', 'source_event_hash', 'status', 'safe_summary', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_notification_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_notification_source', columns: ['tenant_id', 'source_event_hash'], unique: true },
    { name: 'ix_ca_meta_notification_tenant_list', columns: ['tenant_id', 'status', 'created_at', 'id'], unique: false },
    { name: 'ix_ca_meta_notification_tenant_asset', columns: ['tenant_id', 'asset_id', 'status', 'created_at', 'id'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_notifications (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    provider_target_ref VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    source_event_hash BINARY(32) NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'UNREAD',
    safe_summary VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_notification_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_notification_source (tenant_id, source_event_hash),
    KEY ix_ca_meta_notification_tenant_list (tenant_id, status, created_at, id),
    KEY ix_ca_meta_notification_tenant_asset (tenant_id, asset_id, status, created_at, id),
    CONSTRAINT fk_ca_meta_notification_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_notification_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ca_meta_assets (tenant_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_notification_kind CHECK (kind IN ('MESSAGE_RECEIVED', 'COMMENT_RECEIVED', 'ASSET_STATUS_CHANGED', 'ACTION_REQUIRED')),
    CONSTRAINT ck_ca_meta_notification_status CHECK (status IN ('UNREAD', 'READ', 'DISMISSED'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const actions = tableStep(
  'create-tenant-notification-action-receipts',
  'ca_meta_notification_action_receipts',
  ['id', 'tenant_id', 'notification_id', 'action', 'idempotency_key_hash', 'request_hash', 'operation_id', 'status', 'safe_error_code', 'actor_ref_hash', 'created_at', 'updated_at'],
  [
    { name: 'PRIMARY', columns: ['id'], unique: true },
    { name: 'uq_ca_meta_notification_action_idempotency', columns: ['tenant_id', 'idempotency_key_hash'], unique: true },
    { name: 'uq_ca_meta_notification_action_operation', columns: ['tenant_id', 'operation_id'], unique: true },
    { name: 'ix_ca_meta_notification_action_notification', columns: ['tenant_id', 'notification_id', 'created_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_notification_action_receipts (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    notification_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key_hash BINARY(32) NOT NULL,
    request_hash BINARY(32) NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    actor_ref_hash BINARY(32) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_notification_action_idempotency (tenant_id, idempotency_key_hash),
    UNIQUE KEY uq_ca_meta_notification_action_operation (tenant_id, operation_id),
    KEY ix_ca_meta_notification_action_notification (tenant_id, notification_id, created_at),
    CONSTRAINT fk_ca_meta_notification_action_notification FOREIGN KEY (tenant_id, notification_id)
      REFERENCES ca_meta_notifications (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ca_meta_notification_action_job FOREIGN KEY (tenant_id, operation_id)
      REFERENCES ca_meta_jobs (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_notification_action CHECK (action IN ('MARK_READ', 'DISMISS', 'SEND_TEMPLATE', 'REPLY_COMMENT')),
    CONSTRAINT ck_ca_meta_notification_action_status CHECK (status IN ('SUCCEEDED', 'PENDING', 'RUNNING', 'FAILED', 'UNKNOWN'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const definition = {
  id: '202611110022-tenant-notifications',
  // Provisional on the isolated M5.06 stack. Reindex to v24 when M5.03/#62, M5.03/#60, and M5.05/#59 are recomposed.
  schemaVersion: 22,
  minimumSupportedApiVersion: 1,
  steps: [notifications, actions],
} as const;

export const NOTIFICATIONS_MIGRATION: VersionedMigration = {
  ...definition,
  checksum: migrationChecksum(definition),
};

export const NOTIFICATION_TABLES = [
  'ca_meta_notifications',
  'ca_meta_notification_action_receipts',
] as const;

export async function verifyNotificationTables(context: MigrationStepContext): Promise<boolean> {
  return await tableExists(context.queryRunner, 'ca_meta_notifications') &&
    await tableExists(context.queryRunner, 'ca_meta_notification_action_receipts');
}
