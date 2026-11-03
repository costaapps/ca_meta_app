import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { DataSource, EntityManager } from 'typeorm';
import {
  canonicalJson,
  isJobType,
  isUuid,
  JOB_POLICIES,
  MAX_ACTIVE_JOBS_PER_TENANT,
  MAX_WAITING_JOBS_PER_TENANT,
  parseJobPayload,
  retryDelayMs,
  type EffectMode,
  type JobLane,
  type JobPayload,
  type JobType,
} from './event-validation.js';
import type { DurableWorkDatabase } from './durable-work-database.js';

export interface EnqueueJobInput {
  readonly tenantId: string;
  readonly type: JobType;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  /** Known target identity (asset, onboarding, projection); otherwise derived from the payload reference. */
  readonly resourceScopeRef?: string;
  readonly payload: unknown;
}

export interface EnqueuedJob {
  readonly id: string;
  readonly duplicate: boolean;
}

export interface ClaimedJob {
  readonly id: string;
  readonly tenantId: string;
  readonly type: JobType;
  readonly lane: JobLane;
  readonly effectMode: EffectMode;
  readonly payload: JobPayload;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly claimToken: string;
  readonly workerRef: string;
  readonly budgetStartedAt: string;
  readonly createdAt: string;
}

export type JobOutcome =
  | { readonly kind: 'SUCCEEDED' }
  | { readonly kind: 'RETRYABLE_FAILURE'; readonly safeErrorCode: string }
  | { readonly kind: 'PERMANENT_FAILURE'; readonly safeErrorCode: string }
  | { readonly kind: 'UNKNOWN'; readonly safeErrorCode: string };

export interface JobFinalization {
  readonly status: 'SUCCEEDED' | 'RETRY_PENDING' | 'UNKNOWN' | 'DEAD_LETTER';
  readonly safeErrorCode: string | null;
  readonly safeErrorAction: string | null;
}

export interface JobStore {
  enqueue(input: EnqueueJobInput): Promise<EnqueuedJob>;
  enqueueWithin(manager: EntityManager, input: EnqueueJobInput): Promise<EnqueuedJob>;
  claimNext(workerRef: string, leaseMs: number, supportedTypes: readonly JobType[]): Promise<ClaimedJob | null>;
  renew(job: ClaimedJob, leaseMs: number): Promise<boolean>;
  finish(
    job: ClaimedJob,
    outcome: JobOutcome,
    random?: () => number,
    applyWithin?: (manager: EntityManager, finalization: JobFinalization) => Promise<void>,
  ): Promise<boolean>;
}

interface JobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  schema_version: number | string;
  lane: string;
  effect_mode: string;
  idempotency_key: string;
  resource_scope_ref: string;
  correlation_id: string;
  causation_id: string | null;
  payload_json: string | Buffer | JobPayload;
  attempt: number | string;
  max_attempts: number | string;
  claim_token: string;
  budget_started_at: string | Date;
  budget_elapsed_ms?: string | number | null;
  created_at: string | Date;
}

interface ResultHeader {
  affectedRows?: number;
}

const SAFE_ERROR_CODES = new Set([
  'DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_TIMEOUT', 'ATTEMPT_BUDGET_EXHAUSTED',
  'ATTEMPTS_EXHAUSTED', 'LEASE_EXPIRED', 'LEASE_HEARTBEAT_LOST',
  'PROVIDER_RESULT_UNKNOWN', 'HANDLER_FAILED', 'HANDLER_NOT_REGISTERED',
  'INVALID_REFERENCE', 'UNSUPPORTED_JOB_TYPE',
]);

