import { createHash, randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { sanitizeAuditDiff, redactDiagnosticValue, isSafeOpaqueReference } from './redaction.js';

export type AuditAction =
  | 'AUTHORIZATION_CONNECTED' | 'AUTHORIZATION_REAUTHORIZED' | 'AUTHORIZATION_OBSERVED' | 'ASSET_OPERATION'
  | 'AUTHORIZATION_DISCONNECTED' | 'AUTHORIZATION_DENIED' | 'RETENTION_POLICY_CREATED' | 'RETENTION_POLICY_ACTIVATED' | 'RETENTION_PURGE_STARTED' | 'RETENTION_PURGE_BATCH'
  | 'DELETION_REQUESTED' | 'DELETION_STATUS_CHANGED' | 'SUPPORT_DIAGNOSTIC_ACCESS';

export interface AuditEventInput {
  readonly tenantId: string;
  readonly actorRef: string;
  readonly action: AuditAction;
  readonly targetRef: string;
  readonly correlationId: string;
  readonly safeDiff?: unknown;
  readonly retentionClass: 'SECURITY' | 'OPERATIONS' | 'DELETION' | 'SUPPORT';
  readonly policyVersion?: string;
}

const REF = /^[A-Za-z0-9:_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUPPORT_GRANT_TTL_MS = 15 * 60 * 1000;

export function privacyRefHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Metadata-only event writer. Callers may pass an existing transaction executor. */
export class AuditEventWriter {
  constructor(private readonly database: DurableWorkDatabase) {}

  async record(input: AuditEventInput, executor?: EntityManager | DataSource): Promise<string> {
    if (!UUID.test(input.tenantId) || !REF.test(input.actorRef) || !isSafeOpaqueReference(input.targetRef) ||
      !isSafeOpaqueReference(input.correlationId) || (input.policyVersion !== undefined &&
        (input.policyVersion.length > 32 || !isSafeOpaqueReference(input.policyVersion)))) {
      throw new Error('Audit event references are malformed.');
    }
    const id = randomUUID();
    const safeDiff = sanitizeAuditDiff(input.safeDiff);
    const database = executor ?? await this.database.getDataSource();
    await database.query(
      `INSERT INTO ca_meta_audit_events
       (id, tenant_id, actor_ref_hash, action, target_ref, correlation_id, safe_diff, retention_class, policy_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [id, input.tenantId, privacyRefHash(input.actorRef), input.action, input.targetRef,
        input.correlationId, JSON.stringify(safeDiff), input.retentionClass, input.policyVersion ?? null],
    );
    return id;
  }
}

export interface SupportAccessGrant {
  readonly tenantId: string;
  readonly actorRef: string;
  readonly targetRef: string;
  readonly reasonCode: 'INCIDENT' | 'CUSTOMER_REQUEST' | 'SECURITY_REVIEW';
  readonly role: 'SUPPORT';
  readonly expiresAt: string;
}

export interface SupportAccessAuthorizationPort {
  authorize(input: Omit<SupportAccessGrant, 'expiresAt' | 'role'>): Promise<SupportAccessGrant | null>;
}

export type SupportReasonCode = SupportAccessGrant['reasonCode'];

export class FailClosedSupportAccessAuthorization implements SupportAccessAuthorizationPort {
  async authorize(_input: Omit<SupportAccessGrant, 'expiresAt' | 'role'>): Promise<null> { return null; }
}

/** Internal support diagnostics require a short-lived grant and are audited before data is read. */
export class SupportDiagnosticService {
  constructor(
    private readonly audit: AuditEventWriter,
    private readonly authorization: SupportAccessAuthorizationPort = new FailClosedSupportAccessAuthorization(),
  ) {}

  async read<T>(input: Omit<SupportAccessGrant, 'expiresAt' | 'role'>, correlationId: string, read: () => Promise<T>): Promise<unknown> {
    const grant = await this.authorization.authorize(input);
    const expiresAt = grant ? Date.parse(grant.expiresAt) : NaN;
    const now = Date.now();
    if (!grant || grant.role !== 'SUPPORT' || grant.tenantId !== input.tenantId || grant.actorRef !== input.actorRef ||
      grant.targetRef !== input.targetRef || grant.reasonCode !== input.reasonCode ||
      !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > MAX_SUPPORT_GRANT_TTL_MS) {
      throw new Error('Support diagnostic access denied.');
    }
    await this.audit.record({
      tenantId: input.tenantId, actorRef: input.actorRef, action: 'SUPPORT_DIAGNOSTIC_ACCESS',
      targetRef: input.targetRef, correlationId, retentionClass: 'SUPPORT',
      safeDiff: { reasonCode: input.reasonCode },
    });
    return redactDiagnosticValue(await read());
  }
}
