import type { LegacyImportPlan } from '../legacy-import/legacy-import.types.js';
import {
  MIGRATION_COUNT_KEYS,
  type MigrationBatchManifest,
  type MigrationBatchManifestReport,
  type MigrationChannelFamily,
  type MigrationCohortScope,
  type MigrationCohortPhase,
  type MigrationConsumerKind,
  type MigrationCountKey,
  type MigrationDriftEvidence,
  type MigrationDriftReconciliation,
  type MigrationDriftSnapshot,
  type MigrationFunction,
  type MigrationSurfaceCounts,
  type MigrationWriterAssignment,
  type MigrationWriterOwner,
  type MigrationWriterRollbackResult,
  type ShadowReadFingerprint,
  type ShadowReadPort,
  type ShadowReadReport,
  type ShadowReadSnapshot,
} from './migration-execution.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const CATALOG_REF = /^[a-z][a-z0-9_-]{0,63}$/;
const REQUIRED_FUNCTIONS: readonly MigrationFunction[] = [
  'CONFIGURATION', 'CREDENTIAL_REFERENCE', 'LEGACY_PROJECTION', 'OPERATION_RELAY',
];
const CHANNELS: readonly MigrationChannelFamily[] = [
  'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE', 'FACEBOOK', 'INSTAGRAM',
];
const CONSUMERS: readonly MigrationConsumerKind[] = [
  'PORTAL', 'LEGACY_PHP', 'INTERNAL_WORKER', 'WEBHOOK_INGRESS', 'OTHER_INTERNAL',
];
const FUNCTIONS: readonly MigrationFunction[] = [...REQUIRED_FUNCTIONS, 'WEBHOOK_DISPATCH'];
const OWNERS: readonly MigrationWriterOwner[] = ['LEGACY', 'CENTRAL', 'PROJECTOR', 'RELAY', 'NEW'];
const PHASES: readonly MigrationCohortPhase[] = ['PREPARED', 'SHADOW_READ', 'CUTOVER', 'PAUSED', 'ROLLED_BACK'];

export class MigrationExecutionInputError extends Error {
  constructor(message = 'Migration execution metadata is invalid or outside the sanitized contract.') {
    super(message);
    this.name = 'MigrationExecutionInputError';
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new MigrationExecutionInputError();
  }
}

function assertDigest(value: string): void {
  if (!DIGEST.test(value)) throw new MigrationExecutionInputError();
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new MigrationExecutionInputError();
}

function validateCounts(value: MigrationSurfaceCounts): void {
  for (const key of MIGRATION_COUNT_KEYS) assertCount(value[key]);
}

function validateManifest(manifest: MigrationBatchManifest): void {
  if (!UUID.test(manifest.batchId) || !DIGEST.test(manifest.sourceSnapshotHash) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(manifest.sourceVersion) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(manifest.projectionVersion) ||
      !CATALOG_REF.test(manifest.catalogRef)) throw new MigrationExecutionInputError();
  for (const value of [manifest.plannedRows, manifest.candidateRows, manifest.quarantinedRows, manifest.credentialReauthRows]) {
    assertCount(value);
  }
  if (manifest.candidateRows + manifest.quarantinedRows !== manifest.plannedRows ||
      manifest.candidateRows + manifest.quarantinedRows > Number.MAX_SAFE_INTEGER) {
    throw new MigrationExecutionInputError('Manifest outcome counts are inconsistent.');
  }
  validateCounts(manifest.beforeCounts);
}

