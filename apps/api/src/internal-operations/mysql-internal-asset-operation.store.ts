import { IdentityDeniedError } from '../identity/identity.errors.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { AuditEventWriter } from '../privacy/audit.service.js';
import type {
  InternalAssetOperation,
  InternalAssetOperationClaim,
  InternalAssetOperationRow,
  InternalAssetOperationStatus,
  InternalAssetOperationStore,
} from './internal-operations.types.js';
import { InternalAssetOperationIdempotencyConflictError } from './internal-operations.validation.js';

interface OperationDbRow {
  id: string;
  tenant_id: string;
  service_principal_id: string;
  asset_id: string;
  operation: string;
  request_hash: string;
  status: string;
  safe_reason_code: string | null;
  provider_reference_hash: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const SAFE_REASON_CODES = new Set([
  'OPERATION_ACCEPTED', 'PROVIDER_REJECTED', 'PROVIDER_RESULT_UNKNOWN', 'OPERATION_FAILED',
  'OPERATION_UNSUPPORTED', 'CREDENTIAL_UNAVAILABLE',
]);

function affectedRows(value: unknown): number {
  const result = Array.isArray(value) ? value[0] : value;
  return typeof result === 'object' && result !== null && 'affectedRows' in result
    ? Number((result as { affectedRows?: number }).affectedRows ?? 0) : 0;
}

function utc(value: string | Date): string {
  const result = value instanceof Date ? value.toISOString() : value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  if (!Number.isFinite(Date.parse(result))) throw new Error('internal-operation-invalid-database-time');
  return result;
}

function parseRow(row: OperationDbRow): InternalAssetOperationRow {
  if (!['SEND_MESSAGE', 'MANAGE_TEMPLATES', 'MANAGE_COMMENTS', 'READ_STATUS', 'SUBSCRIBE_WEBHOOKS'].includes(row.operation) ||
      !['UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(row.status) ||
      (row.safe_reason_code !== null && !SAFE_REASON_CODES.has(row.safe_reason_code)) ||
      (row.provider_reference_hash !== null && !/^[a-f0-9]{64}$/.test(row.provider_reference_hash))) {
    throw new Error('internal-operation-invalid-database-row');
  }
  return Object.freeze({
    operationId: row.id,
    tenantId: row.tenant_id,
    servicePrincipalId: row.service_principal_id,
    assetId: row.asset_id,
    operation: row.operation as InternalAssetOperation,
    payloadHash: row.request_hash,
    status: row.status as InternalAssetOperationStatus,
    ...(row.safe_reason_code ? { reasonCode: row.safe_reason_code } : {}),
    ...(row.provider_reference_hash ? { providerReferenceHash: row.provider_reference_hash } : {}),
    createdAt: utc(row.created_at),
    updatedAt: utc(row.updated_at),
  });
}

/** Metadata-only, unique-key idempotency ledger. It never persists payload text or credentials. */
export class MysqlInternalAssetOperationStore implements InternalAssetOperationStore {
  constructor(private readonly database: DurableWorkDatabase, private readonly audit: AuditEventWriter) {}

  async claim(input: Parameters<InternalAssetOperationStore['claim']>[0]): Promise<InternalAssetOperationClaim> {
    const source = await this.database.getDataSource();
    return source.transaction('READ COMMITTED', async (manager) => {
      const inserted = await manager.query(
        `INSERT IGNORE INTO ca_meta_internal_asset_operations
         (id, tenant_id, service_principal_id, asset_id, operation, idempotency_key_hash, request_hash, status, safe_reason_code, provider_reference_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', NULL, NULL, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [input.operationId, input.tenantId, input.servicePrincipalId, input.assetId, input.operation,
          input.idempotencyKeyHash, input.payloadHash],
      );
      const rows = await manager.query(
        `SELECT id, tenant_id, service_principal_id, asset_id, operation, request_hash, status,
                safe_reason_code, provider_reference_hash, created_at, updated_at
         FROM ca_meta_internal_asset_operations
         WHERE tenant_id = ? AND service_principal_id = ? AND asset_id = ? AND operation = ? AND idempotency_key_hash = ?
         FOR UPDATE`,
        [input.tenantId, input.servicePrincipalId, input.assetId, input.operation, input.idempotencyKeyHash],
      ) as OperationDbRow[];
      const dbRow = rows[0];
      if (!dbRow) throw new Error('internal-operation-idempotency-claim-missing');
      if (dbRow.request_hash !== input.payloadHash) throw new InternalAssetOperationIdempotencyConflictError();
      const isNew = affectedRows(inserted) === 1;
      if (isNew) {
        await this.audit.record({
          tenantId: input.tenantId,
          actorRef: input.servicePrincipalId,
          action: 'ASSET_OPERATION',
          targetRef: input.operationId,
          correlationId: input.correlationId,
          retentionClass: 'OPERATIONS',
          safeDiff: { status: 'UNKNOWN', reasonCode: 'OPERATION_ACCEPTED' },
        }, manager);
      }
      return Object.freeze({ row: parseRow(dbRow), isNew });
    });
  }

  async complete(input: Parameters<InternalAssetOperationStore['complete']>[0]): Promise<InternalAssetOperationRow> {
    if (!SAFE_REASON_CODES.has(input.reasonCode ?? 'OPERATION_ACCEPTED') ||
        (input.providerReferenceHash !== undefined && !/^[a-f0-9]{64}$/.test(input.providerReferenceHash))) {
      throw new Error('internal-operation-completion-metadata-invalid');
    }
    const source = await this.database.getDataSource();
    return source.transaction(async (manager) => {
      const updated = await manager.query(
        `UPDATE ca_meta_internal_asset_operations
         SET status = ?, safe_reason_code = ?, provider_reference_hash = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND tenant_id = ? AND service_principal_id = ? AND status = 'UNKNOWN'`,
        [input.status, input.reasonCode ?? null, input.providerReferenceHash ?? null, input.operationId, input.tenantId, input.servicePrincipalId],
      );
      if (affectedRows(updated) === 1) {
        await this.audit.record({
          tenantId: input.tenantId,
          actorRef: input.servicePrincipalId,
          action: 'ASSET_OPERATION',
          targetRef: input.operationId,
          correlationId: input.correlationId,
          retentionClass: 'OPERATIONS',
          safeDiff: { status: input.status, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}) },
        }, manager);
      }
      const rows = await manager.query(
        `SELECT id, tenant_id, service_principal_id, asset_id, operation, request_hash, status,
                safe_reason_code, provider_reference_hash, created_at, updated_at
         FROM ca_meta_internal_asset_operations
         WHERE id = ? AND tenant_id = ? AND service_principal_id = ?`,
        [input.operationId, input.tenantId, input.servicePrincipalId],
      ) as OperationDbRow[];
      if (!rows[0]) throw new IdentityDeniedError();
      const row = parseRow(rows[0]);
      if (row.status !== input.status && input.status !== 'UNKNOWN') {
        // A finalized result is immutable. The caller must never overwrite a concurrent outcome.
        return row;
      }
      return row;
    });
  }

  async find(input: Parameters<InternalAssetOperationStore['find']>[0]): Promise<InternalAssetOperationRow | undefined> {
    const source = await this.database.getDataSource();
    const rows = await source.query(
      `SELECT id, tenant_id, service_principal_id, asset_id, operation, request_hash, status,
              safe_reason_code, provider_reference_hash, created_at, updated_at
       FROM ca_meta_internal_asset_operations
       WHERE id = ? AND tenant_id = ? AND service_principal_id = ? LIMIT 1`,
      [input.operationId, input.tenantId, input.servicePrincipalId],
    ) as OperationDbRow[];
    return rows[0] ? parseRow(rows[0]) : undefined;
  }
}
