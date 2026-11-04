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
 * A metadata candidate is persisted only as an unverified metadata claim, not as a trusted asset,
 * authorization, grant or relation. The port has no method that accepts a source payload or credential.
 * Implementations must commit that claim/item outcome and its checkpoint in one transaction, compare
 * sourceRecordHash/sourcePayloadHash and exact target context on replay, and quarantine changes.
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