export function createMigrationBatchManifest(
  plan: LegacyImportPlan,
  catalogRef: string,
  beforeCounts: MigrationSurfaceCounts,
): MigrationBatchManifest {
  if (!UUID.test(plan.batchId) || !DIGEST.test(plan.report.sourceSnapshotHash) ||
      !CATALOG_REF.test(catalogRef) || plan.report.mode !== 'DRY_RUN' ||
      plan.report.sourceVersion !== plan.sourceVersion || plan.report.projectionVersion !== plan.projectionVersion ||
      plan.items.length !== plan.report.totalRows) throw new MigrationExecutionInputError();
  const manifest: MigrationBatchManifest = {
    batchId: plan.batchId,
    sourceSnapshotHash: plan.report.sourceSnapshotHash,
    sourceVersion: plan.sourceVersion,
    projectionVersion: plan.projectionVersion,
    catalogRef,
    plannedRows: plan.report.totalRows,
    candidateRows: plan.report.candidateCount,
    quarantinedRows: plan.report.quarantinedCount,
    credentialReauthRows: plan.report.credentialReauthCount,
    beforeCounts: { ...beforeCounts },
  };
  validateManifest(manifest);
  return manifest;
}

export function createMigrationBatchManifestReport(
  manifest: MigrationBatchManifest,
  afterCounts: MigrationSurfaceCounts | null,
): MigrationBatchManifestReport {
  validateManifest(manifest);
  if (afterCounts !== null) validateCounts(afterCounts);
  const countDeltas = afterCounts === null ? null : Object.fromEntries(MIGRATION_COUNT_KEYS.map((key: MigrationCountKey) => [
    key, afterCounts[key] - manifest.beforeCounts[key],
  ])) as MigrationSurfaceCounts;
  return {
    ...manifest,
    beforeCounts: { ...manifest.beforeCounts },
    mode: 'DRY_RUN',
    afterCounts: afterCounts === null ? null : { ...afterCounts },
    countDeltas,
  };
}

function sourceMap(records: readonly { sourceRecordHash: string; sourcePayloadHash: string }[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of records) {
    assertDigest(record.sourceRecordHash);
    assertDigest(record.sourcePayloadHash);
    if (result.has(record.sourceRecordHash)) throw new MigrationExecutionInputError('Source fingerprint set contains an ambiguous identity.');
    result.set(record.sourceRecordHash, record.sourcePayloadHash);
  }
  return result;
}

export function detectMigrationSourceDrift(
  baseline: MigrationDriftSnapshot,
  current: MigrationDriftSnapshot,
): MigrationDriftEvidence {
  assertDigest(baseline.snapshotHash);
  assertDigest(current.snapshotHash);
  if (baseline.snapshotHash === current.snapshotHash) {
    const baselineMap = sourceMap(baseline.records);
    const currentMap = sourceMap(current.records);
    if (baselineMap.size !== currentMap.size || [...baselineMap].some(([key, value]) => currentMap.get(key) !== value)) {
      throw new MigrationExecutionInputError('Equal source snapshot hashes cannot describe different fingerprints.');
    }
  }
  const before = sourceMap(baseline.records);
  const after = sourceMap(current.records);
  const addedSourceRecordHashes: string[] = [];
  const changedSourceRecordHashes: string[] = [];
  const removedSourceRecordHashes: string[] = [];
  for (const [identity, payload] of after) {
    const previous = before.get(identity);
    if (previous === undefined) addedSourceRecordHashes.push(identity);
    else if (previous !== payload) changedSourceRecordHashes.push(identity);
  }
  for (const identity of before.keys()) if (!after.has(identity)) removedSourceRecordHashes.push(identity);
  return {
    baselineSnapshotHash: baseline.snapshotHash,
    currentSnapshotHash: current.snapshotHash,
    addedSourceRecordHashes: addedSourceRecordHashes.sort(),
    changedSourceRecordHashes: changedSourceRecordHashes.sort(),
    removedSourceRecordHashes: removedSourceRecordHashes.sort(),
    addedCount: addedSourceRecordHashes.length,
    changedCount: changedSourceRecordHashes.length,
    removedCount: removedSourceRecordHashes.length,
  };
}

