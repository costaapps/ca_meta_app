import type { EntityManager } from 'typeorm';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import {
  createMigrationBatchManifestReport,
  enableMigrationShadowRead,
  rollbackMigrationCohort,
  switchMigrationWriter,
  validateMigrationWriterMatrix,
  MigrationExecutionInputError,
} from './migration-execution.policy.js';
import {
  MIGRATION_COUNT_KEYS,
  type MigrationBatchCheckpoint,
  type MigrationBatchManifest,
  type MigrationBatchManifestReport,
  type MigrationBatchState,
  type MigrationChannelFamily,
  type MigrationCohortPhase,
  type MigrationConsumerKind,
  type MigrationFunction,
  type MigrationSurfaceCounts,
  type ShadowReadReport,
  type MigrationWriterAssignment,
  type MigrationWriterOwner,
  type MigrationWriterRollbackResult,
} from './migration-execution.types.js';

interface ManifestRow {
  batch_id: string;
  source_snapshot_hash: string;
  source_version: string;
  projection_version: string;
  catalog_ref: string;
  planned_rows: number | string;
  candidate_rows: number | string;
  quarantined_rows: number | string;
  credential_reauth_rows: number | string;
  before_assets: number | string;
  before_templates: number | string;
  before_message_configs: number | string;
  before_relationships: number | string;
  before_credential_refs: number | string;
  after_assets: number | string | null;
  after_templates: number | string | null;
  after_message_configs: number | string | null;
  after_relationships: number | string | null;
  after_credential_refs: number | string | null;
  last_completed_sequence: number | string;
  state: MigrationBatchState;
  version: number | string;
}

interface ImportBatchRow {
  batch_id: string;
  source_snapshot_hash: string;
  source_version: string;
  projection_version: string;
  item_count: number | string;
  last_completed_sequence: number | string;
  state: MigrationBatchState;
}

interface WriterRow {
  cohort_id: string;
  tenant_id: string;
  channel_family: MigrationChannelFamily;
  consumer_kind: MigrationConsumerKind;
  function_name: MigrationFunction;
  writer_owner: MigrationWriterOwner;
  previous_writer_owner: MigrationWriterOwner | null;
  phase: MigrationCohortPhase;
  shadow_read_enabled: number | boolean;
  shadow_read_candidate_snapshot_hash: string | null;
  legacy_route_verified: number | boolean;
  unresolved_external_effects: number | string;
  drift_reconciled_snapshot_hash: string | null;
  version: number | string;
}

export class MigrationControlConflictError extends Error {
  constructor(message = 'Migration control state conflicts with the requested checkpoint.') {
    super(message);
    this.name = 'MigrationControlConflictError';
  }
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return typeof header === 'object' && header !== null && 'affectedRows' in header
    ? Number((header as { affectedRows?: number }).affectedRows ?? 0) : 0;
}

function asCounts(row: ManifestRow, prefix: 'before' | 'after'): MigrationSurfaceCounts | null {
  const keys = {
    assets: row[`${prefix}_assets` as const],
    templates: row[`${prefix}_templates` as const],
    messageConfigurations: row[`${prefix}_message_configs` as const],
    relationships: row[`${prefix}_relationships` as const],
    credentialReferences: row[`${prefix}_credential_refs` as const],
  };
  const values = Object.values(keys);
  if (prefix === 'after' && values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) throw new MigrationControlConflictError('Stored aggregate counts are incomplete.');
  const parsed = Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, Number(value)])) as MigrationSurfaceCounts;
  for (const key of MIGRATION_COUNT_KEYS) if (!Number.isSafeInteger(parsed[key]) || parsed[key] < 0) {
    throw new MigrationControlConflictError('Stored aggregate counts are invalid.');
  }
  return parsed;
}

function reportFromRow(row: ManifestRow): MigrationBatchManifestReport {
  const beforeCounts = asCounts(row, 'before');
  if (!beforeCounts) throw new MigrationControlConflictError();
  return createMigrationBatchManifestReport({
    batchId: row.batch_id,
    sourceSnapshotHash: row.source_snapshot_hash,
    sourceVersion: row.source_version,
    projectionVersion: row.projection_version,
    catalogRef: row.catalog_ref,
    plannedRows: Number(row.planned_rows),
    candidateRows: Number(row.candidate_rows),
    quarantinedRows: Number(row.quarantined_rows),
    credentialReauthRows: Number(row.credential_reauth_rows),
    beforeCounts,
  }, asCounts(row, 'after'));
}

