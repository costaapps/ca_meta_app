import { randomUUID } from 'node:crypto';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { AuditEventWriter, privacyRefHash } from './audit.service.js';
import { isSafeOpaqueReference } from './redaction.js';

export type DeletionScope = 'TENANT_DATA' | 'AUTHORIZATION' | 'ASSET' | 'MESSAGE_HISTORY';
export type DeletionReason = 'ACCOUNT_CLOSURE' | 'PRIVACY_REQUEST' | 'DISCONNECTION';
export type DeletionEvidenceReason = 'REQUEST_VALIDATED' | 'LOCAL_PURGE' | 'LEGAL_HOLD_REVIEW' | 'PROVIDER_CALLBACK' | 'CANCELLED_BY_REQUESTER';
export type DeletionStatus = 'RECEIVED' | 'ASSESSED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
export type DeletionOperation = 'REQUEST' | 'READ_STATUS' | 'UPDATE_STATUS';

export interface DeletionAuthorizationRequest {
  readonly tenantId: string;
  readonly actorRef: string;
  readonly operation: DeletionOperation;
  readonly requestId?: string;
}

export interface DeletionAuthorizationGrant extends DeletionAuthorizationRequest {
  readonly expiresAt: string;
}

export interface DeletionAuthorizationPort {
  authorize(input: DeletionAuthorizationRequest): Promise<DeletionAuthorizationGrant | null>;
}

export class FailClosedDeletionAuthorization implements DeletionAuthorizationPort {
  async authorize(_input: DeletionAuthorizationRequest): Promise<null> { return null; }
}

