import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { LegacyImportApplyPort, LegacyImportApplyResult } from './legacy-import.ports.js';
import type {
  LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem,
} from './legacy-import.types.js';

interface BatchRow {
  batch_id: string;
  source_snapshot_hash: string;
  source_version: string;
  projection_version: string;
  item_count: number | string;
  last_completed_sequence: number | string;
  state: LegacyImportBatchCheckpoint['state'];
}
interface ItemRow {
  source_record_hash: string;
  source_payload_hash: string;
  source_table: LegacyImportPlanItem['sourceTable'];
  tenant_id: string | null;
  app_configuration_id: string | null;
  environment: LegacyImportPlanItem['environment'];
  asset_kind: LegacyImportPlanItem['assetKind'];
  target_asset_ref: string | null;
  item_state: string;
  reason_code: LegacyImportPlanItem['reasonCode'];
  credential_disposition: LegacyImportPlanItem['credentialDisposition'];
  expiry_observation: LegacyImportPlanItem['expiryObservation'];
}
interface ClaimRow {
  source_payload_hash: string;
  tenant_id: string;
  app_configuration_id: string;
  environment: LegacyImportPlanItem['environment'];
  asset_kind: NonNullable<LegacyImportPlanItem['assetKind']>;
  target_asset_ref: string;
  credential_disposition: LegacyImportPlanItem['credentialDisposition'];
  expiry_observation: LegacyImportPlanItem['expiryObservation'];
}

export class LegacyImportLedgerConflictError extends Error {
  constructor(message = 'Legacy import ledger state conflicts with the requested checkpoint.') {
    super(message);
    this.name = 'LegacyImportLedgerConflictError';
  }
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return typeof header === 'object' && header !== null && 'affectedRows' in header
    ? Number((header as { affectedRows?: number }).affectedRows ?? 0) : 0;
}

function isTransientConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ER_DUP_ENTRY' || error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT';
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new LegacyImportLedgerConflictError('Legacy import plan contains an invalid HMAC reference.');
}
function assertUuid(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new LegacyImportLedgerConflictError('Legacy import plan contains an invalid internal reference.');
  }
}

function validatePlan(plan: LegacyImportPlan): void {
  assertUuid(plan.batchId);
  assertDigest(plan.report.sourceSnapshotHash);
  if (plan.items.length !== plan.report.totalRows || plan.items.some((item, index) =>
    item.sequence !== index + 1 || item.batchId !== plan.batchId ||
    item.environment !== 'development' && item.environment !== 'test' && item.environment !== 'staging' && item.environment !== 'production')) {
    throw new LegacyImportLedgerConflictError('Legacy import plan sequence or scope is invalid.');
  }
  for (const item of plan.items) {
    assertDigest(item.sourceRecordHash);
    assertDigest(item.sourcePayloadHash);
    if (item.tenantId !== null) assertUuid(item.tenantId);
    if (item.appConfigurationId !== null) assertUuid(item.appConfigurationId);
    if (item.deterministicAssetId !== null) assertUuid(item.deterministicAssetId);
    if (item.state === 'METADATA_ONLY_CANDIDATE' &&
        (!item.tenantId || !item.appConfigurationId || !item.assetKind || !item.deterministicAssetId)) {
      throw new LegacyImportLedgerConflictError('Legacy import candidate is missing its internal target context.');
    }
  }
}

function checkpoint(row: BatchRow): LegacyImportBatchCheckpoint {
  return {
    batchId: row.batch_id,
    sourceSnapshotHash: row.source_snapshot_hash,
    sourceVersion: row.source_version,
    projectionVersion: row.projection_version,
    lastCompletedSequence: Number(row.last_completed_sequence),
    state: row.state,
  };
}