function checkpointFromRow(row: ManifestRow): MigrationBatchCheckpoint {
  return {
    batchId: row.batch_id,
    lastCompletedSequence: Number(row.last_completed_sequence),
    state: row.state,
    version: Number(row.version),
  };
}

function compareManifestRow(row: ManifestRow, expected: MigrationBatchManifest): void {
  const before = asCounts(row, 'before');
  if (row.batch_id !== expected.batchId || row.source_snapshot_hash !== expected.sourceSnapshotHash ||
      row.source_version !== expected.sourceVersion || row.projection_version !== expected.projectionVersion ||
      row.catalog_ref !== expected.catalogRef || Number(row.planned_rows) !== expected.plannedRows ||
      Number(row.candidate_rows) !== expected.candidateRows || Number(row.quarantined_rows) !== expected.quarantinedRows ||
      Number(row.credential_reauth_rows) !== expected.credentialReauthRows ||
      !before || MIGRATION_COUNT_KEYS.some((key) => before[key] !== expected.beforeCounts[key])) {
    throw new MigrationControlConflictError('Batch ID is already bound to different sanitized provenance or counts.');
  }
}

function writerFromRow(row: WriterRow): MigrationWriterAssignment {
  return {
    cohortId: row.cohort_id,
    tenantId: row.tenant_id,
    channelFamily: row.channel_family,
    consumerKind: row.consumer_kind,
    functionName: row.function_name,
    writerOwner: row.writer_owner,
    previousWriterOwner: row.previous_writer_owner,
    phase: row.phase,
    shadowReadEnabled: Boolean(row.shadow_read_enabled),
    shadowReadCandidateSnapshotHash: row.shadow_read_candidate_snapshot_hash,
    legacyRouteVerified: Boolean(row.legacy_route_verified),
    unresolvedExternalEffects: Number(row.unresolved_external_effects),
    driftReconciledSnapshotHash: row.drift_reconciled_snapshot_hash,
    version: Number(row.version),
  };
}

async function manifestRow(manager: EntityManager, batchId: string): Promise<ManifestRow> {
  const rows = await manager.query(
    `SELECT * FROM ca_meta_migration_batch_manifests WHERE batch_id = ? FOR UPDATE`, [batchId],
  ) as ManifestRow[];
  const row = rows[0];
  if (!row) throw new MigrationControlConflictError('Migration manifest has not been initialized.');
  return row;
}

async function writerRows(manager: EntityManager, scope: {
  cohortId: string;
  tenantId: string;
  channelFamily: MigrationChannelFamily;
  consumerKind: MigrationConsumerKind;
}): Promise<MigrationWriterAssignment[]> {
  const rows = await manager.query(
    `SELECT cohort_id, tenant_id, channel_family, consumer_kind, function_name, writer_owner,
       previous_writer_owner, phase, shadow_read_enabled, shadow_read_candidate_snapshot_hash, legacy_route_verified,
       unresolved_external_effects, drift_reconciled_snapshot_hash, version
     FROM ca_meta_migration_cohort_writers
     WHERE cohort_id = ? AND tenant_id = ? AND channel_family = ? AND consumer_kind = ?
     ORDER BY function_name FOR UPDATE`,
    [scope.cohortId, scope.tenantId, scope.channelFamily, scope.consumerKind],
  ) as WriterRow[];
  return rows.map(writerFromRow);
}

async function updateWriterRow(manager: EntityManager, assignment: MigrationWriterAssignment, expectedVersion: number): Promise<void> {
  const result = await manager.query(
    `UPDATE ca_meta_migration_cohort_writers SET writer_owner = ?, previous_writer_owner = ?, phase = ?,
       shadow_read_enabled = ?, shadow_read_candidate_snapshot_hash = ?, drift_reconciled_snapshot_hash = ?,
       version = version + 1, updated_at = UTC_TIMESTAMP(6)
     WHERE tenant_id = ? AND channel_family = ? AND consumer_kind = ? AND function_name = ? AND cohort_id = ? AND version = ?`,
    [assignment.writerOwner, assignment.previousWriterOwner, assignment.phase, assignment.shadowReadEnabled ? 1 : 0,
      assignment.shadowReadCandidateSnapshotHash, assignment.driftReconciledSnapshotHash,
      assignment.tenantId, assignment.channelFamily, assignment.consumerKind, assignment.functionName,
      assignment.cohortId, expectedVersion],
  );
  if (affectedRows(result) !== 1) throw new MigrationControlConflictError('Writer matrix compare-and-swap failed.');
}

