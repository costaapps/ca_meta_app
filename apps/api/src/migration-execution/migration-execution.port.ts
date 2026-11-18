import type {
  LegacyImportApplyPort, LegacyImportApplyResult,
} from '../legacy-import/legacy-import.ports.js';
import type {
  LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem,
} from '../legacy-import/legacy-import.types.js';
import type {
  MigrationBatchManifest, MigrationBatchState,
} from './migration-execution.types.js';
import { MysqlMigrationBatchManifestRepository } from './migration-execution-control.store.js';

function controlState(checkpoint: LegacyImportBatchCheckpoint): MigrationBatchState {
  return checkpoint.state;
}

/**
 * Mirrors M3.11's durable item/checkpoint transaction into the M5.09 provenance manifest.
 * The M3.11 ledger remains authoritative; a crash between the two commits is repaired on resume.
 */
export class MigrationManifestTrackingApplyPort implements LegacyImportApplyPort {
  constructor(
    private readonly delegate: LegacyImportApplyPort,
    private readonly manifests: MysqlMigrationBatchManifestRepository,
    private readonly manifest: MigrationBatchManifest,
  ) {}

  async beginOrResume(plan: LegacyImportPlan): Promise<LegacyImportBatchCheckpoint> {
    const checkpoint = await this.delegate.beginOrResume(plan);
    if (checkpoint.batchId !== this.manifest.batchId) throw new Error('M5.09 manifest does not match the M3.11 plan.');
    await this.manifests.beginOrResume(this.manifest, {
      batchId: checkpoint.batchId,
      sourceSnapshotHash: checkpoint.sourceSnapshotHash,
      sourceVersion: checkpoint.sourceVersion,
      projectionVersion: checkpoint.projectionVersion,
      lastCompletedSequence: checkpoint.lastCompletedSequence,
      state: controlState(checkpoint),
    });
    return checkpoint;
  }

  async applyMetadataCandidateAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
  ): Promise<LegacyImportApplyResult> {
    const result = await this.delegate.applyMetadataCandidateAndCheckpoint(checkpoint, item);
    await this.manifests.syncCheckpoint({
      batchId: result.checkpoint.batchId,
      sourceSnapshotHash: result.checkpoint.sourceSnapshotHash,
      sourceVersion: result.checkpoint.sourceVersion,
      projectionVersion: result.checkpoint.projectionVersion,
      lastCompletedSequence: result.checkpoint.lastCompletedSequence,
      state: controlState(result.checkpoint),
    });
    return result;
  }

  async recordQuarantineAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
  ): Promise<LegacyImportBatchCheckpoint> {
    const result = await this.delegate.recordQuarantineAndCheckpoint(checkpoint, item);
    await this.manifests.syncCheckpoint({
      batchId: result.batchId,
      sourceSnapshotHash: result.sourceSnapshotHash,
      sourceVersion: result.sourceVersion,
      projectionVersion: result.projectionVersion,
      lastCompletedSequence: result.lastCompletedSequence,
      state: controlState(result),
    });
    return result;
  }

  async rollbackMetadataCandidateAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
    expectedImportedAssetVersion: number,
  ): Promise<LegacyImportBatchCheckpoint> {
    const result = await this.delegate.rollbackMetadataCandidateAndCheckpoint(checkpoint, item, expectedImportedAssetVersion);
    await this.manifests.syncCheckpoint({
      batchId: result.batchId,
      sourceSnapshotHash: result.sourceSnapshotHash,
      sourceVersion: result.sourceVersion,
      projectionVersion: result.projectionVersion,
      lastCompletedSequence: result.lastCompletedSequence,
      state: controlState(result),
    });
    return result;
  }

  async complete(checkpoint: LegacyImportBatchCheckpoint): Promise<LegacyImportBatchCheckpoint> {
    const result = await this.delegate.complete(checkpoint);
    await this.manifests.syncCheckpoint({
      batchId: result.batchId,
      sourceSnapshotHash: result.sourceSnapshotHash,
      sourceVersion: result.sourceVersion,
      projectionVersion: result.projectionVersion,
      lastCompletedSequence: result.lastCompletedSequence,
      state: controlState(result),
    });
    return result;
  }
}