const SAFE_ACTION_BY_CODE: Readonly<Record<string, string>> = {
  DEPENDENCY_UNAVAILABLE: 'RETRY_LATER',
  DEPENDENCY_TIMEOUT: 'RETRY_LATER',
  ATTEMPT_BUDGET_EXHAUSTED: 'CONTACT_SUPPORT',
  ATTEMPTS_EXHAUSTED: 'CONTACT_SUPPORT',
  LEASE_EXPIRED: 'CHECK_STATUS',
  LEASE_HEARTBEAT_LOST: 'CHECK_STATUS',
  PROVIDER_RESULT_UNKNOWN: 'CHECK_STATUS',
  HANDLER_FAILED: 'CONTACT_SUPPORT',
  HANDLER_NOT_REGISTERED: 'CONTACT_SUPPORT',
  INVALID_REFERENCE: 'CONTACT_SUPPORT',
  UNSUPPORTED_JOB_TYPE: 'CONTACT_SUPPORT',
};

function safeCode(value: string): string {
  return SAFE_ERROR_CODES.has(value) ? value : 'HANDLER_FAILED';
}

function rowAffected(result: unknown): number {
  if (Array.isArray(result)) return result.length === 0 ? 0 : rowAffected(result[0]);
  if (typeof result === 'object' && result !== null && 'affectedRows' in result) {
    return Number((result as ResultHeader).affectedRows ?? 0);
  }
  return 0;
}

export function decodeStoredJobPayload(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  if (Buffer.isBuffer(value)) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown;
  return value;
}

function parsePayload(value: string | Buffer | JobPayload): JobPayload {
  return decodeStoredJobPayload(value) as JobPayload;
}

function formatDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z');
}

function boundedLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) {
    throw new RangeError('leaseMs must be an integer in [100, 300000].');
  }
}

function validateEnqueue(input: EnqueueJobInput): JobPayload {
  if (!isUuid(input.tenantId)) throw new Error('Invalid internal tenant reference.');
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.idempotencyKey)) throw new Error('Invalid idempotency key.');
  if (input.correlationId.length < 1 || input.correlationId.length > 128) throw new Error('Invalid correlation reference.');
  if (input.causationId !== undefined && input.causationId !== null && input.causationId.length > 128) {
    throw new Error('Invalid causation reference.');
  }
  if (input.resourceScopeRef !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(input.resourceScopeRef)) {
    throw new Error('Invalid resource scope reference.');
  }
  return parseJobPayload(input.type, input.payload);
}

function resourceScope(input: EnqueueJobInput, payload: JobPayload): string {
  if (input.resourceScopeRef) return input.resourceScopeRef;
  switch (payload.kind) {
    case 'INBOX_PROCESS': return payload.inboxEventRef;
    case 'OUTBOX_DELIVER': return payload.outboxEventRef;
    case 'ONBOARDING_STEP': return payload.onboardingRef;
    case 'PROJECTION_RECONCILE': return payload.projectionRef;
    case 'HISTORY_SYNC': return payload.checkpointRef;
    case 'CREDENTIAL_INSPECTION': return payload.credentialId;
    case 'ASSET_REFRESH': return payload.assetId;
  }
}

