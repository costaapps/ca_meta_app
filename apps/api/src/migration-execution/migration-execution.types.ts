import type { LegacyImportPlan } from '../legacy-import/legacy-import.types.js';

export const MIGRATION_COUNT_KEYS = [
  'assets',
  'templates',
  'messageConfigurations',
  'relationships',
  'credentialReferences',
] as const;

export type MigrationCountKey = typeof MIGRATION_COUNT_KEYS[number];
export type MigrationSurfaceCounts = Readonly<Record<MigrationCountKey, number>>;
export type MigrationChannelFamily = 'WHATSAPP_EXCLUSIVE' | 'WHATSAPP_COEXISTENCE' | 'FACEBOOK' | 'INSTAGRAM';
export type MigrationConsumerKind = 'PORTAL' | 'LEGACY_PHP' | 'INTERNAL_WORKER' | 'WEBHOOK_INGRESS' | 'OTHER_INTERNAL';
export type MigrationFunction = 'CONFIGURATION' | 'CREDENTIAL_REFERENCE' | 'LEGACY_PROJECTION' | 'OPERATION_RELAY' | 'WEBHOOK_DISPATCH';
export type MigrationWriterOwner = 'LEGACY' | 'CENTRAL' | 'PROJECTOR' | 'RELAY' | 'NEW';
export type MigrationCohortPhase = 'PREPARED' | 'SHADOW_READ' | 'CUTOVER' | 'PAUSED' | 'ROLLED_BACK';
export type MigrationBatchState = 'PLANNED' | 'APPLYING' | 'PAUSED' | 'COMPLETED' | 'FAILED';

export interface MigrationBatchManifest {
  readonly batchId: string;
  readonly sourceSnapshotHash: string;
  readonly sourceVersion: string;
  readonly projectionVersion: string;
  /** An operator-resolved catalog alias. It is not a database/schema/DSN name. */
  readonly catalogRef: string;
  readonly plannedRows: number;
  readonly candidateRows: number;
  readonly quarantinedRows: number;
  readonly credentialReauthRows: number;
  readonly beforeCounts: MigrationSurfaceCounts;
}

export interface MigrationBatchManifestReport extends MigrationBatchManifest {
  readonly mode: 'DRY_RUN';
  readonly afterCounts: MigrationSurfaceCounts | null;
  readonly countDeltas: MigrationSurfaceCounts | null;
}

export interface MigrationBatchCheckpoint {
  readonly batchId: string;
  readonly lastCompletedSequence: number;
  readonly state: MigrationBatchState;
  readonly version: number;
}

export interface SourceRecordFingerprint {
  /** Keyed digest of a stable source identity; never a raw source row ID. */
  readonly sourceRecordHash: string;
  /** Keyed digest of the allowlisted, non-secret source projection. */
  readonly sourcePayloadHash: string;
}

export interface MigrationDriftEvidence {
  readonly baselineSnapshotHash: string;
  readonly currentSnapshotHash: string;
  readonly addedSourceRecordHashes: readonly string[];
  readonly changedSourceRecordHashes: readonly string[];
  readonly removedSourceRecordHashes: readonly string[];
  readonly addedCount: number;
  readonly changedCount: number;
  readonly removedCount: number;
}

export interface MigrationDriftReconciliation {
  readonly baselineSnapshotHash: string;
  readonly currentSnapshotHash: string;
  readonly addedCount: number;
  readonly changedCount: number;
  readonly removedCount: number;
  readonly unresolvedCount: number;
  readonly readyForCutover: boolean;
}

export interface MigrationDriftSnapshot {
  readonly snapshotHash: string;
  readonly records: readonly SourceRecordFingerprint[];
}

/** Fingerprints are generated inside the read boundary; no values or row IDs enter the report. */
export interface ShadowReadFingerprint {
  readonly resourceRefHash: string;
  readonly kind: 'ASSET' | 'TEMPLATE' | 'MESSAGE_CONFIGURATION' | 'RELATIONSHIP';
  readonly metadataHmac: string;
  readonly statusHmac: string;
  readonly configurationHmac: string;
  readonly relationshipHmac: string;
}

export interface ShadowReadSnapshot {
  /** Opaque version and digest must identify the same complete sanitized snapshot. */
  readonly sourceVersion: string;
  readonly snapshotHash: string;
  readonly resources: readonly ShadowReadFingerprint[];
}

/** This read-only port returns a fresh source view and deliberately has no write/send/subscription methods. */
export interface ShadowReadPort {
  readSanitizedSnapshot(scope: MigrationCohortScope): Promise<ShadowReadSnapshot>;
}

export interface ShadowReadReport {
  readonly mode: 'SHADOW_READ';
  readonly readOnly: true;
  readonly scope: MigrationCohortScope;
  readonly legacyVersion: string;
  readonly candidateVersion: string;
  readonly legacySnapshotHash: string;
  readonly candidateSnapshotHash: string;
  readonly comparedCount: number;
  readonly missingCount: number;
  readonly addedCount: number;
  readonly metadataMismatchCount: number;
  readonly statusMismatchCount: number;
  readonly configurationMismatchCount: number;
  readonly relationshipMismatchCount: number;
  readonly matches: boolean;
}

export interface MigrationWriterAssignment {
  readonly cohortId: string;
  readonly tenantId: string;
  readonly channelFamily: MigrationChannelFamily;
  readonly consumerKind: MigrationConsumerKind;
  readonly functionName: MigrationFunction;
  readonly writerOwner: MigrationWriterOwner;
  readonly previousWriterOwner: MigrationWriterOwner | null;
  readonly phase: MigrationCohortPhase;
  readonly shadowReadEnabled: boolean;
  readonly shadowReadCandidateSnapshotHash: string | null;
  readonly legacyRouteVerified: boolean;
  readonly unresolvedExternalEffects: number;
  readonly driftReconciledSnapshotHash: string | null;
  readonly version: number;
}

export interface MigrationCohortScope {
  readonly cohortId: string;
  readonly tenantId: string;
  readonly channelFamily: MigrationChannelFamily;
  readonly consumerKind: MigrationConsumerKind;
}

export interface MigrationWriterRollbackResult {
  readonly assignments: readonly MigrationWriterAssignment[];
  readonly cutoverFunctions: readonly MigrationFunction[];
  readonly abortedBeforeCutoverFunctions: readonly MigrationFunction[];
  /** Credential references stay with the central owner when the prior route was legacy. */
  readonly credentialReferencesKeptCentral: boolean;
  readonly credentialAction: 'NONE';
  readonly grantAction: 'NONE';
  readonly providerEffectsReconciled: false;
}

export interface MigrationExecutionPolicy {
  readonly plan: LegacyImportPlan;
  readonly manifest: MigrationBatchManifest;
  readonly writerMatrix: readonly MigrationWriterAssignment[];
}
