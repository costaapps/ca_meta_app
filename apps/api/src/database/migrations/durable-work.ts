import type { QueryRunner } from 'typeorm';
import type { MigrationStepContext, VersionedMigration } from './migration.types.js';
import { assertExpectedColumns, tableExists } from './schema-inspection.js';

type DurableMigration = Omit<VersionedMigration, 'checksum'>;

interface IndexShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

async function indexMatches(queryRunner: QueryRunner, table: string, expected: IndexShape): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT column_name AS name, non_unique AS non_unique
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     ORDER BY seq_in_index`,
    [table, expected.name],
  ) as Array<{ name: string; non_unique: number | string }>;
  return rows.map((row) => row.name).join(',') === expected.columns.join(',') &&
    rows.every((row) => Number(row.non_unique) === (expected.unique ? 0 : 1));
}

function tableStep(
  id: string,
  table: string,
  columns: readonly string[],
  indexes: readonly IndexShape[],
  sql: string,
): import('./migration.types.js').DdlStep {
  return {
    id,
    phase: 'expand',
    sql,
    definitionVersion: 'v1',
    definition: JSON.stringify({ table, columns, indexes, verification: 'columns-and-indexes' }),
    retryWhenAbsent: true,
    verify: async ({ queryRunner }) => {
      if (!(await assertExpectedColumns(queryRunner, table, columns))) return false;
      for (const index of indexes) {
        if (!(await indexMatches(queryRunner, table, index))) {
          throw new Error(`Migration preflight found an unexpected index shape for ${table}.${index.name}.`);
        }
      }
      return true;
    },
  };
}

async function triggerExists(
  queryRunner: QueryRunner,
  triggerName: string,
  tableName: string,
  event: 'UPDATE' | 'DELETE',
): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT action_timing, event_manipulation, event_object_table, action_statement
     FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name = ?`,
    [triggerName],
  ) as Array<{ action_timing: string; event_manipulation: string; event_object_table: string; action_statement: string }>;
  if (rows.length === 0) return false;
  const row = rows[0];
  const statement = row?.action_statement.toUpperCase().replace(/[\s`]+/g, '');
  if (
    row?.action_timing !== 'BEFORE' || row.event_manipulation !== event ||
    row.event_object_table !== tableName ||
    statement !== "SIGNALSQLSTATE'45000'SETMESSAGE_TEXT='APPEND-ONLYAUDIT'"
  ) {
    throw new Error(`Migration preflight found an unexpected append-only trigger shape for ${triggerName}.`);
  }
  return true;
}

function immutableAuditTrigger(
  id: string,
  event: 'UPDATE' | 'DELETE',
): import('./migration.types.js').DdlStep {
  const triggerName = `tr_ca_meta_replay_audit_no_${event.toLowerCase()}`;
  const statement = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only audit'";
  return {
    id,
    phase: 'expand',
    sql: `CREATE TRIGGER ${triggerName} BEFORE ${event} ON ca_meta_replay_audit FOR EACH ROW ${statement}`,
    definitionVersion: 'v1',
    definition: JSON.stringify({ triggerName, table: 'ca_meta_replay_audit', event, statement }),
    retryWhenAbsent: true,
    verify: ({ queryRunner }) => triggerExists(queryRunner, triggerName, 'ca_meta_replay_audit', event),
  };
}

const createJobs = tableStep(
  'create-durable-jobs',
  'ca_meta_jobs',
  [
    'id', 'tenant_id', 'job_type', 'schema_version', 'lane', 'effect_mode', 'resource_scope_ref', 'idempotency_key',
    'correlation_id', 'causation_id', 'payload_hash', 'payload_json', 'status', 'attempt', 'max_attempts',
    'next_run_at', 'budget_started_at', 'lease_owner', 'claim_token', 'lease_expires_at', 'heartbeat_at',
    'last_safe_error_code', 'last_safe_error_action', 'created_at', 'updated_at', 'completed_at',
  ],
  [
    { name: 'uq_ca_meta_job_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_job_idempotency', columns: ['tenant_id', 'job_type', 'idempotency_key'], unique: true },
    { name: 'ix_ca_meta_job_claim_ready', columns: ['lane', 'status', 'next_run_at', 'created_at', 'id'], unique: false },
    { name: 'ix_ca_meta_job_claim_expired', columns: ['lane', 'status', 'lease_expires_at', 'created_at', 'id'], unique: false },
    { name: 'ix_ca_meta_job_ambiguous_expired', columns: ['status', 'effect_mode', 'lease_expires_at', 'id'], unique: false },
    { name: 'ix_ca_meta_job_tenant_resource_active', columns: ['tenant_id', 'resource_scope_ref', 'status', 'lease_expires_at'], unique: false },
    { name: 'ix_ca_meta_job_tenant_active', columns: ['tenant_id', 'status', 'lease_expires_at'], unique: false },
    { name: 'ix_ca_meta_job_tenant_backlog', columns: ['tenant_id', 'status', 'next_run_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_jobs (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    job_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    schema_version SMALLINT UNSIGNED NOT NULL,
    lane VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    effect_mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    resource_scope_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    correlation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    causation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    payload_hash BINARY(32) NOT NULL,
    payload_json JSON NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'QUEUED',
    attempt INT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts SMALLINT UNSIGNED NOT NULL,
    next_run_at DATETIME(6) NOT NULL,
    budget_started_at DATETIME(6) NULL,
    lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    claim_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_expires_at DATETIME(6) NULL,
    heartbeat_at DATETIME(6) NULL,
    last_safe_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    last_safe_error_action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    completed_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_job_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_job_idempotency (tenant_id, job_type, idempotency_key),
    KEY ix_ca_meta_job_claim_ready (lane, status, next_run_at, created_at, id),
    KEY ix_ca_meta_job_claim_expired (lane, status, lease_expires_at, created_at, id),
    KEY ix_ca_meta_job_ambiguous_expired (status, effect_mode, lease_expires_at, id),
    KEY ix_ca_meta_job_tenant_resource_active (tenant_id, resource_scope_ref, status, lease_expires_at),
    KEY ix_ca_meta_job_tenant_active (tenant_id, status, lease_expires_at),
    KEY ix_ca_meta_job_tenant_backlog (tenant_id, status, next_run_at),
    CONSTRAINT fk_ca_meta_job_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_job_effect_mode CHECK (effect_mode IN ('SAFE_RETRY', 'IDEMPOTENT', 'AMBIGUOUS')),
    CONSTRAINT ck_ca_meta_job_status CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY_PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'DEAD_LETTER')),
    CONSTRAINT ck_ca_meta_job_lease CHECK (
      (status = 'RUNNING' AND lease_owner IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'RUNNING' AND lease_owner IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT ck_ca_meta_job_attempt CHECK (max_attempts > 0 AND attempt <= max_attempts)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const createAttempts = tableStep(
  'create-job-attempt-history',
  'ca_meta_job_attempts',
  ['id', 'tenant_id', 'job_id', 'attempt', 'worker_ref', 'outcome', 'safe_error_code', 'safe_error_action', 'started_at', 'finished_at', 'duration_ms'],
  [
    { name: 'uq_ca_meta_attempt_job_sequence', columns: ['tenant_id', 'job_id', 'attempt'], unique: true },
    { name: 'ix_ca_meta_attempt_tenant_created', columns: ['tenant_id', 'started_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_job_attempts (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempt INT UNSIGNED NOT NULL,
    worker_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    outcome VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    safe_error_action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    started_at DATETIME(6) NOT NULL,
    finished_at DATETIME(6) NULL,
    duration_ms INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_attempt_job_sequence (tenant_id, job_id, attempt),
    KEY ix_ca_meta_attempt_tenant_created (tenant_id, started_at),
    CONSTRAINT fk_ca_meta_attempt_job FOREIGN KEY (tenant_id, job_id) REFERENCES ca_meta_jobs (tenant_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_attempt_outcome CHECK (outcome IN ('RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'FAILED', 'UNKNOWN', 'DEAD_LETTER'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const createOutbox = tableStep(
  'create-outbox-events',
  'ca_meta_outbox_events',
  ['id', 'tenant_id', 'event_id', 'aggregate_ref', 'aggregate_version', 'schema_version', 'event_type', 'idempotency_key', 'correlation_id', 'causation_id', 'payload_hash', 'payload_json', 'delivery_state', 'attempt', 'created_at', 'delivered_at'],
  [
    { name: 'uq_ca_meta_outbox_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_outbox_event_id', columns: ['tenant_id', 'event_id'], unique: true },
    { name: 'uq_ca_meta_outbox_aggregate_version', columns: ['tenant_id', 'aggregate_ref', 'aggregate_version', 'event_type'], unique: true },
    { name: 'uq_ca_meta_outbox_idempotency', columns: ['tenant_id', 'idempotency_key'], unique: true },
    { name: 'ix_ca_meta_outbox_delivery', columns: ['delivery_state', 'created_at', 'id'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_outbox_events (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    aggregate_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    aggregate_version BIGINT UNSIGNED NOT NULL,
    schema_version SMALLINT UNSIGNED NOT NULL,
    event_type VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    correlation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    causation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    payload_hash BINARY(32) NOT NULL,
    payload_json JSON NOT NULL,
    delivery_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    attempt INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    delivered_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_outbox_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_outbox_event_id (tenant_id, event_id),
    UNIQUE KEY uq_ca_meta_outbox_aggregate_version (tenant_id, aggregate_ref, aggregate_version, event_type),
    UNIQUE KEY uq_ca_meta_outbox_idempotency (tenant_id, idempotency_key),
    KEY ix_ca_meta_outbox_delivery (delivery_state, created_at, id),
    CONSTRAINT fk_ca_meta_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_outbox_state CHECK (delivery_state IN ('PENDING', 'DELIVERED', 'UNKNOWN', 'DEAD_LETTER'))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const createInbox = tableStep(
  'create-inbox-events',
  'ca_meta_inbox_events',
  ['id', 'app_config_ref', 'provider_event_id', 'event_type', 'schema_version', 'tenant_id', 'routing_state', 'processing_state', 'protected_payload_ref', 'correlation_id', 'payload_hash', 'envelope_json', 'received_at', 'occurred_at'],
  [
    { name: 'uq_ca_meta_inbox_provider_event', columns: ['app_config_ref', 'provider_event_id'], unique: true },
    { name: 'ix_ca_meta_inbox_tenant_route_received', columns: ['tenant_id', 'routing_state', 'received_at'], unique: false },
    { name: 'ix_ca_meta_inbox_processing_received', columns: ['processing_state', 'received_at', 'id'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_inbox_events (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    app_config_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    provider_event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    event_type VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    schema_version SMALLINT UNSIGNED NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    routing_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    processing_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDING',
    protected_payload_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    correlation_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    payload_hash BINARY(32) NOT NULL,
    envelope_json JSON NOT NULL,
    received_at DATETIME(6) NOT NULL,
    occurred_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_inbox_provider_event (app_config_ref, provider_event_id),
    KEY ix_ca_meta_inbox_tenant_route_received (tenant_id, routing_state, received_at),
    KEY ix_ca_meta_inbox_processing_received (processing_state, received_at, id),
    CONSTRAINT fk_ca_meta_inbox_tenant FOREIGN KEY (tenant_id) REFERENCES ca_meta_tenants (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_inbox_routing CHECK (routing_state IN ('PENDING', 'ROUTED', 'QUARANTINED', 'REJECTED')),
    CONSTRAINT ck_ca_meta_inbox_processing CHECK (processing_state IN ('PENDING', 'RUNNING', 'PROCESSED', 'UNKNOWN', 'DEAD_LETTER')),
    CONSTRAINT ck_ca_meta_inbox_tenant_routing CHECK (
      (routing_state = 'ROUTED' AND tenant_id IS NOT NULL)
      OR (routing_state <> 'ROUTED' AND tenant_id IS NULL)
    )
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const createDeadLetters = tableStep(
  'create-job-dead-letters',
  'ca_meta_job_dead_letters',
  ['id', 'tenant_id', 'job_id', 'job_type', 'lane', 'safe_error_code', 'safe_error_action', 'attempt_count', 'created_at'],
  [
    { name: 'uq_ca_meta_dlq_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'uq_ca_meta_dlq_job', columns: ['tenant_id', 'job_id'], unique: true },
    { name: 'ix_ca_meta_dlq_tenant_created', columns: ['tenant_id', 'created_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_job_dead_letters (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    job_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    lane VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_error_action VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempt_count INT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_dlq_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ca_meta_dlq_job (tenant_id, job_id),
    KEY ix_ca_meta_dlq_tenant_created (tenant_id, created_at),
    CONSTRAINT fk_ca_meta_dlq_job FOREIGN KEY (tenant_id, job_id) REFERENCES ca_meta_jobs (tenant_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const createReplayAudit = tableStep(
  'create-replay-audit',
  'ca_meta_replay_audit',
  ['id', 'tenant_id', 'dead_letter_id', 'operator_ref', 'authorization_ref', 'scope_ref', 'action', 'safe_reason_code', 'dry_run', 'created_at'],
  [
    { name: 'uq_ca_meta_replay_audit_tenant_id', columns: ['tenant_id', 'id'], unique: true },
    { name: 'ix_ca_meta_replay_audit_scope_created', columns: ['tenant_id', 'scope_ref', 'created_at'], unique: false },
  ],
  `CREATE TABLE IF NOT EXISTS ca_meta_replay_audit (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    dead_letter_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operator_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    authorization_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    scope_ref VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    action VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    safe_reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    dry_run TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ca_meta_replay_audit_tenant_id (tenant_id, id),
    KEY ix_ca_meta_replay_audit_scope_created (tenant_id, scope_ref, created_at),
    CONSTRAINT fk_ca_meta_replay_audit_dlq FOREIGN KEY (tenant_id, dead_letter_id) REFERENCES ca_meta_job_dead_letters (tenant_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT ck_ca_meta_replay_audit_dry_run CHECK (
      (dry_run = 1 AND action IN ('DRY_RUN_ALLOWED', 'DRY_RUN_DENIED')) OR
      (dry_run = 0 AND action IN ('REQUEUE_ALLOWED', 'REQUEUE_DENIED'))
    )
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
);

const migrationWithoutChecksum: DurableMigration = {
  id: '202610290003-durable-work-inbox-outbox',
  schemaVersion: 3,
  minimumSupportedApiVersion: 1,
  steps: [
    createJobs,
    createAttempts,
    createOutbox,
    createInbox,
    createDeadLetters,
    createReplayAudit,
    immutableAuditTrigger('replay-audit-no-update', 'UPDATE'),
    immutableAuditTrigger('replay-audit-no-delete', 'DELETE'),
  ],
};

export const DURABLE_WORK_MIGRATION = migrationWithoutChecksum;

export const DURABLE_WORK_TABLES = [
  'ca_meta_jobs',
  'ca_meta_job_attempts',
  'ca_meta_outbox_events',
  'ca_meta_inbox_events',
  'ca_meta_job_dead_letters',
  'ca_meta_replay_audit',
] as const;

export async function verifyDurableWorkTables(queryRunner: QueryRunner): Promise<void> {
  for (const table of DURABLE_WORK_TABLES) {
    if (!(await tableExists(queryRunner, table))) throw new Error(`Durable-work schema is missing ${table}.`);
  }
}