export class DurableJobStore implements JobStore {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly random: () => number = Math.random,
  ) {}

  async enqueue(input: EnqueueJobInput): Promise<EnqueuedJob> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction((manager) => this.enqueueWithin(manager, input));
  }

  async enqueueWithin(manager: EntityManager, input: EnqueueJobInput): Promise<EnqueuedJob> {
    const payload = validateEnqueue(input);
    const policy = JOB_POLICIES[input.type];
    const resourceScopeRef = resourceScope(input, payload);
    const serialized = canonicalJson(payload);
    const payloadHash = createHash('sha256').update(serialized).digest();

    const tenantRows = await manager.query(
      'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE',
      [input.tenantId],
    ) as Array<{ id: string }>;
    if (tenantRows.length !== 1) throw new Error('Internal tenant reference does not exist.');

    const existing = await manager.query(
      `SELECT id, HEX(payload_hash) AS payload_hash, correlation_id, causation_id, resource_scope_ref
       FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = ? AND idempotency_key = ? FOR UPDATE`,
      [input.tenantId, input.type, input.idempotencyKey],
    ) as Array<{ id: string; payload_hash: string; correlation_id: string; causation_id: string | null; resource_scope_ref: string }>;
    if (existing[0]) {
      const row = existing[0];
      if (
        row.payload_hash.toLowerCase() !== payloadHash.toString('hex') ||
        row.correlation_id !== input.correlationId ||
        row.causation_id !== (input.causationId ?? null) ||
        row.resource_scope_ref !== resourceScopeRef
      ) throw new Error('Idempotency key conflicts with an existing job.');
      return { id: row.id, duplicate: true };
    }

    const backlogRows = await manager.query(
      `SELECT COUNT(*) AS count FROM ca_meta_jobs
       WHERE tenant_id = ? AND status IN ('QUEUED', 'RETRY_PENDING')`,
      [input.tenantId],
    ) as Array<{ count: string | number }>;
    if (Number(backlogRows[0]?.count ?? 0) >= MAX_WAITING_JOBS_PER_TENANT) {
      throw new Error('Tenant durable-job backlog limit reached.');
    }

    const id = randomUUID();
    await manager.query(
      `INSERT INTO ca_meta_jobs
       (id, tenant_id, job_type, schema_version, lane, effect_mode, idempotency_key, correlation_id,
        resource_scope_ref, causation_id, payload_hash, payload_json, status, attempt, max_attempts, next_run_at,
        created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        id, input.tenantId, input.type, policy.lane, policy.effectMode, input.idempotencyKey,
        input.correlationId, resourceScopeRef, input.causationId ?? null, payloadHash, serialized, policy.maxAttempts,
      ],
    );
    return { id, duplicate: false };
  }

  async claimNext(workerRef: string, leaseMs: number, supportedTypes: readonly JobType[]): Promise<ClaimedJob | null> {
    boundedLease(leaseMs);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(workerRef)) throw new Error('Invalid worker reference.');
    const supported = [...new Set(supportedTypes)];
    if (supported.length === 0) return null;
    const dataSource = await this.database.getDataSource();
    await this.resolveExpiredAmbiguous(dataSource);
    const lanePriority: readonly JobLane[] = ['WEBHOOK_URGENT', 'ONBOARDING', 'HISTORICAL_PROJECTION'];
    const typePlaceholders = supported.map(() => '?').join(', ');

    // Keep lane priority independent so historical work is not scanned to discover urgent jobs.
    // A locked persistent cursor serializes each lane's turn across workers; the candidate query
    // runs only after acquiring that lock, so it cannot reuse a stale dispatch snapshot.
    for (const lane of lanePriority) {
      // Keep duplicate-key initialization outside the locking transaction: concurrent
      // INSERT IGNORE statements can otherwise hold shared duplicate-key locks that both
      // workers then try to upgrade with the cursor's SELECT ... FOR UPDATE.
      await dataSource.query(
        `INSERT IGNORE INTO ca_meta_job_lane_dispatch (lane, last_tenant_id, updated_at)
         VALUES (?, NULL, UTC_TIMESTAMP(6))`,
        [lane],
      );
      // Read-committed counts refresh after the tenant lock without waiting on heartbeat row writes.
      const claimed = await dataSource.transaction('READ COMMITTED', async (manager) => {
        const dispatchRows = await manager.query(
          'SELECT last_tenant_id FROM ca_meta_job_lane_dispatch WHERE lane = ? FOR UPDATE',
          [lane],
        ) as Array<{ last_tenant_id: string | null }>;
        const dispatch = dispatchRows[0];
        if (!dispatch) throw new Error('Job lane dispatch cursor could not be locked.');

        // The due-job predicate keeps this lookup on lane/status/due indexes and excludes
        // terminal history. Only the compact per-lane cursor is persistent fairness state.
        const candidates = await manager.query(
          `SELECT ready.tenant_id
           FROM (
             SELECT tenant_id
             FROM ca_meta_jobs
             WHERE lane = ? AND job_type IN (${typePlaceholders}) AND NOT EXISTS (
               SELECT 1 FROM ca_meta_jobs active
               WHERE active.tenant_id = ca_meta_jobs.tenant_id
                 AND active.resource_scope_ref = ca_meta_jobs.resource_scope_ref
                 AND active.status = 'RUNNING' AND active.lease_expires_at > UTC_TIMESTAMP(6)
             ) AND (
               (status IN ('QUEUED', 'RETRY_PENDING') AND next_run_at <= UTC_TIMESTAMP(6)) OR
               (status = 'RUNNING' AND effect_mode <> 'AMBIGUOUS' AND lease_expires_at <= UTC_TIMESTAMP(6))
             )
             GROUP BY tenant_id
           ) ready
           WHERE (SELECT COUNT(*) FROM ca_meta_jobs active_tenant
                  WHERE active_tenant.tenant_id = ready.tenant_id AND active_tenant.status = 'RUNNING'
                    AND active_tenant.lease_expires_at > UTC_TIMESTAMP(6)) < ?
           ORDER BY CASE WHEN ? IS NULL OR ready.tenant_id > ? THEN 0 ELSE 1 END, ready.tenant_id
           LIMIT 64`,
          [lane, ...supported, MAX_ACTIVE_JOBS_PER_TENANT, dispatch.last_tenant_id, dispatch.last_tenant_id],
        ) as Array<{ tenant_id: string }>;

        for (const candidate of candidates) {
          const tenants = await manager.query(
            'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE SKIP LOCKED',
            [candidate.tenant_id],
          ) as Array<{ id: string }>;
          if (tenants.length !== 1) continue;

          const rows = await manager.query(
            `SELECT id, tenant_id, job_type, schema_version, lane, effect_mode, resource_scope_ref, idempotency_key,
                    correlation_id, causation_id, payload_json, attempt, max_attempts,
                    claim_token, budget_started_at,
                    TIMESTAMPDIFF(MICROSECOND, budget_started_at, UTC_TIMESTAMP(6)) DIV 1000 AS budget_elapsed_ms,
                    created_at
             FROM ca_meta_jobs
             WHERE tenant_id = ? AND lane = ? AND job_type IN (${typePlaceholders}) AND NOT EXISTS (
               SELECT 1 FROM ca_meta_jobs active
               WHERE active.tenant_id = ca_meta_jobs.tenant_id
                 AND active.resource_scope_ref = ca_meta_jobs.resource_scope_ref
                 AND active.status = 'RUNNING' AND active.lease_expires_at > UTC_TIMESTAMP(6)
             ) AND (
               (status IN ('QUEUED', 'RETRY_PENDING') AND next_run_at <= UTC_TIMESTAMP(6)) OR
               (status = 'RUNNING' AND effect_mode <> 'AMBIGUOUS' AND lease_expires_at <= UTC_TIMESTAMP(6))
             )
             ORDER BY COALESCE(lease_expires_at, next_run_at), created_at, id
             LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [candidate.tenant_id, lane, ...supported],
          ) as JobRow[];
          const row = rows[0];
          if (!row) continue;

          const activeRows = await manager.query(
            `SELECT COUNT(*) AS count FROM ca_meta_jobs
             WHERE tenant_id = ? AND status = 'RUNNING' AND lease_expires_at > UTC_TIMESTAMP(6)`,
            [candidate.tenant_id],
          ) as Array<{ count: string | number }>;
          if (Number(activeRows[0]?.count ?? 0) >= MAX_ACTIVE_JOBS_PER_TENANT) continue;

          const resourceRows = await manager.query(
            `SELECT COUNT(*) AS count FROM ca_meta_jobs
             WHERE tenant_id = ? AND resource_scope_ref = ? AND status = 'RUNNING'
               AND lease_expires_at > UTC_TIMESTAMP(6)`,
            [candidate.tenant_id, row.resource_scope_ref],
          ) as Array<{ count: string | number }>;
          if (Number(resourceRows[0]?.count ?? 0) > 0) continue;

          const type = row.job_type;
          if (!isJobType(type)) {
            await this.deadLetterLocked(manager, row, 'UNSUPPORTED_JOB_TYPE');
            continue;
          }
          const policy = JOB_POLICIES[type];
          if (row.effect_mode !== policy.effectMode || row.lane !== policy.lane) {
            await this.deadLetterLocked(manager, row, 'UNSUPPORTED_JOB_TYPE');
            continue;
          }

          const attempt = Number(row.attempt);
          const budgetStartedAt = row.budget_started_at ? formatDate(row.budget_started_at) : null;
          const budgetElapsed = Number(row.budget_elapsed_ms ?? 0);
          if (attempt >= Number(row.max_attempts)) {
            await this.deadLetterLocked(manager, row, 'ATTEMPTS_EXHAUSTED');
            continue;
          }
          if (budgetStartedAt && budgetElapsed >= policy.maxElapsedMs) {
            await this.deadLetterLocked(manager, row, 'ATTEMPT_BUDGET_EXHAUSTED');
            continue;
          }

          if (row.claim_token) {
            const delayMs = retryDelayMs(policy, Math.max(1, attempt), this.random);
            if (budgetStartedAt && budgetElapsed + delayMs >= policy.maxElapsedMs) {
              await this.deadLetterLocked(manager, row, 'ATTEMPT_BUDGET_EXHAUSTED');
              continue;
            }
            await manager.query(
              `UPDATE ca_meta_job_attempts
               SET outcome = 'RETRY_PENDING', safe_error_code = 'LEASE_EXPIRED', safe_error_action = 'RETRY_LATER',
                   finished_at = UTC_TIMESTAMP(6),
                   duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, UTC_TIMESTAMP(6)) DIV 1000
               WHERE tenant_id = ? AND job_id = ? AND attempt = ? AND outcome = 'RUNNING'`,
              [row.tenant_id, row.id, attempt],
            );
            await manager.query(
              `UPDATE ca_meta_jobs
               SET status = 'RETRY_PENDING', next_run_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${delayMs * 1000} MICROSECOND),
                   lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
                   last_safe_error_code = 'LEASE_EXPIRED', last_safe_error_action = 'RETRY_LATER',
                   updated_at = UTC_TIMESTAMP(6)
               WHERE id = ? AND tenant_id = ?`,
              [row.id, row.tenant_id],
            );
            continue;
          }

          const claimToken = randomUUID();
          const nextAttempt = attempt + 1;
          const leaseMicros = leaseMs * 1000;
          await manager.query(
            `UPDATE ca_meta_jobs
             SET status = 'RUNNING', attempt = ?, claim_token = ?, lease_owner = ?,
                 lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseMicros} MICROSECOND),
                 heartbeat_at = UTC_TIMESTAMP(6), budget_started_at = COALESCE(budget_started_at, UTC_TIMESTAMP(6)),
                 updated_at = UTC_TIMESTAMP(6)
             WHERE id = ? AND tenant_id = ?`,
            [nextAttempt, claimToken, workerRef, row.id, row.tenant_id],
          );
          await manager.query(
            `INSERT INTO ca_meta_job_attempts
             (id, tenant_id, job_id, attempt, worker_ref, outcome, started_at)
             VALUES (?, ?, ?, ?, ?, 'RUNNING', UTC_TIMESTAMP(6))`,
            [randomUUID(), row.tenant_id, row.id, nextAttempt, workerRef],
          );
          await manager.query(
            `UPDATE ca_meta_job_lane_dispatch
             SET last_tenant_id = ?, updated_at = UTC_TIMESTAMP(6)
             WHERE lane = ?`,
            [row.tenant_id, lane],
          );
          const updated = { ...row, claim_token: claimToken, attempt: nextAttempt };
          return this.toClaimedJob(updated, type, workerRef, budgetStartedAt ?? new Date().toISOString());
        }
        return null;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  async renew(job: ClaimedJob, leaseMs: number): Promise<boolean> {
    boundedLease(leaseMs);
    const dataSource = await this.database.getDataSource();
    const leaseMicros = leaseMs * 1000;
    const result: unknown = await dataSource.query(
      `UPDATE ca_meta_jobs
       SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${leaseMicros} MICROSECOND),
           heartbeat_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND tenant_id = ? AND status = 'RUNNING' AND claim_token = ?
         AND lease_expires_at > UTC_TIMESTAMP(6)`,
      [job.id, job.tenantId, job.claimToken],
    );
    return rowAffected(result) === 1;
  }

  async finish(
    job: ClaimedJob,
    outcome: JobOutcome,
    random: () => number = this.random,
    applyWithin?: (manager: EntityManager, finalization: JobFinalization) => Promise<void>,
  ): Promise<boolean> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const tenantRows = await manager.query(
        'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE',
        [job.tenantId],
      ) as Array<{ id: string }>;
      if (tenantRows.length !== 1) return false;
      const rows = await manager.query(
        `SELECT id, tenant_id, job_type, lane, effect_mode, attempt, max_attempts,
                budget_started_at, claim_token,
                TIMESTAMPDIFF(MICROSECOND, budget_started_at, UTC_TIMESTAMP(6)) DIV 1000 AS budget_elapsed_ms
         FROM ca_meta_jobs
         WHERE id = ? AND tenant_id = ? AND status = 'RUNNING' AND claim_token = ?
           AND lease_expires_at > UTC_TIMESTAMP(6)
         FOR UPDATE`,
        [job.id, job.tenantId, job.claimToken],
      ) as Array<{
        id: string; tenant_id: string; job_type: string; lane: string; effect_mode: string;
        attempt: number | string; max_attempts: number | string; budget_started_at: string | Date | null;
        claim_token: string; budget_elapsed_ms: number | string | null;
      }>;
      const current = rows[0];
      if (!current) return false;
      const policy = JOB_POLICIES[job.type];
      const attempt = Number(current.attempt);
      const rawError = outcome.kind === 'SUCCEEDED' ? null : safeCode(outcome.safeErrorCode);
      let nextStatus: JobFinalization['status'];
      let retryDelay: number | null = null;
      let terminalRetryReason: 'ATTEMPTS_EXHAUSTED' | 'ATTEMPT_BUDGET_EXHAUSTED' | null = null;

      if (outcome.kind === 'SUCCEEDED') {
        nextStatus = 'SUCCEEDED';
      } else if (outcome.kind === 'UNKNOWN' || (outcome.kind === 'RETRYABLE_FAILURE' && current.effect_mode === 'AMBIGUOUS')) {
        nextStatus = 'UNKNOWN';
      } else if (
        outcome.kind === 'RETRYABLE_FAILURE' &&
        (current.effect_mode === 'SAFE_RETRY' || current.effect_mode === 'IDEMPOTENT') &&
        attempt < Number(current.max_attempts)
      ) {
        const baseDelay = retryDelayMs(policy, attempt, random);
        const elapsed = Number(current.budget_elapsed_ms ?? 0);
        if (elapsed + baseDelay < policy.maxElapsedMs) {
          nextStatus = 'RETRY_PENDING';
          retryDelay = baseDelay;
        } else {
          nextStatus = 'DEAD_LETTER';
          terminalRetryReason = 'ATTEMPT_BUDGET_EXHAUSTED';
        }
      } else {
        nextStatus = 'DEAD_LETTER';
        if (outcome.kind === 'RETRYABLE_FAILURE' && attempt >= Number(current.max_attempts)) {
          terminalRetryReason = 'ATTEMPTS_EXHAUSTED';
        }
      }

      const code = terminalRetryReason ?? rawError;
      const action = code ? SAFE_ACTION_BY_CODE[code] ?? 'CONTACT_SUPPORT' : null;
      const finalization: JobFinalization = { status: nextStatus, safeErrorCode: code, safeErrorAction: action };
      if (applyWithin) await applyWithin(manager, finalization);
      const clearLease = `lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL`;
      if (retryDelay !== null) {
        await manager.query(
          `UPDATE ca_meta_jobs
           SET status = ?, next_run_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${retryDelay * 1000} MICROSECOND),
               ${clearLease}, last_safe_error_code = ?, last_safe_error_action = ?, updated_at = UTC_TIMESTAMP(6)
           WHERE id = ?`,
          [nextStatus, code, action, job.id],
        );
      } else {
        await manager.query(
          `UPDATE ca_meta_jobs
           SET status = ?, ${clearLease}, last_safe_error_code = ?, last_safe_error_action = ?,
               completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
           WHERE id = ?`,
          [nextStatus, code, action, job.id],
        );
      }
      await manager.query(
        `UPDATE ca_meta_job_attempts
         SET outcome = ?, safe_error_code = ?, safe_error_action = ?, finished_at = UTC_TIMESTAMP(6),
             duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, UTC_TIMESTAMP(6)) DIV 1000
         WHERE tenant_id = ? AND job_id = ? AND attempt = ? AND outcome = 'RUNNING'`,
        [nextStatus, code, action, job.tenantId, job.id, attempt],
      );
      if (nextStatus === 'DEAD_LETTER') {
        await this.insertDeadLetter(manager, {
          id: job.id, tenant_id: job.tenantId, job_type: job.type, lane: job.lane,
          attempt, safeErrorCode: code ?? 'HANDLER_FAILED', safeErrorAction: action ?? 'CONTACT_SUPPORT',
        });
      }
      return true;
    });
  }

  private async resolveExpiredAmbiguous(dataSource: DataSource): Promise<void> {
    const expired = await dataSource.query(
      `SELECT id, tenant_id, attempt FROM ca_meta_jobs
       WHERE status = 'RUNNING' AND effect_mode = 'AMBIGUOUS' AND lease_expires_at <= UTC_TIMESTAMP(6)
       ORDER BY lease_expires_at, id LIMIT 64`,
    ) as Array<{ id: string; tenant_id: string; attempt: number | string }>;
    for (const stale of expired) {
      await dataSource.transaction(async (manager) => {
        const tenants = await manager.query(
          'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE SKIP LOCKED',
          [stale.tenant_id],
        ) as Array<{ id: string }>;
        if (tenants.length !== 1) return;
        const rows = await manager.query(
          `SELECT id, job_type, payload_json, attempt FROM ca_meta_jobs
           WHERE id = ? AND tenant_id = ? AND status = 'RUNNING' AND effect_mode = 'AMBIGUOUS'
             AND lease_expires_at <= UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [stale.id, stale.tenant_id],
        ) as Array<{ id: string; job_type: string; payload_json: string | Buffer | JobPayload; attempt: number | string }>;
        const row = rows[0];
        if (!row) return;
        await manager.query(
          `UPDATE ca_meta_jobs
           SET status = 'UNKNOWN', lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
               last_safe_error_code = 'LEASE_EXPIRED', last_safe_error_action = 'CHECK_STATUS',
               completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
           WHERE id = ? AND tenant_id = ?`,
          [row.id, stale.tenant_id],
        );
        if (row.job_type === 'OUTBOX_DELIVER') {
          const payload = parseJobPayload('OUTBOX_DELIVER', parsePayload(row.payload_json));
          if (payload.kind !== 'OUTBOX_DELIVER') throw new Error('Expired outbox job has an invalid payload.');
          const outboxResult = await manager.query(
            `UPDATE ca_meta_outbox_events SET delivery_state = 'UNKNOWN', attempt = GREATEST(attempt, ?)
             WHERE id = ? AND tenant_id = ? AND delivery_state = 'PENDING'`,
            [Number(row.attempt), payload.outboxEventRef, stale.tenant_id],
          );
          if (rowAffected(outboxResult) !== 1) throw new Error('Expired ambiguous outbox job has no pending event projection.');
        }
        await manager.query(
          `UPDATE ca_meta_job_attempts
           SET outcome = 'UNKNOWN', safe_error_code = 'LEASE_EXPIRED', safe_error_action = 'CHECK_STATUS',
               finished_at = UTC_TIMESTAMP(6),
               duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, UTC_TIMESTAMP(6)) DIV 1000
           WHERE tenant_id = ? AND job_id = ? AND attempt = ? AND outcome = 'RUNNING'`,
          [stale.tenant_id, row.id, Number(row.attempt)],
        );
      });
    }
  }

  private async deadLetterLocked(manager: EntityManager, row: JobRow, errorCode: string): Promise<void> {
    const code = safeCode(errorCode);
    const action = SAFE_ACTION_BY_CODE[code] ?? 'CONTACT_SUPPORT';
    await manager.query(
      `UPDATE ca_meta_jobs
       SET status = 'DEAD_LETTER', lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
           last_safe_error_code = ?, last_safe_error_action = ?, completed_at = UTC_TIMESTAMP(6),
           updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND tenant_id = ?`,
      [code, action, row.id, row.tenant_id],
    );
    await this.insertDeadLetter(manager, {
      id: row.id,
      tenant_id: row.tenant_id,
      job_type: row.job_type,
      lane: row.lane,
      attempt: Number(row.attempt),
      safeErrorCode: code,
      safeErrorAction: action,
    });
    if (row.job_type === 'INBOX_PROCESS') {
      const payload = parseJobPayload('INBOX_PROCESS', parsePayload(row.payload_json));
      if (payload.kind !== 'INBOX_PROCESS') throw new Error('Inbox job has an invalid payload.');
      const inboxResult = await manager.query(
        `UPDATE ca_meta_inbox_events SET processing_state = 'DEAD_LETTER'
         WHERE id = ? AND tenant_id = ? AND routing_state = 'ROUTED' AND processing_state IN ('PENDING', 'RUNNING')`,
        [payload.inboxEventRef, row.tenant_id],
      );
      if (rowAffected(inboxResult) !== 1) throw new Error('Dead-lettered inbox job has no pending event projection.');
    } else if (row.job_type === 'OUTBOX_DELIVER') {
      const payload = parseJobPayload('OUTBOX_DELIVER', parsePayload(row.payload_json));
      if (payload.kind !== 'OUTBOX_DELIVER') throw new Error('Outbox job has an invalid payload.');
      const outboxResult = await manager.query(
        `UPDATE ca_meta_outbox_events SET delivery_state = 'DEAD_LETTER', attempt = GREATEST(attempt, ?)
         WHERE id = ? AND tenant_id = ? AND delivery_state = 'PENDING'`,
        [Number(row.attempt), payload.outboxEventRef, row.tenant_id],
      );
      if (rowAffected(outboxResult) !== 1) throw new Error('Dead-lettered outbox job has no pending event projection.');
    }
  }

  private async insertDeadLetter(
    manager: EntityManager,
    row: { id: string; tenant_id: string; job_type: string; lane: string; attempt: number; safeErrorCode: string; safeErrorAction: string },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO ca_meta_job_dead_letters
       (id, tenant_id, job_id, job_type, lane, safe_error_code, safe_error_action, attempt_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), row.tenant_id, row.id, row.job_type, row.lane, row.safeErrorCode, row.safeErrorAction, row.attempt],
    );
  }

  private toClaimedJob(row: JobRow, type: JobType, workerRef: string, budgetStartedAt: string): ClaimedJob {
    const payload = parseJobPayload(type, parsePayload(row.payload_json));
    return {
      id: row.id,
      tenantId: row.tenant_id,
      type,
      lane: row.lane as JobLane,
      effectMode: row.effect_mode as EffectMode,
      payload,
      idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      attempt: Number(row.attempt),
      maxAttempts: Number(row.max_attempts),
      claimToken: row.claim_token,
      workerRef,
      budgetStartedAt,
      createdAt: formatDate(row.created_at),
    };
  }
}
