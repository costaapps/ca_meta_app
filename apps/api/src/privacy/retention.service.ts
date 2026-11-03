import { randomUUID } from 'node:crypto';
import type { RuntimeEnvironment } from '../config/environment.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { AuditEventWriter, privacyRefHash } from './audit.service.js';
import { isSafeOpaqueReference } from './redaction.js';

export const RETENTION_CATEGORY = 'MAGIC_LINK_TRANSIENT' as const;
export type RetentionCategory = typeof RETENTION_CATEGORY;
export type RetentionPolicyStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED';
export type RetentionRunStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED';

export type RetentionOperation = 'CREATE_POLICY' | 'ACTIVATE_POLICY' | 'START_PURGE' | 'CONTINUE_PURGE';
export interface RetentionAuthorizationRequest {
  readonly tenantId: string;
  readonly environment: RuntimeEnvironment;
  readonly actorRef: string;
  readonly operation: RetentionOperation;
  readonly resourceRef?: string;
}
export interface RetentionAuthorizationGrant extends RetentionAuthorizationRequest { readonly expiresAt: string }
export interface RetentionAuthorizationPort {
  authorize(input: RetentionAuthorizationRequest): Promise<RetentionAuthorizationGrant | null>;
}
export class FailClosedRetentionAuthorization implements RetentionAuthorizationPort {
  async authorize(_input: RetentionAuthorizationRequest): Promise<null> { return null; }
}

export interface RetentionBatchResult {
  readonly runId: string;
  readonly status: RetentionRunStatus;
  readonly phase: 'MAIL_QUEUE' | 'LINKS' | 'COMPLETE';
  readonly deleted: number;
  readonly totalDeleted: number;
}

interface PolicyRow { readonly id: string; readonly retention_seconds: string | number; readonly policy_version: string }
interface RunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly policy_id: string;
  readonly environment: RuntimeEnvironment;
  readonly category: RetentionCategory;
  readonly cutoff_at: string | Date;
  readonly phase: 'MAIL_QUEUE' | 'LINKS' | 'COMPLETE';
  readonly cursor_ref: string | null;
  readonly status: RetentionRunStatus;
  readonly deleted_count: string | number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const SAFE_REF = /^[A-Za-z0-9:_-]{1,128}$/;
function validGrant(grant: RetentionAuthorizationGrant | null, input: RetentionAuthorizationRequest): boolean {
  return !!grant && grant.tenantId === input.tenantId && grant.environment === input.environment &&
    grant.actorRef === input.actorRef && grant.operation === input.operation && grant.resourceRef === input.resourceRef &&
    Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now();
}
function sqlDate(value: Date): string { return value.toISOString().replace('T', ' ').replace('Z', ''); }
function affectedRows(value: unknown): number {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === 'object' && header !== null && 'affectedRows' in header
    ? Number((header as { affectedRows?: number }).affectedRows ?? 0) : 0;
}

