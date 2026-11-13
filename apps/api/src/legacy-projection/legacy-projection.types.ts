import type { OutboxEventEnvelope } from '../jobs/event-validation.js';

export type ProjectionEnvironment = 'development' | 'test' | 'staging' | 'production';
export type ProjectionRecordKind = 'PAGE' | 'WHATSAPP_NUMBER' | 'AUTOMATION_CONFIG';
export type ProjectionRecordStatus = 'ACTIVE' | 'UNKNOWN' | 'REMOVED';

/** This destination is resolved from the server-owned tenant map, never from a request or event body. */
export interface LegacyProjectionTargetKey {
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly environment: ProjectionEnvironment;
}

/** Safe projection metadata. Message text, credentials, tokens, raw provider payloads and DSNs have no fields here. */
export interface LegacyProjectionRecord {
  readonly kind: ProjectionRecordKind;
  readonly centralRef: string;
  readonly legacyAssetRef: string;
  readonly sourceVersion: number;
  readonly status: ProjectionRecordStatus;
  readonly externalId: string | null;
  readonly displayName: string | null;
  readonly assetKind: string | null;
  readonly parentLegacyAssetRef: string | null;
  readonly capabilities: readonly string[];
  readonly configVersion: number | null;
  readonly tombstone: boolean;
}

/** The source adapter returns a current central snapshot, not the potentially stale data embedded in an event. */
export interface LegacyProjectionRebuildSnapshot {
  readonly tenantId: string;
  readonly targets: readonly {
    readonly target: LegacyProjectionTargetKey;
    readonly records: readonly LegacyProjectionRecord[];
  }[];
}

export interface LegacyProjectionSnapshot extends LegacyProjectionRebuildSnapshot {
  readonly event: OutboxEventEnvelope;
}

export interface LegacyProjectionCheckpoint {
  readonly tenantId: string;
  readonly destinationKeyHash: string;
  readonly centralRef: string;
  readonly sourceVersion: number;
  readonly projectionSchemaVersion: number;
  readonly contentHash: string;
  readonly tombstone: boolean;
  readonly state: 'PENDING' | 'SYNCED' | 'FAILED';
  readonly safeErrorCode: string | null;
}

export interface LegacyProjectionCheckpointStore {
  read(tenantId: string, destinationKeyHash: string, centralRef: string): Promise<LegacyProjectionCheckpoint | undefined>;
  listByDestination(tenantId: string, destinationKeyHash: string): Promise<readonly LegacyProjectionCheckpoint[]>;
  record(checkpoint: LegacyProjectionCheckpoint): Promise<void>;
}

export interface LegacyProjectionRebuildReport {
  readonly destinationKeyHash: string;
  readonly expectedCount: number;
  readonly actualCount: number;
  readonly reconciledExtraCount: number;
  readonly ambiguousExtraCount: number;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly parity: 'MATCHED' | 'MISMATCH' | 'AMBIGUOUS';
}

export interface LegacyProjectionRebuildResult extends LegacyProjectionRebuildReport {
  /** Projector-owned tombstones to persist to the central checkpoint after the destination transaction. */
  readonly tombstones: readonly LegacyProjectionRecord[];
}

export interface LegacyProjectionDestination {
  /** Must use one destination-local transaction and be safe to repeat after an ambiguous central commit. */
  apply(input: {
    readonly target: LegacyProjectionTargetKey;
    readonly tenantId: string;
    readonly records: readonly LegacyProjectionRecord[];
    readonly projectionSchemaVersion: number;
  }): Promise<void>;
  reconcile(input: {
    readonly target: LegacyProjectionTargetKey;
    readonly tenantId: string;
    readonly records: readonly LegacyProjectionRecord[];
    readonly knownOwnedCheckpoints: readonly LegacyProjectionCheckpoint[];
    readonly projectionSchemaVersion: number;
    readonly destinationKeyHash: string;
  }): Promise<LegacyProjectionRebuildResult>;
}

export interface LegacyProjectionDestinationCatalog {
  resolve(target: LegacyProjectionTargetKey): LegacyProjectionDestination | undefined;
}

export interface LegacyProjectionSource {
  loadCurrent(tenantId: string, outboxEventId: string, sourceVersion: number): Promise<LegacyProjectionSnapshot | undefined>;
  /** Trusted full current-state scan used only by an internal rebuild caller. */
  loadTenantCurrent(tenantId: string): Promise<LegacyProjectionRebuildSnapshot>;
}

export interface LegacyProjectionResult {
  readonly destinations: readonly {
    readonly destinationKeyHash: string;
    readonly applied: number;
    readonly duplicate: number;
    readonly stale: number;
    readonly state: 'SYNCED' | 'PENDING' | 'FAILED';
    readonly safeErrorCode: string | null;
  }[];
  readonly rebuildReports?: readonly LegacyProjectionRebuildReport[];
}

export class LegacyProjectionError extends Error {
  constructor(readonly safeCode: string, message: string) {
    super(message);
    this.name = 'LegacyProjectionError';
  }
}