export function reconcileMigrationSourceDrift(
  drift: MigrationDriftEvidence,
  reconciled: {
    readonly currentSnapshotHash: string;
    readonly addedSourceRecordHashes: readonly string[];
    readonly changedSourceRecordHashes: readonly string[];
    readonly removedSourceRecordHashes: readonly string[];
  },
): MigrationDriftReconciliation {
  assertDigest(drift.baselineSnapshotHash);
  assertDigest(drift.currentSnapshotHash);
  assertDigest(reconciled.currentSnapshotHash);
  if (reconciled.currentSnapshotHash !== drift.currentSnapshotHash) {
    throw new MigrationExecutionInputError('Drift reconciliation must reference the current source snapshot.');
  }
  for (const [hashes, count] of [
    [drift.addedSourceRecordHashes, drift.addedCount],
    [drift.changedSourceRecordHashes, drift.changedCount],
    [drift.removedSourceRecordHashes, drift.removedCount],
  ] as const) {
    if (hashes.length !== count || new Set(hashes).size !== hashes.length) {
      throw new MigrationExecutionInputError('Source drift evidence is malformed.');
    }
    for (const hash of hashes) assertDigest(hash);
  }
  const resolved = [
    [drift.addedSourceRecordHashes, reconciled.addedSourceRecordHashes],
    [drift.changedSourceRecordHashes, reconciled.changedSourceRecordHashes],
    [drift.removedSourceRecordHashes, reconciled.removedSourceRecordHashes],
  ] as const;
  let unresolvedCount = 0;
  for (const [required, supplied] of resolved) {
    const actual = new Set(supplied);
    for (const hash of actual) assertDigest(hash);
    if (actual.size !== supplied.length || [...actual].some((hash) => !required.includes(hash))) {
      throw new MigrationExecutionInputError('Drift reconciliation evidence does not match the current source delta.');
    }
    unresolvedCount += required.filter((hash) => !actual.has(hash)).length;
  }
  return {
    baselineSnapshotHash: drift.baselineSnapshotHash,
    currentSnapshotHash: drift.currentSnapshotHash,
    addedCount: drift.addedCount,
    changedCount: drift.changedCount,
    removedCount: drift.removedCount,
    unresolvedCount,
    readyForCutover: unresolvedCount === 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFingerprint(value: unknown): ShadowReadFingerprint {
  if (!isRecord(value)) throw new MigrationExecutionInputError('Shadow-read adapter returned an invalid sanitized record.');
  exactKeys(value, ['resourceRefHash', 'kind', 'metadataHmac', 'statusHmac', 'configurationHmac', 'relationshipHmac']);
  if (typeof value.resourceRefHash !== 'string' || !DIGEST.test(value.resourceRefHash) ||
      typeof value.kind !== 'string' || !['ASSET', 'TEMPLATE', 'MESSAGE_CONFIGURATION', 'RELATIONSHIP'].includes(value.kind)) {
    throw new MigrationExecutionInputError('Shadow-read adapter returned an invalid sanitized record.');
  }
  for (const key of ['metadataHmac', 'statusHmac', 'configurationHmac', 'relationshipHmac']) {
    if (typeof value[key] !== 'string' || !DIGEST.test(value[key])) {
      throw new MigrationExecutionInputError('Shadow-read adapter returned an invalid sanitized record.');
    }
  }
  return value as unknown as ShadowReadFingerprint;
}

function parseShadowSnapshot(value: unknown): ShadowReadSnapshot {
  if (!isRecord(value)) throw new MigrationExecutionInputError('Shadow-read adapter returned an invalid snapshot.');
  exactKeys(value, ['sourceVersion', 'snapshotHash', 'resources']);
  if (typeof value.sourceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.sourceVersion) ||
      typeof value.snapshotHash !== 'string' || !DIGEST.test(value.snapshotHash) || !Array.isArray(value.resources)) {
    throw new MigrationExecutionInputError('Shadow-read adapter returned an invalid snapshot.');
  }
  const resources = value.resources.map(parseFingerprint);
  if (new Set(resources.map((row) => row.resourceRefHash)).size !== resources.length) {
    throw new MigrationExecutionInputError('Shadow-read adapter returned ambiguous resource fingerprints.');
  }
  return { sourceVersion: value.sourceVersion, snapshotHash: value.snapshotHash, resources };
}

function assertCohortScope(scope: MigrationCohortScope): void {
  if (!UUID.test(scope.cohortId) || !UUID.test(scope.tenantId) ||
      !CHANNELS.includes(scope.channelFamily) || !CONSUMERS.includes(scope.consumerKind)) {
    throw new MigrationExecutionInputError('Shadow-read cohort scope is invalid.');
  }
}

export async function runMigrationShadowRead(
  legacy: ShadowReadPort,
  candidate: ShadowReadPort,
  scope: MigrationCohortScope,
): Promise<ShadowReadReport> {
  assertCohortScope(scope);
  const [legacySnapshotValue, candidateSnapshotValue] = await Promise.all([
    legacy.readSanitizedSnapshot(scope), candidate.readSanitizedSnapshot(scope),
  ]);
  const legacySnapshot = parseShadowSnapshot(legacySnapshotValue);
  const candidateSnapshot = parseShadowSnapshot(candidateSnapshotValue);
  const oldRows = new Map(legacySnapshot.resources.map((row) => [row.resourceRefHash, row]));
  const newRows = new Map(candidateSnapshot.resources.map((row) => [row.resourceRefHash, row]));
  let metadataMismatchCount = 0;
  let statusMismatchCount = 0;
  let configurationMismatchCount = 0;
  let relationshipMismatchCount = 0;
  for (const [ref, oldRow] of oldRows) {
    const newRow = newRows.get(ref);
    if (!newRow) continue;
    if (oldRow.kind !== newRow.kind || oldRow.metadataHmac !== newRow.metadataHmac) metadataMismatchCount += 1;
    if (oldRow.statusHmac !== newRow.statusHmac) statusMismatchCount += 1;
    if (oldRow.configurationHmac !== newRow.configurationHmac) configurationMismatchCount += 1;
    if (oldRow.relationshipHmac !== newRow.relationshipHmac) relationshipMismatchCount += 1;
  }
  const missingCount = [...oldRows.keys()].filter((key) => !newRows.has(key)).length;
  const addedCount = [...newRows.keys()].filter((key) => !oldRows.has(key)).length;
  const comparedCount = [...oldRows.keys()].filter((key) => newRows.has(key)).length;
  return {
    mode: 'SHADOW_READ', readOnly: true,
    scope: { ...scope },
    legacyVersion: legacySnapshot.sourceVersion, candidateVersion: candidateSnapshot.sourceVersion,
    legacySnapshotHash: legacySnapshot.snapshotHash, candidateSnapshotHash: candidateSnapshot.snapshotHash,
    comparedCount, missingCount, addedCount, metadataMismatchCount, statusMismatchCount,
    configurationMismatchCount, relationshipMismatchCount,
    matches: missingCount === 0 && addedCount === 0 && metadataMismatchCount === 0 && statusMismatchCount === 0 &&
      configurationMismatchCount === 0 && relationshipMismatchCount === 0,
  };
}

function allowedOwners(functionName: MigrationFunction): readonly MigrationWriterOwner[] {
  switch (functionName) {
    case 'CONFIGURATION':
    case 'CREDENTIAL_REFERENCE':
      return ['LEGACY', 'CENTRAL'];
    case 'LEGACY_PROJECTION':
      return ['LEGACY', 'PROJECTOR'];
    case 'OPERATION_RELAY':
      return ['LEGACY', 'RELAY'];
    case 'WEBHOOK_DISPATCH':
      return ['LEGACY', 'NEW'];
  }
}

function assertWriterAssignment(entry: MigrationWriterAssignment): void {
  if (!UUID.test(entry.cohortId) || !UUID.test(entry.tenantId) ||
      !CHANNELS.includes(entry.channelFamily) || !CONSUMERS.includes(entry.consumerKind) ||
      !FUNCTIONS.includes(entry.functionName) || !OWNERS.includes(entry.writerOwner) ||
      (entry.previousWriterOwner !== null && !OWNERS.includes(entry.previousWriterOwner)) ||
      !PHASES.includes(entry.phase) || typeof entry.shadowReadEnabled !== 'boolean' ||
      typeof entry.legacyRouteVerified !== 'boolean' || !Number.isSafeInteger(entry.unresolvedExternalEffects) ||
      entry.unresolvedExternalEffects < 0 ||
      (entry.driftReconciledSnapshotHash !== null && !DIGEST.test(entry.driftReconciledSnapshotHash)) ||
      (entry.shadowReadCandidateSnapshotHash !== null && !DIGEST.test(entry.shadowReadCandidateSnapshotHash)) ||
      !Number.isSafeInteger(entry.version) || entry.version < 1 ||
      !allowedOwners(entry.functionName).includes(entry.writerOwner)) {
    throw new MigrationExecutionInputError('Writer assignment violates the cohort matrix contract.');
  }
  if ((entry.phase === 'PREPARED' &&
        (entry.writerOwner !== 'LEGACY' || entry.previousWriterOwner !== null || entry.shadowReadEnabled ||
          entry.driftReconciledSnapshotHash !== null || entry.shadowReadCandidateSnapshotHash !== null)) ||
      (entry.phase === 'SHADOW_READ' &&
        (entry.writerOwner !== 'LEGACY' || entry.previousWriterOwner !== null || !entry.shadowReadEnabled ||
          entry.driftReconciledSnapshotHash !== null || entry.shadowReadCandidateSnapshotHash !== null)) ||
      (entry.phase === 'CUTOVER' &&
        (entry.writerOwner === 'LEGACY' || entry.previousWriterOwner === null || !entry.shadowReadEnabled ||
          entry.driftReconciledSnapshotHash === null || entry.shadowReadCandidateSnapshotHash === null)) ||
      (entry.phase === 'ROLLED_BACK' &&
        (entry.previousWriterOwner !== null || entry.shadowReadEnabled))) {
    throw new MigrationExecutionInputError('Writer phase and owner state are inconsistent.');
  }
}

export function validateMigrationWriterMatrix(entries: readonly MigrationWriterAssignment[]): readonly MigrationWriterAssignment[] {
  if (entries.length !== REQUIRED_FUNCTIONS.length && entries.length !== FUNCTIONS.length) {
    throw new MigrationExecutionInputError('Writer matrix must define every required migration function exactly once.');
  }
  const first = entries[0];
  if (!first) throw new MigrationExecutionInputError('Writer matrix is empty.');
  const names = new Set<MigrationFunction>();
  for (const entry of entries) {
    assertWriterAssignment(entry);
    if (entry.cohortId !== first.cohortId || entry.tenantId !== first.tenantId ||
        entry.channelFamily !== first.channelFamily || entry.consumerKind !== first.consumerKind || names.has(entry.functionName)) {
      throw new MigrationExecutionInputError('Writer matrix contains conflicting cohort ownership.');
    }
    names.add(entry.functionName);
  }
  for (const name of REQUIRED_FUNCTIONS) if (!names.has(name)) {
    throw new MigrationExecutionInputError('Writer matrix omits a required migration function.');
  }
  return entries.map((entry) => ({ ...entry }));
}

export function enableMigrationShadowRead(entries: readonly MigrationWriterAssignment[]): readonly MigrationWriterAssignment[] {
  return validateMigrationWriterMatrix(entries).map((entry) => {
    if (entry.phase === 'ROLLED_BACK') throw new MigrationExecutionInputError('A rolled-back cohort cannot enter shadow-read.');
    return {
      ...entry,
      phase: entry.phase === 'PREPARED' ? 'SHADOW_READ' : entry.phase,
      shadowReadEnabled: true,
      version: entry.version + 1,
    };
  });
}

export function switchMigrationWriter(
  entry: MigrationWriterAssignment,
  expectedVersion: number,
  nextOwner: MigrationWriterOwner,
  driftReconciliation: MigrationDriftReconciliation,
  shadowReadReport: ShadowReadReport | undefined,
): MigrationWriterAssignment {
  assertWriterAssignment(entry);
  if (!driftReconciliation || entry.version !== expectedVersion || entry.phase !== 'SHADOW_READ' ||
      !entry.shadowReadEnabled || nextOwner === 'LEGACY' ||
      !allowedOwners(entry.functionName).includes(nextOwner) || nextOwner === entry.writerOwner ||
      !driftReconciliation.readyForCutover || driftReconciliation.unresolvedCount !== 0 ||
      !DIGEST.test(driftReconciliation.baselineSnapshotHash) || !DIGEST.test(driftReconciliation.currentSnapshotHash) ||
      !shadowReadReport || shadowReadReport.mode !== 'SHADOW_READ' || shadowReadReport.readOnly !== true ||
      shadowReadReport.matches !== true || !shadowReadReport.scope ||
      !DIGEST.test(shadowReadReport.legacySnapshotHash) ||
      !DIGEST.test(shadowReadReport.candidateSnapshotHash) ||
      shadowReadReport.legacySnapshotHash !== driftReconciliation.currentSnapshotHash ||
      shadowReadReport.scope.cohortId !== entry.cohortId || shadowReadReport.scope.tenantId !== entry.tenantId ||
      shadowReadReport.scope.channelFamily !== entry.channelFamily || shadowReadReport.scope.consumerKind !== entry.consumerKind) {
    throw new MigrationExecutionInputError('Writer change is stale or outside the allowed phase transition.');
  }
  return {
    ...entry,
    previousWriterOwner: entry.writerOwner,
    writerOwner: nextOwner,
    phase: 'CUTOVER',
    driftReconciledSnapshotHash: driftReconciliation.currentSnapshotHash,
    shadowReadCandidateSnapshotHash: shadowReadReport.candidateSnapshotHash,
    version: entry.version + 1,
  };
}

export function rollbackMigrationCohort(
  entries: readonly MigrationWriterAssignment[],
  expectedVersions: Readonly<Partial<Record<MigrationFunction, number>>>,
): MigrationWriterRollbackResult {
  const matrix = validateMigrationWriterMatrix(entries);
  let credentialReferencesKeptCentral = false;
  const cutoverFunctions: MigrationFunction[] = [];
  const abortedBeforeCutoverFunctions: MigrationFunction[] = [];
  const assignments = matrix.map((entry) => {
    if (entry.version !== expectedVersions[entry.functionName] || !entry.legacyRouteVerified ||
        entry.unresolvedExternalEffects !== 0) {
      throw new MigrationExecutionInputError('Cohort rollback requires current route evidence and reconciled external outcomes.');
    }
    const switched = entry.phase === 'CUTOVER';
    const notSwitched = entry.phase === 'PREPARED' || entry.phase === 'SHADOW_READ';
    if ((!switched && !notSwitched) ||
        (switched && (entry.previousWriterOwner === null || entry.writerOwner === 'LEGACY')) ||
        (notSwitched && (entry.previousWriterOwner !== null || entry.writerOwner !== 'LEGACY'))) {
      throw new MigrationExecutionInputError('Cohort rollback found an unknown or inconsistent partial transition.');
    }
    (switched ? cutoverFunctions : abortedBeforeCutoverFunctions).push(entry.functionName);
    // Returning credential lookup to a legacy path could make an old/revoked
    // credential usable again. Keep that function central while rolling back
    // the other cohort writers; no credential or grant mutation is performed.
    let writerOwner = switched ? entry.previousWriterOwner! : entry.writerOwner;
    if (switched && entry.functionName === 'CREDENTIAL_REFERENCE' && entry.previousWriterOwner === 'LEGACY') {
      credentialReferencesKeptCentral = true;
      writerOwner = entry.writerOwner;
    }
    return {
      ...entry,
      writerOwner,
      previousWriterOwner: null,
      phase: 'ROLLED_BACK' as const,
      shadowReadEnabled: false,
      version: entry.version + 1,
    };
  });
  return {
    assignments,
    cutoverFunctions,
    abortedBeforeCutoverFunctions,
    credentialReferencesKeptCentral,
    credentialAction: 'NONE',
    grantAction: 'NONE',
    providerEffectsReconciled: false,
  };
}