function assertBatchMatchesPlan(row: BatchRow, plan: LegacyImportPlan): void {
  if (row.batch_id !== plan.batchId || row.source_snapshot_hash !== plan.report.sourceSnapshotHash ||
      row.source_version !== plan.sourceVersion || row.projection_version !== plan.projectionVersion ||
      Number(row.item_count) !== plan.items.length) {
    throw new LegacyImportLedgerConflictError('Legacy import batch ID is already bound to different sanitized source metadata.');
  }
}

function assertCheckpointMatches(checkpointValue: LegacyImportBatchCheckpoint, row: BatchRow): void {
  const current = checkpoint(row);
  if (checkpointValue.batchId !== current.batchId || checkpointValue.sourceSnapshotHash !== current.sourceSnapshotHash ||
      checkpointValue.sourceVersion !== current.sourceVersion || checkpointValue.projectionVersion !== current.projectionVersion ||
      checkpointValue.lastCompletedSequence !== current.lastCompletedSequence || checkpointValue.state !== current.state) {
    throw new LegacyImportLedgerConflictError();
  }
}

function assertPersistedItem(row: ItemRow, item: LegacyImportPlanItem, compareReason = row.item_state === 'PLANNED'): void {
  if (row.source_record_hash !== item.sourceRecordHash || row.source_payload_hash !== item.sourcePayloadHash ||
      row.source_table !== item.sourceTable || row.tenant_id !== item.tenantId ||
      row.app_configuration_id !== item.appConfigurationId || row.environment !== item.environment ||
      row.asset_kind !== item.assetKind || row.target_asset_ref !== item.deterministicAssetId ||
      (compareReason && row.reason_code !== item.reasonCode) || row.credential_disposition !== item.credentialDisposition ||
      row.expiry_observation !== item.expiryObservation) {
    throw new LegacyImportLedgerConflictError('Legacy import item differs from its persisted sanitized plan.');
  }
}

async function lockedBatch(manager: EntityManager, expected: LegacyImportBatchCheckpoint): Promise<BatchRow> {
  const rows = await manager.query(
    `SELECT batch_id, source_snapshot_hash, source_version, projection_version, item_count,
       last_completed_sequence, state FROM ca_meta_legacy_import_batches WHERE batch_id = ? FOR UPDATE`,
    [expected.batchId],
  ) as BatchRow[];
  const row = rows[0];
  if (!row) throw new LegacyImportLedgerConflictError('Legacy import batch was not initialized.');
  assertCheckpointMatches(expected, row);
  return row;
}

async function lockedNextItem(
  manager: EntityManager,
  row: BatchRow,
  expected: LegacyImportBatchCheckpoint,
  item: LegacyImportPlanItem,
): Promise<ItemRow> {
  if (row.state === 'COMPLETED' || row.state === 'FAILED' || item.sequence !== Number(row.last_completed_sequence) + 1) {
    throw new LegacyImportLedgerConflictError('Legacy import item is not the next resumable checkpoint.');
  }
  const rows = await manager.query(
    `SELECT source_record_hash, source_payload_hash, source_table, tenant_id, app_configuration_id,
       environment, asset_kind, target_asset_ref, item_state, reason_code, credential_disposition, expiry_observation
     FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = ? FOR UPDATE`,
    [expected.batchId, item.sequence],
  ) as ItemRow[];
  const persisted = rows[0];
  if (!persisted || persisted.item_state !== 'PLANNED') throw new LegacyImportLedgerConflictError('Legacy import item is not in its planned state.');
  assertPersistedItem(persisted, item);
  return persisted;
}