/** Retention policies have no default duration and all execution is deny-by-default. */
export class RetentionService {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly audit: AuditEventWriter,
    private readonly authorization: RetentionAuthorizationPort = new FailClosedRetentionAuthorization(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createDraftPolicy(input: {
    readonly tenantId: string;
    readonly environment: RuntimeEnvironment;
    readonly actorRef: string;
    readonly retentionSeconds: number;
    readonly policyVersion: string;
    readonly correlationId: string;
  }): Promise<string> {
    const auth: RetentionAuthorizationRequest = { ...input, operation: 'CREATE_POLICY' };
    if (!UUID.test(input.tenantId) || !SAFE_REF.test(input.actorRef) || input.policyVersion.length > 32 || !isSafeOpaqueReference(input.policyVersion) ||
      !isSafeOpaqueReference(input.correlationId) || !Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 1 ||
      input.retentionSeconds > 2_147_483_647 || !validGrant(await this.authorization.authorize(auth), auth)) {
      throw new Error('Retention policy creation denied.');
    }
    const database = await this.database.getDataSource();
    const id = randomUUID();
    await database.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO ca_meta_retention_policies
         (id, tenant_id, environment, category, retention_seconds, policy_version, status, approval_ref, created_by_ref_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', NULL, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [id, input.tenantId, input.environment, RETENTION_CATEGORY, input.retentionSeconds,
          input.policyVersion, privacyRefHash(input.actorRef)],
      );
      await this.audit.record({
        tenantId: input.tenantId, actorRef: input.actorRef, action: 'RETENTION_POLICY_CREATED',
        targetRef: id, correlationId: input.correlationId, retentionClass: 'SECURITY',
        policyVersion: input.policyVersion, safeDiff: { status: 'DRAFT' },
      }, manager);
    });
    return id;
  }

  async activatePolicy(input: {
    readonly tenantId: string;
    readonly environment: RuntimeEnvironment;
    readonly actorRef: string;
    readonly policyId: string;
    readonly approvalRef: string;
    readonly correlationId: string;
  }): Promise<boolean> {
    if (input.environment !== 'test') throw new Error('This retention adapter is limited to synthetic test data.');
    const auth: RetentionAuthorizationRequest = {
      tenantId: input.tenantId, environment: input.environment, actorRef: input.actorRef,
      operation: 'ACTIVATE_POLICY', resourceRef: input.policyId,
    };
    if (!UUID.test(input.tenantId) || !UUID.test(input.policyId) || !SAFE_REF.test(input.actorRef) ||
      !isSafeOpaqueReference(input.approvalRef) || !isSafeOpaqueReference(input.correlationId) ||
      !validGrant(await this.authorization.authorize(auth), auth)) throw new Error('Retention policy activation denied.');
    const database = await this.database.getDataSource();
    return database.transaction(async (manager) => {
      const tenants = await manager.query('SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE', [input.tenantId]) as Array<{ id: string }>;
      if (!tenants[0]) return false;
      const rows = await manager.query(
        `SELECT id FROM ca_meta_retention_policies
         WHERE tenant_id = ? AND environment = ? AND id = ? AND category = ? AND status = 'DRAFT' FOR UPDATE`,
        [input.tenantId, input.environment, input.policyId, RETENTION_CATEGORY],
      ) as Array<{ id: string }>;
      if (!rows[0]) return false;
      await manager.query(
        `UPDATE ca_meta_retention_policies SET status = 'DISABLED', updated_at = UTC_TIMESTAMP(6)
         WHERE tenant_id = ? AND environment = ? AND category = ? AND status = 'ACTIVE'`,
        [input.tenantId, input.environment, RETENTION_CATEGORY],
      );
      await manager.query(
        `UPDATE ca_meta_retention_policies SET status = 'ACTIVE', approval_ref = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE tenant_id = ? AND environment = ? AND id = ? AND status = 'DRAFT'`,
        [input.approvalRef, input.tenantId, input.environment, input.policyId],
      );
      await this.audit.record({
        tenantId: input.tenantId, actorRef: input.actorRef, action: 'RETENTION_POLICY_ACTIVATED',
        targetRef: input.policyId, correlationId: input.correlationId, retentionClass: 'SECURITY',
        safeDiff: { status: 'ACTIVE' },
      }, manager);
      return true;
    });
  }

  async startPurge(input: {
    readonly tenantId: string;
    readonly environment: RuntimeEnvironment;
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<string> {
    if (input.environment !== 'test') throw new Error('This retention adapter is limited to synthetic test data.');
    const auth: RetentionAuthorizationRequest = { ...input, operation: 'START_PURGE' };
    if (!UUID.test(input.tenantId) || !SAFE_REF.test(input.actorRef) || !isSafeOpaqueReference(input.correlationId) ||
      !validGrant(await this.authorization.authorize(auth), auth)) throw new Error('Retention purge denied.');
    const database = await this.database.getDataSource();
    return database.transaction(async (manager) => {
      const policies = await manager.query(
        `SELECT id, retention_seconds, policy_version FROM ca_meta_retention_policies
         WHERE tenant_id = ? AND environment = ? AND category = ? AND status = 'ACTIVE' FOR UPDATE`,
        [input.tenantId, input.environment, RETENTION_CATEGORY],
      ) as PolicyRow[];
      if (policies.length !== 1 || !policies[0]) {
        throw new Error('Exactly one active retention policy must exist for this tenant, environment, and category.');
      }
      const policy = policies[0];
      const seconds = Number(policy.retention_seconds);
      if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Retention policy duration is invalid.');
      const cutoff = sqlDate(new Date(this.now().getTime() - seconds * 1000));
      const runId = randomUUID();
      await manager.query(
        `INSERT INTO ca_meta_retention_purge_runs
         (id, tenant_id, policy_id, environment, category, cutoff_at, phase, status, deleted_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'MAIL_QUEUE', 'RUNNING', 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [runId, input.tenantId, policy.id, input.environment, RETENTION_CATEGORY, cutoff],
      );
      await this.audit.record({
        tenantId: input.tenantId, actorRef: input.actorRef, action: 'RETENTION_PURGE_STARTED',
        targetRef: runId, correlationId: input.correlationId, retentionClass: 'SECURITY',
        policyVersion: policy.policy_version, safeDiff: { status: 'RUNNING' },
      }, manager);
      return runId;
    });
  }

  /** Deletes at most one batch per call. Run cursor, progress, and audit commit atomically. */
  async continuePurge(input: {
    readonly tenantId: string;
    readonly environment: RuntimeEnvironment;
    readonly actorRef: string;
    readonly runId: string;
    readonly correlationId: string;
    readonly batchSize?: number;
  }): Promise<RetentionBatchResult> {
    if (input.environment !== 'test') throw new Error('This retention adapter is limited to synthetic test data.');
    const auth: RetentionAuthorizationRequest = {
      tenantId: input.tenantId, environment: input.environment, actorRef: input.actorRef,
      operation: 'CONTINUE_PURGE', resourceRef: input.runId,
    };
    const batchSize = input.batchSize ?? 100;
    if (!UUID.test(input.tenantId) || !UUID.test(input.runId) || !SAFE_REF.test(input.actorRef) ||
      !isSafeOpaqueReference(input.correlationId) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500 ||
      !validGrant(await this.authorization.authorize(auth), auth)) throw new Error('Retention purge continuation denied.');

    const database = await this.database.getDataSource();
    return database.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT id, tenant_id, policy_id, environment, category, cutoff_at, phase, cursor_ref, status, deleted_count
         FROM ca_meta_retention_purge_runs WHERE tenant_id = ? AND environment = ? AND id = ? FOR UPDATE`,
        [input.tenantId, input.environment, input.runId],
      ) as RunRow[];
      const run = rows[0];
      if (!run) throw new Error('Retention purge run not found.');
      if (run.status === 'COMPLETED') return {
        runId: run.id, status: run.status, phase: run.phase, deleted: 0, totalDeleted: Number(run.deleted_count),
      };
      const cutoff = typeof run.cutoff_at === 'string' ? run.cutoff_at : sqlDate(run.cutoff_at);
      let phase = run.phase;
      let cursor = run.cursor_ref;
      let status: RetentionRunStatus = 'RUNNING';
      let deleted = 0;

      if (phase === 'MAIL_QUEUE') {
        const queueRows = await manager.query(
          `SELECT q.id FROM ca_meta_magic_link_mail_queue AS q
           INNER JOIN ca_meta_magic_links AS l ON l.id = q.magic_link_id AND l.tenant_id = q.tenant_id
           WHERE q.tenant_id = ? AND l.tenant_id = ? AND l.expires_at <= ?
             AND q.status IN ('QUEUED', 'DELIVERED', 'DEAD') AND (? IS NULL OR q.id > ?)
           ORDER BY q.id LIMIT ? FOR UPDATE`,
          [input.tenantId, input.tenantId, cutoff, cursor, cursor, batchSize],
        ) as Array<{ id: string }>;
        if (queueRows.length > 0) {
          const ids = queueRows.map((row) => row.id);
          const placeholders = ids.map(() => '?').join(',');
          const result = await manager.query(
            `DELETE FROM ca_meta_magic_link_mail_queue WHERE tenant_id = ? AND id IN (${placeholders})`,
            [input.tenantId, ...ids],
          );
          deleted = affectedRows(result);
          cursor = ids[ids.length - 1] ?? cursor;
        } else {
          const processing = await manager.query(
            `SELECT q.id FROM ca_meta_magic_link_mail_queue AS q
             INNER JOIN ca_meta_magic_links AS l ON l.id = q.magic_link_id AND l.tenant_id = q.tenant_id
             WHERE q.tenant_id = ? AND l.tenant_id = ? AND l.expires_at <= ? AND q.status = 'PROCESSING' LIMIT 1`,
            [input.tenantId, input.tenantId, cutoff],
          ) as Array<{ id: string }>;
          if (processing.length > 0) {
            status = 'PAUSED';
            cursor = null;
          } else {
            phase = 'LINKS';
            cursor = null;
          }
        }
      } else if (phase === 'LINKS') {
        const linkRows = await manager.query(
          `SELECT l.id FROM ca_meta_magic_links AS l
           WHERE l.tenant_id = ? AND l.expires_at <= ? AND (? IS NULL OR l.id > ?)
             AND NOT EXISTS (SELECT 1 FROM ca_meta_magic_link_mail_queue AS q
               WHERE q.tenant_id = l.tenant_id AND q.magic_link_id = l.id)
           ORDER BY l.id LIMIT ? FOR UPDATE`,
          [input.tenantId, cutoff, cursor, cursor, batchSize],
        ) as Array<{ id: string }>;
        if (linkRows.length > 0) {
          const ids = linkRows.map((row) => row.id);
          const placeholders = ids.map(() => '?').join(',');
          const result = await manager.query(
            `DELETE FROM ca_meta_magic_links WHERE tenant_id = ? AND id IN (${placeholders})`,
            [input.tenantId, ...ids],
          );
          deleted = affectedRows(result);
          cursor = ids[ids.length - 1] ?? cursor;
        } else {
          phase = 'COMPLETE';
          status = 'COMPLETED';
        }
      }

      const totalDeleted = Number(run.deleted_count) + deleted;
      await manager.query(
        `UPDATE ca_meta_retention_purge_runs SET phase = ?, cursor_ref = ?, status = ?, deleted_count = ?,
         updated_at = UTC_TIMESTAMP(6), completed_at = IF(? = 'COMPLETED', UTC_TIMESTAMP(6), completed_at)
         WHERE tenant_id = ? AND id = ?`,
        [phase, cursor, status, totalDeleted, status, input.tenantId, run.id],
      );
      await this.audit.record({
        tenantId: input.tenantId, actorRef: input.actorRef, action: 'RETENTION_PURGE_BATCH',
        targetRef: run.id, correlationId: input.correlationId, retentionClass: 'SECURITY',
        safeDiff: { after: deleted, status: status === 'PAUSED' ? 'PAUSED' : phase },
      }, manager);
      return { runId: run.id, status, phase, deleted, totalDeleted };
    });
  }
}