export class MysqlMigrationBatchManifestRepository {
  constructor(private readonly database: DurableWorkDatabase) {}

  async beginOrResume(
    manifest: MigrationBatchManifest,
    sourceCheckpoint: {
      readonly batchId: string;
      readonly sourceSnapshotHash: string;
      readonly sourceVersion: string;
      readonly projectionVersion: string;
      readonly lastCompletedSequence: number;
      readonly state: MigrationBatchState;
    },
  ): Promise<MigrationBatchCheckpoint> {
    if (sourceCheckpoint.batchId !== manifest.batchId || sourceCheckpoint.sourceSnapshotHash !== manifest.sourceSnapshotHash ||
        sourceCheckpoint.sourceVersion !== manifest.sourceVersion || sourceCheckpoint.projectionVersion !== manifest.projectionVersion ||
        sourceCheckpoint.lastCompletedSequence < 0 || sourceCheckpoint.lastCompletedSequence > manifest.plannedRows ||
        manifest.candidateRows + manifest.quarantinedRows !== manifest.plannedRows) {
      throw new MigrationControlConflictError('M3.11 checkpoint does not match the sanitized manifest.');
    }
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const importRows = await manager.query(
        `SELECT batch_id, source_snapshot_hash, source_version, projection_version, item_count,
           last_completed_sequence, state FROM ca_meta_legacy_import_batches WHERE batch_id = ? FOR UPDATE`,
        [manifest.batchId],
      ) as ImportBatchRow[];
      const importBatch = importRows[0];
      if (!importBatch || importBatch.source_snapshot_hash !== manifest.sourceSnapshotHash ||
          importBatch.source_version !== manifest.sourceVersion || importBatch.projection_version !== manifest.projectionVersion ||
          Number(importBatch.item_count) !== manifest.plannedRows ||
          Number(importBatch.last_completed_sequence) !== sourceCheckpoint.lastCompletedSequence || importBatch.state !== sourceCheckpoint.state) {
        throw new MigrationControlConflictError('Canonical M3.11 ledger differs from the requested checkpoint.');
      }
      const before = manifest.beforeCounts;
      await manager.query(
        `INSERT IGNORE INTO ca_meta_migration_batch_manifests
         (batch_id, source_snapshot_hash, source_version, projection_version, catalog_ref, planned_rows,
          candidate_rows, quarantined_rows, credential_reauth_rows, before_assets, before_templates,
          before_message_configs, before_relationships, before_credential_refs, last_completed_sequence,
          state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [manifest.batchId, manifest.sourceSnapshotHash, manifest.sourceVersion, manifest.projectionVersion,
          manifest.catalogRef, manifest.plannedRows, manifest.candidateRows, manifest.quarantinedRows,
          manifest.credentialReauthRows, before.assets, before.templates, before.messageConfigurations,
          before.relationships, before.credentialReferences, sourceCheckpoint.lastCompletedSequence, sourceCheckpoint.state],
      );
      let stored = await manifestRow(manager, manifest.batchId);
      compareManifestRow(stored, manifest);
      if (Number(stored.last_completed_sequence) > sourceCheckpoint.lastCompletedSequence ||
          (stored.state === 'COMPLETED' && sourceCheckpoint.state !== 'COMPLETED')) {
        throw new MigrationControlConflictError('Migration manifest is ahead of the authoritative M3.11 checkpoint.');
      }
      if (Number(stored.last_completed_sequence) !== sourceCheckpoint.lastCompletedSequence || stored.state !== sourceCheckpoint.state) {
        const result = await manager.query(
          `UPDATE ca_meta_migration_batch_manifests SET last_completed_sequence = ?, state = ?,
             version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE batch_id = ? AND version = ?`,
          [sourceCheckpoint.lastCompletedSequence, sourceCheckpoint.state, manifest.batchId, Number(stored.version)],
        );
        if (affectedRows(result) !== 1) throw new MigrationControlConflictError('Manifest checkpoint compare-and-swap failed.');
        stored = await manifestRow(manager, manifest.batchId);
      }
      return checkpointFromRow(stored);
    });
  }

  /** Mirrors the authoritative M3.11 checkpoint after each committed item; a crash is repaired by resume. */
  async syncCheckpoint(sourceCheckpoint: {
    readonly batchId: string;
    readonly sourceSnapshotHash: string;
    readonly sourceVersion: string;
    readonly projectionVersion: string;
    readonly lastCompletedSequence: number;
    readonly state: MigrationBatchState;
  }): Promise<MigrationBatchCheckpoint> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const canonicalRows = await manager.query(
        `SELECT batch_id, source_snapshot_hash, source_version, projection_version, item_count,
           last_completed_sequence, state FROM ca_meta_legacy_import_batches WHERE batch_id = ? FOR UPDATE`,
        [sourceCheckpoint.batchId],
      ) as ImportBatchRow[];
      const canonical = canonicalRows[0];
      if (!canonical || canonical.source_snapshot_hash !== sourceCheckpoint.sourceSnapshotHash ||
          canonical.source_version !== sourceCheckpoint.sourceVersion || canonical.projection_version !== sourceCheckpoint.projectionVersion ||
          Number(canonical.last_completed_sequence) !== sourceCheckpoint.lastCompletedSequence || canonical.state !== sourceCheckpoint.state) {
        throw new MigrationControlConflictError('Supplied checkpoint is not the current M3.11 ledger state.');
      }
      let stored = await manifestRow(manager, sourceCheckpoint.batchId);
      if (Number(stored.last_completed_sequence) > sourceCheckpoint.lastCompletedSequence ||
          (stored.state === 'COMPLETED' && sourceCheckpoint.state !== 'COMPLETED')) {
        throw new MigrationControlConflictError('Migration manifest is ahead of the authoritative M3.11 checkpoint.');
      }
      if (Number(stored.last_completed_sequence) !== sourceCheckpoint.lastCompletedSequence || stored.state !== sourceCheckpoint.state) {
        const updated = await manager.query(
          `UPDATE ca_meta_migration_batch_manifests SET last_completed_sequence = ?, state = ?,
             version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE batch_id = ? AND version = ?`,
          [sourceCheckpoint.lastCompletedSequence, sourceCheckpoint.state, sourceCheckpoint.batchId, Number(stored.version)],
        );
        if (affectedRows(updated) !== 1) throw new MigrationControlConflictError('Manifest checkpoint compare-and-swap failed.');
        stored = await manifestRow(manager, sourceCheckpoint.batchId);
      }
      return checkpointFromRow(stored);
    });
  }

  async recordAfterCounts(batchId: string, expectedVersion: number, afterCounts: MigrationSurfaceCounts): Promise<MigrationBatchManifestReport> {
    const values = MIGRATION_COUNT_KEYS.map((key) => afterCounts[key]);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new MigrationExecutionInputError();
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const row = await manifestRow(manager, batchId);
      if (row.state !== 'COMPLETED' || Number(row.last_completed_sequence) !== Number(row.planned_rows)) {
        throw new MigrationControlConflictError('After-counts require a completed migration batch.');
      }
      const current = asCounts(row, 'after');
      if (current) {
        if (MIGRATION_COUNT_KEYS.some((key) => current[key] !== afterCounts[key])) {
          throw new MigrationControlConflictError('A completed batch cannot replace its saved after-counts.');
        }
        return reportFromRow(row);
      }
      if (Number(row.version) !== expectedVersion) throw new MigrationControlConflictError('Migration manifest version is stale.');
      const updated = await manager.query(
        `UPDATE ca_meta_migration_batch_manifests SET after_assets = ?, after_templates = ?,
           after_message_configs = ?, after_relationships = ?, after_credential_refs = ?,
           version = version + 1, updated_at = UTC_TIMESTAMP(6) WHERE batch_id = ? AND version = ?`,
        [...values, batchId, expectedVersion],
      );
      if (affectedRows(updated) !== 1) throw new MigrationControlConflictError('After-count report compare-and-swap failed.');
      return reportFromRow(await manifestRow(manager, batchId));
    });
  }

  async readReport(batchId: string): Promise<MigrationBatchManifestReport> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT * FROM ca_meta_migration_batch_manifests WHERE batch_id = ?`, [batchId],
    ) as ManifestRow[];
    if (!rows[0]) throw new MigrationControlConflictError('Migration manifest was not found.');
    return reportFromRow(rows[0]);
  }

