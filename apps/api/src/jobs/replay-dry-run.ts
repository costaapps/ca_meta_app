import { createHash, randomUUID } from 'node:crypto';
import type { DurableWorkDatabase } from './durable-work-database.js';
import { isJobType, isUuid, parseJobPayload } from './event-validation.js';
import type { JobStore } from './job-store.js';

export interface ReplayAuthorizationRequest {
  readonly tenantId: string;
  readonly deadLetterId: string;
  /** Opaque server-derived resource scope; never a caller-supplied company UUID. */
  readonly scopeRef: string;
  readonly operatorRef: string;
  readonly action: 'DRY_RUN' | 'REQUEUE';
  readonly dryRun: boolean;
}

export interface ReplayAuthorizationGrant extends ReplayAuthorizationRequest {
  readonly authorizationRef: string;
  readonly expiresAt: string;
}

export interface ReplayAuthorizationPort {
  authorize(request: ReplayAuthorizationRequest): Promise<ReplayAuthorizationGrant | null>;
}

/** Default implementation denies every request. */
export class FailClosedReplayAuthorizationPort implements ReplayAuthorizationPort {
  async authorize(_request: ReplayAuthorizationRequest): Promise<null> { return null; }
}

export interface ReplayRequestResult {
  readonly authorized: boolean;
  readonly dryRun: boolean;
  readonly requeued: boolean;
  readonly jobId: string | null;
  readonly reasonCode:
    | 'AUTHORIZATION_DENIED' | 'AUTHORIZATION_UNAVAILABLE' | 'AUTHORIZATION_EXPIRED' | 'GRANT_INVALID' | 'SCOPE_MISMATCH'
    | 'DEAD_LETTER_NOT_FOUND' | 'AMBIGUOUS_EFFECT_NOT_REPLAYABLE'
    | 'REPLAY_ENQUEUED' | 'REPLAY_DUPLICATE' | 'DRY_RUN_AUTHORIZED';
}

interface DeadLetterJobRow {
  id: string;
  job_type: string;
  effect_mode: string;
  resource_scope_ref: string;
  correlation_id: string;
  payload_json: string | unknown;
}

function affectedRows(value: unknown): number {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === 'object' && header !== null && 'affectedRows' in header
    ? Number((header as { affectedRows?: number }).affectedRows ?? 0)
    : 0;
}

function safeReference(value: string): boolean { return /^[A-Za-z0-9:_-]{1,128}$/.test(value); }

function inboxEventReference(type: string, value: unknown): string {
  if (type !== 'INBOX_PROCESS' || typeof value !== 'object' || value === null ||
    !('kind' in value) || value.kind !== 'INBOX_PROCESS' ||
    !('inboxEventRef' in value) || typeof value.inboxEventRef !== 'string' || !isUuid(value.inboxEventRef)) {
    throw new Error('Dead-letter inbox payload is invalid.');
  }
  return value.inboxEventRef;
}

function validateRequest(input: ReplayAuthorizationRequest): void {
  if (!isUuid(input.tenantId) || !isUuid(input.deadLetterId) || !safeReference(input.scopeRef) ||
    !safeReference(input.operatorRef) || (input.action === 'DRY_RUN') !== input.dryRun) {
    throw new Error('Replay request is malformed.');
  }
}

function grantStatus(
  input: ReplayAuthorizationRequest,
  grant: ReplayAuthorizationGrant | null,
  now = Date.now(),
): 'VALID' | 'AUTHORIZATION_DENIED' | 'GRANT_INVALID' | 'AUTHORIZATION_EXPIRED' {
  if (!grant) return 'AUTHORIZATION_DENIED';
  if (grant.action !== input.action || grant.dryRun !== input.dryRun ||
    grant.tenantId !== input.tenantId || grant.deadLetterId !== input.deadLetterId ||
    grant.scopeRef !== input.scopeRef || grant.operatorRef !== input.operatorRef ||
    !safeReference(grant.authorizationRef)) return 'GRANT_INVALID';
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) return 'GRANT_INVALID';
  if (expiresAt <= now) return 'AUTHORIZATION_EXPIRED';
  return 'VALID';
}

