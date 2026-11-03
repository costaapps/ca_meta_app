import type {
  LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem, LegacyInventorySnapshot,
} from './legacy-import.types.js';

export interface LegacyInventoryReadRequest {
  /** Operator-resolved alias. Never accept a schema, host, DSN or user-selected database name here. */
  readonly catalogRef: string;
  readonly sourceVersion: string;
  readonly environment: LegacyInventorySnapshot['environment'];
  readonly maxRows: number;
}

/** Implementations may issue only allowlisted SELECTs and credential-presence expressions. */
export interface LegacyInventoryReadPort {
  readSanitizedInventory(request: LegacyInventoryReadRequest): Promise<unknown>;
}

export interface LegacyImportApplyResult {
  readonly checkpoint: LegacyImportBatchCheckpoint;
  readonly disposition: 'APPLIED_METADATA_ONLY' | 'REPLAYED' | 'SKIPPED_NEWER_REAUTH' | 'QUARANTINED_SOURCE_CHANGED';
}

/**
 * Future runtime adapter. A metadata candidate is written as an unverified claim with its legacy
 * reference only; this port has no method that accepts a token or creates a grant/relation.
 * Implementations must commit the target change and checkpoint in one transaction, compare the stable
 * sourceRecordHash and sourcePayloadHash on replay, and quarantine changed source rows instead of overwriting.
 */
export interface LegacyImportApplyPort {
  beginOrResume(plan: LegacyImportPlan): Promise<LegacyImportBatchCheckpoint>;
  applyMetadataCandidateAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
  ): Promise<LegacyImportApplyResult>;
  recordQuarantineAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
  ): Promise<LegacyImportBatchCheckpoint>;
  rollbackMetadataCandidateAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    item: LegacyImportPlanItem,
    expectedImportedAssetVersion: number,
  ): Promise<LegacyImportBatchCheckpoint>;
  complete(checkpoint: LegacyImportBatchCheckpoint): Promise<LegacyImportBatchCheckpoint>;
}

/** Storage-neutral report writer. Production reports must be retained in a restricted location. */
export interface LegacyImportReportSink {
  writeSanitizedReport(report: LegacyImportPlan['report']): Promise<void>;
}