async function advanceCheckpoint(
  manager: EntityManager,
  row: BatchRow,
  item: LegacyImportPlanItem,
  itemState: 'CLAIMED' | 'REPLAYED' | 'QUARANTINED' | 'QUARANTINED_SOURCE_CHANGED',
  reasonCode: LegacyImportPlanItem['reasonCode'],
): Promise<LegacyImportBatchCheckpoint> {
  const timestamped = 'UTC_TIMESTAMP(6)';
  const itemUpdate = await manager.query(
    `UPDATE ca_meta_legacy_import_items SET item_state = ?, reason_code = ?, updated_at = ${timestamped}
     WHERE batch_id = ? AND sequence = ? AND item_state = 'PLANNED'`,
    [itemState, reasonCode, item.batchId, item.sequence],
  );
  if (affectedRows(itemUpdate) !== 1) throw new LegacyImportLedgerConflictError('Legacy import item changed before checkpoint commit.');
  const batchUpdate = await manager.query(
    `UPDATE ca_meta_legacy_import_batches SET last_completed_sequence = ?, state = 'APPLYING',
       version = version + 1, updated_at = ${timestamped}
     WHERE batch_id = ? AND last_completed_sequence = ? AND state IN ('PLANNED','APPLYING','PAUSED')`,
    [item.sequence, item.batchId, item.sequence - 1],
  );
  if (affectedRows(batchUpdate) !== 1) throw new LegacyImportLedgerConflictError('Legacy import checkpoint compare-and-swap failed.');
  return {
    batchId: row.batch_id,
    sourceSnapshotHash: row.source_snapshot_hash,
    sourceVersion: row.source_version,
    projectionVersion: row.projection_version,
    lastCompletedSequence: item.sequence,
    state: 'APPLYING',
  };
}

function sameClaim(claim: ClaimRow, item: LegacyImportPlanItem): boolean {
  return claim.source_payload_hash === item.sourcePayloadHash && claim.tenant_id === item.tenantId &&
    claim.app_configuration_id === item.appConfigurationId && claim.environment === item.environment &&
    claim.asset_kind === item.assetKind && claim.target_asset_ref === item.deterministicAssetId &&
    claim.credential_disposition === item.credentialDisposition && claim.expiry_observation === item.expiryObservation;
}

/**
 * Persistent, metadata-only claim ledger. All item claims and checkpoint advancement share one
 * InnoDB transaction. Provider IDs, legacy row IDs, credential values and raw source payloads
 * are deliberately absent from every INSERT/UPDATE in this adapter.
 */
export class MysqlLegacyImportLedger implements LegacyImportApplyPort {
  constructor(private readonly database: DurableWorkDatabase) {}