/** Internal, scoped replay controls. No controller or provider invocation is exposed by this module. */
export class ReplayDryRunService {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly authorization: ReplayAuthorizationPort = new FailClosedReplayAuthorizationPort(),
    private readonly jobs?: JobStore,
  ) {}

  async preview(input: Omit<ReplayAuthorizationRequest, 'action' | 'dryRun'>): Promise<ReplayRequestResult> {
    return this.request({ ...input, action: 'DRY_RUN', dryRun: true });
  }

  /** Enqueues only an eligible, exact-scope safe/idempotent job; it never calls an external handler. */
  async requeue(input: Omit<ReplayAuthorizationRequest, 'action' | 'dryRun'>): Promise<ReplayRequestResult> {
    return this.request({ ...input, action: 'REQUEUE', dryRun: false });
  }

  private async request(input: ReplayAuthorizationRequest): Promise<ReplayRequestResult> {
    validateRequest(input);
    let grant: ReplayAuthorizationGrant | null = null;
    let authorizationFailed = false;
    try { grant = await this.authorization.authorize(input); } catch { authorizationFailed = true; }
    const dataSource = await this.database.getDataSource();
    const result = await dataSource.transaction(async (manager) => {
      const tenants = await manager.query('SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE', [input.tenantId]) as Array<{ id: string }>;
      if (tenants.length !== 1) return { found: false as const, jobId: null, requeued: false, reasonCode: 'DEAD_LETTER_NOT_FOUND' as const };
      const rows = await manager.query(
        `SELECT j.id, j.job_type, j.effect_mode, j.resource_scope_ref, j.correlation_id, j.payload_json
         FROM ca_meta_job_dead_letters dl
         JOIN ca_meta_jobs j ON j.tenant_id = dl.tenant_id AND j.id = dl.job_id
         WHERE dl.tenant_id = ? AND dl.id = ? FOR UPDATE`,
        [input.tenantId, input.deadLetterId],
      ) as DeadLetterJobRow[];
      const row = rows[0];
      if (!row) return { found: false as const, jobId: null, requeued: false, reasonCode: 'DEAD_LETTER_NOT_FOUND' as const };

      let status = grantStatus(input, grant);
      if (!grant && authorizationFailed) status = 'AUTHORIZATION_DENIED';
      let reasonCode: ReplayRequestResult['reasonCode'] = !grant && authorizationFailed
        ? 'AUTHORIZATION_UNAVAILABLE'
        : status !== 'VALID' ? status
          : row.resource_scope_ref !== input.scopeRef ? 'SCOPE_MISMATCH'
            : input.action === 'DRY_RUN' ? 'DRY_RUN_AUTHORIZED' : 'REPLAY_ENQUEUED';
      let jobId: string | null = null;
      let requeued = false;

      if (status === 'VALID' && row.resource_scope_ref === input.scopeRef && input.action === 'REQUEUE') {
        if (row.effect_mode !== 'SAFE_RETRY' && row.effect_mode !== 'IDEMPOTENT') {
          reasonCode = 'AMBIGUOUS_EFFECT_NOT_REPLAYABLE';
        } else if (this.jobs && isJobType(row.job_type)) {
          // Re-check under the tenant/job locks immediately before creating the durable replay job.
          status = grantStatus(input, grant);
          if (status !== 'VALID') reasonCode = status;
          else {
          const payloadValue = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) as unknown : row.payload_json;
          const payload = parseJobPayload(row.job_type, payloadValue);
          const replayKey = `replay:${createHash('sha256')
            .update(`${input.tenantId}:${input.deadLetterId}`)
            .digest('hex')}`;
          const enqueued = await this.jobs.enqueueWithin(manager, {
            tenantId: input.tenantId,
            type: row.job_type,
            idempotencyKey: replayKey,
            correlationId: row.correlation_id,
            causationId: row.id,
            resourceScopeRef: row.resource_scope_ref,
            payload,
          });
          // If the grant expired while the enqueue waited on SQL, remove only a newly inserted row
          // before commit, then record the denied attempt in this same transaction.
          status = grantStatus(input, grant);
          if (status !== 'VALID') {
            if (!enqueued.duplicate) {
              const deleted = await manager.query(
                'DELETE FROM ca_meta_jobs WHERE id = ? AND tenant_id = ? AND status = \'QUEUED\' AND attempt = 0',
                [enqueued.id, input.tenantId],
              );
              if (affectedRows(deleted) !== 1) throw new Error('Expired replay grant could not be safely retracted.');
            }
            reasonCode = status;
          } else {
            if (!enqueued.duplicate && row.job_type === 'INBOX_PROCESS') {
              const payloadObject = typeof row.payload_json === 'string'
                ? JSON.parse(row.payload_json) as unknown
                : row.payload_json;
              const inboxEventRef = inboxEventReference(row.job_type, payloadObject);
              const resetProjection = await manager.query(
                `UPDATE ca_meta_inbox_events SET processing_state = 'PENDING'
                 WHERE id = ? AND tenant_id = ? AND routing_state = 'ROUTED' AND processing_state = 'DEAD_LETTER'`,
                [inboxEventRef, input.tenantId],
              );
              if (affectedRows(resetProjection) !== 1) {
                throw new Error('Dead-letter inbox projection is missing or no longer replayable.');
              }
            }
            jobId = enqueued.id;
            requeued = true;
            reasonCode = enqueued.duplicate ? 'REPLAY_DUPLICATE' : 'REPLAY_ENQUEUED';
          }
          }
        } else {
          reasonCode = 'AUTHORIZATION_UNAVAILABLE';
        }
      }

      await manager.query(
        `INSERT INTO ca_meta_replay_audit
         (id, tenant_id, dead_letter_id, operator_ref, authorization_ref, scope_ref, action,
          safe_reason_code, dry_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), input.tenantId, input.deadLetterId, input.operatorRef,
          grant && safeReference(grant.authorizationRef) ? grant.authorizationRef : null, input.scopeRef,
          input.action === 'DRY_RUN' ? (reasonCode === 'DRY_RUN_AUTHORIZED' ? 'DRY_RUN_ALLOWED' : 'DRY_RUN_DENIED') :
            (requeued ? 'REQUEUE_ALLOWED' : 'REQUEUE_DENIED'), reasonCode, input.dryRun ? 1 : 0],
      );
      return { found: true as const, jobId, requeued, reasonCode };
    });

    if (!result.found) return {
      authorized: false, dryRun: input.dryRun, requeued: false, jobId: null, reasonCode: 'DEAD_LETTER_NOT_FOUND',
    };
    return {
      authorized: result.reasonCode === 'DRY_RUN_AUTHORIZED' || result.reasonCode === 'REPLAY_ENQUEUED' || result.reasonCode === 'REPLAY_DUPLICATE',
      dryRun: input.dryRun,
      requeued: result.requeued,
      jobId: result.jobId,
      reasonCode: result.reasonCode,
    };
  }
}