interface DeletionStatusRow {
  readonly id: string;
  readonly status: DeletionStatus;
  readonly reason_code: DeletionReason;
  readonly evidence_ref: string;
  readonly requested_at: string | Date;
  readonly updated_at: string | Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF = /^[A-Za-z0-9:_-]{1,128}$/;
const EVIDENCE_REASONS = new Set<DeletionEvidenceReason>([
  'REQUEST_VALIDATED', 'LOCAL_PURGE', 'LEGAL_HOLD_REVIEW', 'PROVIDER_CALLBACK', 'CANCELLED_BY_REQUESTER',
]);
const TRANSITIONS: Readonly<Record<DeletionStatus, ReadonlySet<DeletionStatus>>> = {
  RECEIVED: new Set(['ASSESSED', 'CANCELLED', 'BLOCKED']),
  ASSESSED: new Set(['IN_PROGRESS', 'CANCELLED', 'BLOCKED']),
  IN_PROGRESS: new Set(['COMPLETED', 'BLOCKED']),
  BLOCKED: new Set(['ASSESSED', 'IN_PROGRESS', 'CANCELLED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

function validGrant(grant: DeletionAuthorizationGrant | null, input: DeletionAuthorizationRequest): boolean {
  return !!grant && grant.tenantId === input.tenantId && grant.actorRef === input.actorRef &&
    grant.operation === input.operation && grant.requestId === input.requestId &&
    Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now();
}

/** Local deletion workflow metadata only. This service never calls a provider or deletes provider assets. */
export class DeletionRequestService {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly audit: AuditEventWriter,
    private readonly authorization: DeletionAuthorizationPort = new FailClosedDeletionAuthorization(),
  ) {}

  async request(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly targetRef: string;
    readonly scope: DeletionScope;
    readonly reasonCode: DeletionReason;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<{ readonly requestId: string; readonly status: DeletionStatus; readonly evidenceRef: string }> {
    const auth: DeletionAuthorizationRequest = { tenantId: input.tenantId, actorRef: input.actorRef, operation: 'REQUEST' };
    if (!UUID.test(input.tenantId) || !SAFE_REF.test(input.actorRef) || !isSafeOpaqueReference(input.targetRef) ||
      !UUID.test(input.idempotencyKey) || !isSafeOpaqueReference(input.correlationId) || !validGrant(await this.authorization.authorize(auth), auth)) {
      throw new Error('Deletion request denied.');
    }
    const database = await this.database.getDataSource();
    const targetHash = privacyRefHash(input.targetRef);
    const actorHash = privacyRefHash(input.actorRef);
    const requestHash = privacyRefHash([input.tenantId, targetHash, input.scope, input.reasonCode].join('\0'));
    return database.transaction(async (manager) => {
      const existing = await manager.query(
        `SELECT id, status, evidence_ref, request_hash FROM ca_meta_deletion_requests
         WHERE tenant_id = ? AND requester_ref_hash = ? AND idempotency_key = ? FOR UPDATE`,
        [input.tenantId, actorHash, input.idempotencyKey],
      ) as Array<{ id: string; status: DeletionStatus; evidence_ref: string; request_hash: string }>;
      if (existing[0]) {
        if (existing[0].request_hash !== requestHash) throw new Error('Deletion idempotency key was reused for a different request.');
        return { requestId: existing[0].id, status: existing[0].status, evidenceRef: existing[0].evidence_ref };
      }

      const requestId = randomUUID();
      const evidenceRef = await this.audit.record({
        tenantId: input.tenantId, actorRef: input.actorRef, action: 'DELETION_REQUESTED',
        targetRef: requestId, correlationId: input.correlationId, retentionClass: 'DELETION',
        safeDiff: { status: 'RECEIVED', reasonCode: input.reasonCode },
      }, manager);
      await manager.query(
        `INSERT INTO ca_meta_deletion_requests
         (id, tenant_id, requester_ref_hash, target_ref_hash, scope, reason_code, status, idempotency_key, request_hash, evidence_ref, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [requestId, input.tenantId, actorHash, targetHash, input.scope, input.reasonCode, input.idempotencyKey, requestHash, evidenceRef],
      );
      await manager.query(
        `INSERT INTO ca_meta_deletion_tombstones
         (id, tenant_id, request_id, target_ref_hash, scope, created_at)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), input.tenantId, requestId, targetHash, input.scope],
      );
      return { requestId, status: 'RECEIVED', evidenceRef };
    });
  }

  async status(input: { readonly tenantId: string; readonly actorRef: string; readonly requestId: string }): Promise<{
    readonly requestId: string;
    readonly status: DeletionStatus;
    readonly reasonCode: DeletionReason;
    readonly evidenceRef: string;
    readonly requestedAt: string;
    readonly updatedAt: string;
  } | undefined> {
    const auth: DeletionAuthorizationRequest = { ...input, operation: 'READ_STATUS' };
    if (!UUID.test(input.tenantId) || !UUID.test(input.requestId) || !SAFE_REF.test(input.actorRef) ||
      !validGrant(await this.authorization.authorize(auth), auth)) throw new Error('Deletion status access denied.');
    const database = await this.database.getDataSource();
    const rows = await database.query(
      `SELECT id, status, reason_code, evidence_ref,
              DATE_FORMAT(requested_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS requested_at,
              DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
       FROM ca_meta_deletion_requests WHERE tenant_id = ? AND id = ?`,
      [input.tenantId, input.requestId],
    ) as DeletionStatusRow[];
    const row = rows[0];
    if (!row) return undefined;
    return Object.freeze({
      requestId: row.id, status: row.status, reasonCode: row.reason_code, evidenceRef: row.evidence_ref,
      requestedAt: (typeof row.requested_at === 'string' ? new Date(row.requested_at) : row.requested_at).toISOString(),
      updatedAt: (typeof row.updated_at === 'string' ? new Date(row.updated_at) : row.updated_at).toISOString(),
    });
  }

  async updateStatus(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly requestId: string;
    readonly nextStatus: DeletionStatus;
    readonly reasonCode: DeletionEvidenceReason;
    readonly correlationId: string;
  }): Promise<boolean> {
    const auth: DeletionAuthorizationRequest = {
      tenantId: input.tenantId, actorRef: input.actorRef, operation: 'UPDATE_STATUS', requestId: input.requestId,
    };
    if (!UUID.test(input.tenantId) || !UUID.test(input.requestId) || !SAFE_REF.test(input.actorRef) ||
      !EVIDENCE_REASONS.has(input.reasonCode) || !isSafeOpaqueReference(input.correlationId) ||
      !validGrant(await this.authorization.authorize(auth), auth)) throw new Error('Deletion status update denied.');
    const database = await this.database.getDataSource();
    return database.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT status FROM ca_meta_deletion_requests WHERE tenant_id = ? AND id = ? FOR UPDATE`,
        [input.tenantId, input.requestId],
      ) as Array<{ status: DeletionStatus }>;
      const current = rows[0]?.status;
      if (!current) return false;
      if (current === input.nextStatus) return true;
      if (!TRANSITIONS[current].has(input.nextStatus)) throw new Error('Deletion status transition is not allowed.');
      const evidenceRef = await this.audit.record({
        tenantId: input.tenantId, actorRef: input.actorRef, action: 'DELETION_STATUS_CHANGED',
        targetRef: input.requestId, correlationId: input.correlationId, retentionClass: 'DELETION',
        safeDiff: { before: current, after: input.nextStatus, reasonCode: input.reasonCode },
      }, manager);
      const result = await manager.query(
        `UPDATE ca_meta_deletion_requests SET status = ?, evidence_ref = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE tenant_id = ? AND id = ? AND status = ?`,
        [input.nextStatus, evidenceRef, input.tenantId, input.requestId, current],
      ) as unknown;
      const header = Array.isArray(result) ? result[0] : result;
      return typeof header === 'object' && header !== null && 'affectedRows' in header &&
        Number((header as { affectedRows?: number }).affectedRows ?? 0) === 1;
    });
  }
}
