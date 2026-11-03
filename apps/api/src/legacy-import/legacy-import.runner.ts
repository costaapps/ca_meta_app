import type { LegacyImportBatchCheckpoint, LegacyImportPlan } from './legacy-import.types.js';
import type { LegacyImportApplyPort } from './legacy-import.ports.js';

export class LegacyImportCheckpointError extends Error {
  constructor() {
    super('Legacy import checkpoint does not match the planned source version.');
    this.name = 'LegacyImportCheckpointError';
  }
}

function assertCheckpoint(plan: LegacyImportPlan, checkpoint: LegacyImportBatchCheckpoint): void {
  if (checkpoint.batchId !== plan.batchId || checkpoint.sourceSnapshotHash !== plan.report.sourceSnapshotHash ||
      checkpoint.sourceVersion !== plan.sourceVersion || checkpoint.projectionVersion !== plan.projectionVersion ||
      !Number.isSafeInteger(checkpoint.lastCompletedSequence) || checkpoint.lastCompletedSequence < 0 ||
      checkpoint.lastCompletedSequence > plan.items.length ||
      !['PLANNED', 'APPLYING', 'PAUSED', 'COMPLETED', 'FAILED'].includes(checkpoint.state)) {
    throw new LegacyImportCheckpointError();
  }
}

/**
 * Storage-neutral resumable runner. It is intentionally not wired to an API route or production CLI.
 * A production port must atomically commit its metadata-only target write with each checkpoint.
 */
export async function executeLegacyImportPlan(plan: LegacyImportPlan, targetAndLedger: LegacyImportApplyPort): Promise<LegacyImportBatchCheckpoint> {
  let checkpoint = await targetAndLedger.beginOrResume(plan);
  assertCheckpoint(plan, checkpoint);
  if (checkpoint.state === 'COMPLETED') return checkpoint;
  if (checkpoint.state === 'FAILED') throw new LegacyImportCheckpointError();

  for (const item of plan.items) {
    if (item.sequence <= checkpoint.lastCompletedSequence) continue;
    if (item.state === 'QUARANTINED') {
      checkpoint = await targetAndLedger.recordQuarantineAndCheckpoint(checkpoint, item);
    } else {
      checkpoint = (await targetAndLedger.applyMetadataCandidateAndCheckpoint(checkpoint, item)).checkpoint;
    }
    assertCheckpoint(plan, checkpoint);
    if (checkpoint.lastCompletedSequence !== item.sequence) throw new LegacyImportCheckpointError();
  }

  checkpoint = await targetAndLedger.complete(checkpoint);
  assertCheckpoint(plan, checkpoint);
  if (checkpoint.state !== 'COMPLETED' || checkpoint.lastCompletedSequence !== plan.items.length) {
    throw new LegacyImportCheckpointError();
  }
  return checkpoint;
}