  async readCheckpoint(batchId: string): Promise<MigrationBatchCheckpoint> {
    const dataSource = await this.database.getDataSource();
    const rows = await dataSource.query(
      `SELECT batch_id, last_completed_sequence, state, version
       FROM ca_meta_migration_batch_manifests WHERE batch_id = ?`, [batchId],
    ) as Array<Pick<ManifestRow, 'batch_id' | 'last_completed_sequence' | 'state' | 'version'>>;
    const row = rows[0];
    if (!row) throw new MigrationControlConflictError('Migration manifest was not found.');
    return checkpointFromRow(row as ManifestRow);
  }
}

export class MysqlMigrationCohortWriterRepository {
  constructor(private readonly database: DurableWorkDatabase) {}

  async initialize(entries: readonly MigrationWriterAssignment[]): Promise<readonly MigrationWriterAssignment[]> {
    const matrix = validateMigrationWriterMatrix(entries);
    const timestamped = matrix[0];
    if (!timestamped) throw new MigrationExecutionInputError('Writer matrix is empty.');
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      for (const entry of matrix) {
        await manager.query(
          `INSERT IGNORE INTO ca_meta_migration_cohort_writers
           (cohort_id, tenant_id, channel_family, consumer_kind, function_name, writer_owner,
           previous_writer_owner, phase, shadow_read_enabled, shadow_read_candidate_snapshot_hash, legacy_route_verified,
            unresolved_external_effects, drift_reconciled_snapshot_hash, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [entry.cohortId, entry.tenantId, entry.channelFamily, entry.consumerKind, entry.functionName,
            entry.writerOwner, entry.previousWriterOwner, entry.phase, entry.shadowReadEnabled ? 1 : 0,
            entry.shadowReadCandidateSnapshotHash, entry.legacyRouteVerified ? 1 : 0,
            entry.unresolvedExternalEffects, entry.driftReconciledSnapshotHash, entry.version],
        );
      }
      const stored = await writerRows(manager, {
        cohortId: timestamped.cohortId, tenantId: timestamped.tenantId,
        channelFamily: timestamped.channelFamily, consumerKind: timestamped.consumerKind,
      });
      validateMigrationWriterMatrix(stored);
      if (stored.length !== matrix.length || stored.some((actual) => {
        const expected = matrix.find((entry) => entry.functionName === actual.functionName);
        return !expected || expected.writerOwner !== actual.writerOwner || expected.phase !== actual.phase ||
          expected.shadowReadEnabled !== actual.shadowReadEnabled ||
          expected.shadowReadCandidateSnapshotHash !== actual.shadowReadCandidateSnapshotHash ||
          expected.legacyRouteVerified !== actual.legacyRouteVerified ||
          expected.unresolvedExternalEffects !== actual.unresolvedExternalEffects ||
          expected.driftReconciledSnapshotHash !== actual.driftReconciledSnapshotHash || expected.version !== actual.version;
      })) throw new MigrationControlConflictError('Cohort ID is already bound to a different writer matrix.');
      return stored;
    });
  }

  async enableShadowRead(scope: {
    readonly cohortId: string;
    readonly tenantId: string;
    readonly channelFamily: MigrationChannelFamily;
    readonly consumerKind: MigrationConsumerKind;
  }): Promise<readonly MigrationWriterAssignment[]> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const current = await writerRows(manager, scope);
      const changed = enableMigrationShadowRead(current);
      for (const entry of changed) {
        const previous = current.find((candidate) => candidate.functionName === entry.functionName);
        if (!previous) throw new MigrationControlConflictError();
        const result = await manager.query(
          `UPDATE ca_meta_migration_cohort_writers SET phase = ?, shadow_read_enabled = 1,
             version = version + 1, updated_at = UTC_TIMESTAMP(6)
           WHERE tenant_id = ? AND channel_family = ? AND consumer_kind = ? AND function_name = ? AND cohort_id = ? AND version = ?`,
          [entry.phase, entry.tenantId, entry.channelFamily, entry.consumerKind, entry.functionName,
            entry.cohortId, previous.version],
        );
        if (affectedRows(result) !== 1) throw new MigrationControlConflictError('Shadow-read matrix compare-and-swap failed.');
      }
      return writerRows(manager, scope);
    });
  }

  async switchWriter(input: {
    readonly scope: {
      readonly cohortId: string;
      readonly tenantId: string;
      readonly channelFamily: MigrationChannelFamily;
      readonly consumerKind: MigrationConsumerKind;
    };
    readonly functionName: MigrationFunction;
    readonly expectedVersion: number;
    readonly nextOwner: MigrationWriterOwner;
    readonly driftReconciliation: import('./migration-execution.types.js').MigrationDriftReconciliation;
    readonly shadowReadReport: ShadowReadReport | undefined;
  }): Promise<MigrationWriterAssignment> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const current = await writerRows(manager, input.scope);
      validateMigrationWriterMatrix(current);
      const entry = current.find((candidate) => candidate.functionName === input.functionName);
      if (!entry) throw new MigrationControlConflictError('Writer matrix function is not configured.');
      if (!input.driftReconciliation) throw new MigrationControlConflictError('Current drift reconciliation is required before cutover.');
      if (current.some((candidate) => !candidate.shadowReadEnabled ||
          (candidate.phase !== 'SHADOW_READ' && candidate.phase !== 'CUTOVER'))) {
        throw new MigrationControlConflictError('Every cohort function must have entered shadow-read before cutover.');
      }
      if (current.some((candidate) => candidate.phase === 'CUTOVER' &&
          (candidate.driftReconciledSnapshotHash !== input.driftReconciliation.currentSnapshotHash ||
            candidate.shadowReadCandidateSnapshotHash !== input.shadowReadReport?.candidateSnapshotHash))) {
        throw new MigrationControlConflictError('Partial cutover already uses different source or shadow evidence.');
      }
      const changed = switchMigrationWriter(entry, input.expectedVersion, input.nextOwner,
        input.driftReconciliation, input.shadowReadReport);
      await updateWriterRow(manager, changed, input.expectedVersion);
      const result = (await writerRows(manager, input.scope)).find((candidate) => candidate.functionName === input.functionName);
      if (!result) throw new MigrationControlConflictError('Writer transition was not persisted.');
      return result;
    });
  }

  async readMatrix(scope: {
    readonly cohortId: string;
    readonly tenantId: string;
    readonly channelFamily: MigrationChannelFamily;
    readonly consumerKind: MigrationConsumerKind;
  }): Promise<readonly MigrationWriterAssignment[]> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => validateMigrationWriterMatrix(await writerRows(manager, scope)));
  }

  async rollbackCohort(input: {
    readonly scope: {
      readonly cohortId: string;
      readonly tenantId: string;
      readonly channelFamily: MigrationChannelFamily;
      readonly consumerKind: MigrationConsumerKind;
    };
    readonly expectedVersions: Readonly<Partial<Record<MigrationFunction, number>>>;
  }): Promise<MigrationWriterRollbackResult> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction(async (manager) => {
      const current = await writerRows(manager, input.scope);
      const expectedVersions: Partial<Record<MigrationFunction, number>> = {};
      for (const entry of current) {
        const version = input.expectedVersions[entry.functionName];
        if (version === undefined) throw new MigrationControlConflictError('Rollback requires the current version of every cohort writer.');
        expectedVersions[entry.functionName] = version;
      }
      const result = rollbackMigrationCohort(current, expectedVersions);
      for (const entry of result.assignments) {
        const previous = current.find((candidate) => candidate.functionName === entry.functionName);
        if (!previous) throw new MigrationControlConflictError();
        await updateWriterRow(manager, entry, previous.version);
      }
      const saved = await writerRows(manager, input.scope);
      validateMigrationWriterMatrix(saved);
      return { ...result, assignments: saved };
    });
  }
}