  async beginOrResume(plan: LegacyImportPlan): Promise<LegacyImportBatchCheckpoint> {
    validatePlan(plan);
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT IGNORE INTO ca_meta_legacy_import_batches
         (batch_id, source_snapshot_hash, source_version, projection_version, item_count, last_completed_sequence, state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 'PLANNED', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [plan.batchId, plan.report.sourceSnapshotHash, plan.sourceVersion, plan.projectionVersion, plan.items.length],
      );
      const batchRows = await manager.query(
        `SELECT batch_id, source_snapshot_hash, source_version, projection_version, item_count,
           last_completed_sequence, state FROM ca_meta_legacy_import_batches WHERE batch_id = ? FOR UPDATE`,
        [plan.batchId],
      ) as BatchRow[];
      const batch = batchRows[0];
      if (!batch) throw new LegacyImportLedgerConflictError('Legacy import batch could not be initialized.');
      assertBatchMatchesPlan(batch, plan);

      for (const item of plan.items) {
        await manager.query(
          `INSERT IGNORE INTO ca_meta_legacy_import_items
           (batch_id, sequence, source_record_hash, source_payload_hash, source_table, tenant_id,
            app_configuration_id, environment, asset_kind, target_asset_ref, item_state, reason_code,
            credential_disposition, expiry_observation, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [item.batchId, item.sequence, item.sourceRecordHash, item.sourcePayloadHash, item.sourceTable,
            item.tenantId, item.appConfigurationId, item.environment, item.assetKind, item.deterministicAssetId,
            item.reasonCode, item.credentialDisposition, item.expiryObservation],
        );
        const itemRows = await manager.query(
          `SELECT source_record_hash, source_payload_hash, source_table, tenant_id, app_configuration_id,
             environment, asset_kind, target_asset_ref, item_state, reason_code, credential_disposition, expiry_observation
           FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = ? FOR UPDATE`,
          [item.batchId, item.sequence],
        ) as ItemRow[];
        const persisted = itemRows[0];
        if (!persisted) throw new LegacyImportLedgerConflictError('Legacy import item could not be initialized.');
        assertPersistedItem(persisted, item);
      }
      return checkpoint(batch);
    });
  }

  async applyMetadataCandidateAndCheckpoint(
    checkpointValue: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
  ): Promise<LegacyImportApplyResult> {
    if (item.state !== 'METADATA_ONLY_CANDIDATE') throw new LegacyImportLedgerConflictError('Only planned metadata candidates may be claimed.');
    const dataSource = await this.database.getDataSource();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await dataSource.transaction(async (manager) => {
          const batch = await lockedBatch(manager, checkpointValue);
          await lockedNextItem(manager, batch, checkpointValue, item);

          const targetRows = await manager.query(
            `SELECT t.id FROM ca_meta_tenants t
             INNER JOIN ca_meta_app_configurations c ON c.tenant_id = t.id AND c.id = ? AND c.provider = 'META' AND c.environment = ?
             WHERE t.id = ? AND t.status = 'ACTIVE' FOR UPDATE`,
            [item.appConfigurationId, item.environment, item.tenantId],
          ) as Array<{ id: string }>;
          if (targetRows.length !== 1) throw new LegacyImportLedgerConflictError('Legacy import target tenant/app context is unavailable.');

          const insertedClaim = await manager.query(
            `INSERT IGNORE INTO ca_meta_legacy_import_claims
             (source_record_hash, source_payload_hash, tenant_id, app_configuration_id, provider, environment,
              asset_kind, target_asset_ref, credential_disposition, expiry_observation, claim_state,
              created_batch_id, created_sequence, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'META', ?, ?, ?, ?, ?, 'UNVERIFIED_METADATA_ONLY', ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
            [item.sourceRecordHash, item.sourcePayloadHash, item.tenantId, item.appConfigurationId,
              item.environment, item.assetKind, item.deterministicAssetId, item.credentialDisposition,
              item.expiryObservation, item.batchId, item.sequence],
          );
          const claimRows = await manager.query(
            `SELECT source_payload_hash, tenant_id, app_configuration_id, environment, asset_kind,
               target_asset_ref, credential_disposition, expiry_observation
             FROM ca_meta_legacy_import_claims WHERE source_record_hash = ? FOR UPDATE`,
            [item.sourceRecordHash],
          ) as ClaimRow[];
          const stored = claimRows[0];
          if (!stored) throw new LegacyImportLedgerConflictError('Legacy import claim was not persisted.');

          if (sameClaim(stored, item)) {
            const isReplay = affectedRows(insertedClaim) !== 1;
            const updated = await advanceCheckpoint(manager, batch, item, isReplay ? 'REPLAYED' : 'CLAIMED', item.reasonCode);
            return { checkpoint: updated, disposition: isReplay ? 'REPLAYED' : 'APPLIED_METADATA_ONLY' };
          }
          const updated = await advanceCheckpoint(manager, batch, item, 'QUARANTINED_SOURCE_CHANGED', 'SOURCE_ROW_CHANGED');
          return { checkpoint: updated, disposition: 'QUARANTINED_SOURCE_CHANGED' };
        });
      } catch (error) {
        if (!isTransientConflict(error) || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw new LegacyImportLedgerConflictError();
  }

  async recordQuarantineAndCheckpoint(
    checkpointValue: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
  ): Promise<LegacyImportBatchCheckpoint> {
    if (item.state !== 'QUARANTINED') throw new LegacyImportLedgerConflictError('Only planned quarantine items may be recorded as quarantined.');
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const batch = await lockedBatch(manager, checkpointValue);
      await lockedNextItem(manager, batch, checkpointValue, item);
      return advanceCheckpoint(manager, batch, item, 'QUARANTINED', item.reasonCode);
    });
  }

  async rollbackMetadataCandidateAndCheckpoint(
    checkpointValue: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
    expectedImportedAssetVersion: number,
  ): Promise<LegacyImportBatchCheckpoint> {
    if (item.state !== 'METADATA_ONLY_CANDIDATE' || !Number.isSafeInteger(expectedImportedAssetVersion) || expectedImportedAssetVersion < 1) {
      throw new LegacyImportLedgerConflictError('Legacy metadata claim rollback request is invalid.');
    }
    if (checkpointValue.batchId !== item.batchId) {
      throw new LegacyImportLedgerConflictError('Legacy metadata claim rollback checkpoint and item belong to different batches.');
    }
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const batchRows = await manager.query(
        `SELECT batch_id, source_snapshot_hash, source_version, projection_version, item_count,
           last_completed_sequence, state FROM ca_meta_legacy_import_batches WHERE batch_id = ? FOR UPDATE`,
        [checkpointValue.batchId],
      ) as BatchRow[];
      const batch = batchRows[0];
      if (!batch) throw new LegacyImportLedgerConflictError('Legacy import batch was not initialized.');
      assertCheckpointMatches(checkpointValue, batch);
      const itemRows = await manager.query(
        `SELECT source_record_hash, source_payload_hash, source_table, tenant_id, app_configuration_id,
           environment, asset_kind, target_asset_ref, item_state, reason_code, credential_disposition, expiry_observation
         FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = ? FOR UPDATE`,
        [batch.batch_id, item.sequence],
      ) as ItemRow[];
      const persistedItem = itemRows[0];
      if (!persistedItem || persistedItem.item_state !== 'CLAIMED') {
        throw new LegacyImportLedgerConflictError('Only a claim created by this batch can be rolled back.');
      }
      assertPersistedItem(persistedItem, item);
      const removed = await manager.query(
        `DELETE FROM ca_meta_legacy_import_claims WHERE source_record_hash = ? AND created_batch_id = ?
           AND created_sequence = ? AND version = ? AND claim_state = 'UNVERIFIED_METADATA_ONLY'`,
        [item.sourceRecordHash, batch.batch_id, item.sequence, expectedImportedAssetVersion],
      );
      if (affectedRows(removed) !== 1) throw new LegacyImportLedgerConflictError('Legacy metadata claim changed or was replayed by another batch.');
      const changed = await manager.query(
        `UPDATE ca_meta_legacy_import_items SET item_state = 'ROLLED_BACK', updated_at = UTC_TIMESTAMP(6)
         WHERE batch_id = ? AND sequence = ? AND item_state = 'CLAIMED'`,
        [batch.batch_id, item.sequence],
      );
      if (affectedRows(changed) !== 1) throw new LegacyImportLedgerConflictError('Legacy metadata claim rollback could not be recorded.');
      return checkpoint(batch);
    });
  }

  async complete(checkpointValue: LegacyImportBatchCheckpoint): Promise<LegacyImportBatchCheckpoint> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const batch = await lockedBatch(manager, checkpointValue);
      if (batch.state === 'COMPLETED' && Number(batch.last_completed_sequence) === Number(batch.item_count)) return checkpoint(batch);
      if (batch.state === 'FAILED' || Number(batch.last_completed_sequence) !== Number(batch.item_count)) {
        throw new LegacyImportLedgerConflictError('Legacy import batch cannot complete before every planned item is checkpointed.');
      }
      const updated = await manager.query(
        `UPDATE ca_meta_legacy_import_batches SET state = 'COMPLETED', version = version + 1,
           updated_at = UTC_TIMESTAMP(6) WHERE batch_id = ? AND last_completed_sequence = ? AND state IN ('PLANNED','APPLYING','PAUSED')`,
        [batch.batch_id, batch.item_count],
      );
      if (affectedRows(updated) !== 1) throw new LegacyImportLedgerConflictError('Legacy import completion compare-and-swap failed.');
      return { ...checkpoint(batch), state: 'COMPLETED' };
    });
  }
}
