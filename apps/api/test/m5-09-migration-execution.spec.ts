import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import type { LegacyImportApplyPort, LegacyImportApplyResult } from '../src/legacy-import/legacy-import.ports.js';
import { executeLegacyImportPlan } from '../src/legacy-import/legacy-import.runner.js';
import { createLegacyImportReferenceHasher, planLegacyImport } from '../src/legacy-import/legacy-import.planner.js';
import type {
  LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem, LegacyInventorySnapshot,
} from '../src/legacy-import/legacy-import.types.js';
import {
  createMigrationBatchManifest, createMigrationBatchManifestReport, detectMigrationSourceDrift,
  enableMigrationShadowRead, MigrationExecutionInputError, reconcileMigrationSourceDrift,
  rollbackMigrationCohort, runMigrationShadowRead, switchMigrationWriter, validateMigrationWriterMatrix,
} from '../src/migration-execution/migration-execution.policy.js';
import type {
  MigrationChannelFamily, MigrationCohortPhase, MigrationConsumerKind, MigrationFunction,
  MigrationSurfaceCounts, MigrationWriterAssignment, MigrationWriterOwner, ShadowReadPort,
} from '../src/migration-execution/migration-execution.types.js';

const hasher = createLegacyImportReferenceHasher(Buffer.from('m5.09-synthetic-only-hmac-key-not-for-runtime'));
const context = { allowedCatalogRefs: new Set(['synthetic-m5-09']), hasher };
const tenantId = '51111111-1111-4111-8111-111111111111';
const appConfigurationId = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function snapshot(sourceVersion: string): LegacyInventorySnapshot {
  return {
    catalogRef: 'synthetic-m5-09',
    environment: 'test',
    sourceVersion,
    tenantMappings: [{ tenantId, legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'synthetic-company', environment: 'test' }],
    appBindings: [{ tenantId, appConfigurationId, environment: 'test' }],
    pages: [
      {
        legacyRowId: 'synthetic-source-row-a', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'synthetic-company',
        sourceType: 'FACEBOOK', externalId: 'synthetic-external-asset-a', userCredentialPresent: true,
        pageCredentialPresent: false, userExpiresAt: 'Never', pageExpiresAt: null, parentChannelId: null,
      },
      {
        legacyRowId: 'synthetic-source-row-b', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'synthetic-company',
        sourceType: 'INSTAGRAM', externalId: 'synthetic-external-asset-b', userCredentialPresent: false,
        pageCredentialPresent: false, userExpiresAt: null, pageExpiresAt: null, parentChannelId: null,
      },
    ],
    numbers: [],
  };
}

function plan(sourceVersion = 'synthetic-watermark-v1'): LegacyImportPlan {
  return planLegacyImport(snapshot(sourceVersion), context);
}

const counts = (values: Partial<MigrationSurfaceCounts> = {}): MigrationSurfaceCounts => ({
  assets: 2,
  templates: 0,
  messageConfigurations: 1,
  relationships: 0,
  credentialReferences: 1,
  ...values,
});

function fingerprint(value: string): string {
  return hasher.digest(value);
}

test('M5.09 dry-run manifest contains provenance and aggregate counts only', () => {
  const source = plan();
  const manifest = createMigrationBatchManifest(source, 'synthetic-m5-09', counts());
  assert.equal(manifest.plannedRows, 2);
  assert.equal(manifest.candidateRows, 1);
  assert.equal(manifest.quarantinedRows, 1);
  assert.equal(manifest.credentialReauthRows, 1);
  const report = createMigrationBatchManifestReport(manifest, counts({ assets: 1 }));
  assert.deepEqual(report.countDeltas, {
    assets: -1, templates: 0, messageConfigurations: 0, relationships: 0, credentialReferences: 0,
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('synthetic-source-row'), false);
  assert.equal(serialized.includes('synthetic-external-asset'), false);
  assert.equal(serialized.includes('synthetic-company'), false);
  assert.equal(serialized.includes('credential'), true, 'only the aggregate field label is present');
  assert.throws(() => createMigrationBatchManifest(source, 'schema/host', counts()), MigrationExecutionInputError);
});

test('M5.09 checked-in fixture is synthetic, bounded, and emits explicit quarantine reasons', () => {
  const fixturePath = process.env.M5_09_FIXTURE_PATH
    ?? resolve(__dirname, '../../../../tools/m5-09/fixtures/synthetic-migration-inventory.json');
  const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const source = planLegacyImport(fixture, context);
  assert.equal(source.report.totalRows, 2);
  assert.equal(source.report.candidateCount, 1);
  assert.equal(source.report.quarantinedCount, 1);
  assert.ok(source.items.some((item) => item.reasonCode === 'UNSUPPORTED_SOURCE_KIND'));
  const report = createMigrationBatchManifest(source, 'synthetic-m5-09', counts());
  assert.equal(JSON.stringify(report).includes('synthetic-row-a'), false);
  assert.equal(JSON.stringify(report).includes('synthetic-external-a'), false);
});

test('M5.09 detects and reconciles concurrent source drift before cutover', () => {
  const drift = detectMigrationSourceDrift({
    snapshotHash: fingerprint('snapshot-before'),
    records: [
      { sourceRecordHash: fingerprint('identity-a'), sourcePayloadHash: fingerprint('payload-a') },
      { sourceRecordHash: fingerprint('identity-b'), sourcePayloadHash: fingerprint('payload-b') },
    ],
  }, {
    snapshotHash: fingerprint('snapshot-current'),
    records: [
      { sourceRecordHash: fingerprint('identity-a'), sourcePayloadHash: fingerprint('payload-a-changed') },
      { sourceRecordHash: fingerprint('identity-c'), sourcePayloadHash: fingerprint('payload-c') },
    ],
  });
  assert.deepEqual([drift.addedCount, drift.changedCount, drift.removedCount], [1, 1, 1]);
  const blocked = reconcileMigrationSourceDrift(drift, {
    currentSnapshotHash: drift.currentSnapshotHash,
    addedSourceRecordHashes: [], changedSourceRecordHashes: [], removedSourceRecordHashes: [],
  });
  assert.equal(blocked.readyForCutover, false);
  assert.equal(blocked.unresolvedCount, 3);
  const reconciled = reconcileMigrationSourceDrift(drift, {
    currentSnapshotHash: drift.currentSnapshotHash,
    addedSourceRecordHashes: drift.addedSourceRecordHashes,
    changedSourceRecordHashes: drift.changedSourceRecordHashes,
    removedSourceRecordHashes: drift.removedSourceRecordHashes,
  });
  assert.equal(reconciled.readyForCutover, true);
  assert.equal(reconciled.unresolvedCount, 0);
  assert.throws(() => reconcileMigrationSourceDrift(drift, {
    currentSnapshotHash: drift.currentSnapshotHash,
    addedSourceRecordHashes: [fingerprint('unrelated')], changedSourceRecordHashes: [], removedSourceRecordHashes: [],
  }), MigrationExecutionInputError);
  assert.throws(() => reconcileMigrationSourceDrift(drift, {
    currentSnapshotHash: fingerprint('stale-snapshot'),
    addedSourceRecordHashes: drift.addedSourceRecordHashes,
    changedSourceRecordHashes: drift.changedSourceRecordHashes,
    removedSourceRecordHashes: drift.removedSourceRecordHashes,
  }), MigrationExecutionInputError);
});

test('M5.09 shadow-read compares keyed metadata fingerprints through read-only ports', async () => {
  const ref = fingerprint('resource-a');
  const common = {
    resourceRefHash: ref,
    kind: 'MESSAGE_CONFIGURATION' as const,
    metadataHmac: fingerprint('metadata'),
    statusHmac: fingerprint('status'),
    configurationHmac: fingerprint('configuration-legacy'),
    relationshipHmac: fingerprint('relationship'),
  };
  const cohortScope = {
    cohortId: '52222222-2222-4222-8222-222222222222', tenantId,
    channelFamily: 'WHATSAPP_EXCLUSIVE' as const, consumerKind: 'PORTAL' as const,
  };
  let legacyReads = 0;
  let candidateReads = 0;
  const legacy: ShadowReadPort = { readSanitizedSnapshot: async () => {
    legacyReads += 1;
    return { sourceVersion: 'legacy-v1', snapshotHash: fingerprint('legacy-snapshot'), resources: [common] };
  } };
  const candidate: ShadowReadPort = { readSanitizedSnapshot: async () => {
    candidateReads += 1;
    return { sourceVersion: 'candidate-v1', snapshotHash: fingerprint('candidate-snapshot'),
      resources: [{ ...common, configurationHmac: fingerprint('configuration-new') }] };
  } };
  const report = await runMigrationShadowRead(legacy, candidate, cohortScope);
  assert.equal(report.readOnly, true);
  assert.deepEqual(report.scope, cohortScope);
  assert.equal(report.legacySnapshotHash, fingerprint('legacy-snapshot'));
  assert.equal(report.candidateSnapshotHash, fingerprint('candidate-snapshot'));
  assert.equal(report.comparedCount, 1);
  assert.equal(report.configurationMismatchCount, 1);
  assert.equal(report.matches, false);
  assert.equal(legacyReads, 1);
  assert.equal(candidateReads, 1);
  assert.equal(JSON.stringify(report).includes(common.configurationHmac), false);
  const unsafe: ShadowReadPort = { readSanitizedSnapshot: async () => ({
    sourceVersion: 'legacy-v1',
    snapshotHash: fingerprint('legacy-snapshot'),
    resources: [{ ...common, accessToken: 'synthetic-secret' } as unknown as typeof common],
  }) };
  await assert.rejects(runMigrationShadowRead(unsafe, candidate, cohortScope), MigrationExecutionInputError);
});

function writerMatrix(input: {
  readonly owner?: MigrationWriterOwner;
  readonly legacyRouteVerified?: boolean;
  readonly unresolvedExternalEffects?: number;
  readonly phase?: MigrationCohortPhase;
  readonly channelFamily?: MigrationChannelFamily;
  readonly consumerKind?: MigrationConsumerKind;
} = {}): MigrationWriterAssignment[] {
  const definitions: Array<[MigrationFunction, MigrationWriterOwner]> = [
    ['CONFIGURATION', input.owner ?? 'LEGACY'],
    ['CREDENTIAL_REFERENCE', input.owner ?? 'LEGACY'],
    ['LEGACY_PROJECTION', input.owner ?? 'LEGACY'],
    ['OPERATION_RELAY', input.owner ?? 'LEGACY'],
  ];
  return definitions.map(([functionName, writerOwner]) => ({
    cohortId: '52222222-2222-4222-8222-222222222222', tenantId,
    channelFamily: input.channelFamily ?? 'WHATSAPP_EXCLUSIVE',
    consumerKind: input.consumerKind ?? 'PORTAL',
    functionName, writerOwner, previousWriterOwner: null,
    phase: input.phase ?? 'PREPARED', shadowReadEnabled: false,
    shadowReadCandidateSnapshotHash: null,
    legacyRouteVerified: input.legacyRouteVerified ?? true,
    unresolvedExternalEffects: input.unresolvedExternalEffects ?? 0,
    driftReconciledSnapshotHash: null,
    version: 1,
  }));
}

test('M5.09 writer cutover requires current matched shadow evidence and partial rollback is safe', async () => {
  const initial = writerMatrix();
  assert.equal(validateMigrationWriterMatrix(initial).length, 4);
  assert.throws(() => validateMigrationWriterMatrix([...initial, initial[0]!]), MigrationExecutionInputError);
  const shadow = enableMigrationShadowRead(initial);
  assert.ok(shadow.every((entry) => entry.shadowReadEnabled && entry.writerOwner === 'LEGACY' && entry.phase === 'SHADOW_READ'));
  const emptyDrift = detectMigrationSourceDrift({ snapshotHash: fingerprint('empty-before'), records: [] },
    { snapshotHash: fingerprint('empty-current'), records: [] });
  const readyForCutover = reconcileMigrationSourceDrift(emptyDrift, {
    currentSnapshotHash: emptyDrift.currentSnapshotHash,
    addedSourceRecordHashes: [], changedSourceRecordHashes: [], removedSourceRecordHashes: [],
  });
  const credentialEntry = shadow.find((entry) => entry.functionName === 'CREDENTIAL_REFERENCE')!;
  const reportScope = {
    cohortId: credentialEntry.cohortId, tenantId: credentialEntry.tenantId,
    channelFamily: credentialEntry.channelFamily, consumerKind: credentialEntry.consumerKind,
  };
  const resource = {
    resourceRefHash: fingerprint('shadow-resource'), kind: 'ASSET' as const,
    metadataHmac: fingerprint('metadata'), statusHmac: fingerprint('status'),
    configurationHmac: fingerprint('configuration'), relationshipHmac: fingerprint('relationship'),
  };
  let currentCandidateHash = fingerprint('candidate-current');
  let currentCandidateVersion = 'candidate-current-v1';
  const candidatePort: ShadowReadPort = { readSanitizedSnapshot: async () => ({
    sourceVersion: currentCandidateVersion, snapshotHash: currentCandidateHash, resources: [resource],
  }) };
  await assert.rejects(switchMigrationWriter(credentialEntry, credentialEntry.version, 'CENTRAL', readyForCutover,
    undefined, candidatePort),
    MigrationExecutionInputError, 'a current shadow-read report is required');

  const legacyPort: ShadowReadPort = { readSanitizedSnapshot: async () => ({
    sourceVersion: 'legacy-current-v1', snapshotHash: emptyDrift.currentSnapshotHash, resources: [resource],
  }) };
  const matchedReport = await runMigrationShadowRead(legacyPort, candidatePort, reportScope);
  assert.equal(matchedReport.matches, true);
  const mismatchedReport = await runMigrationShadowRead(legacyPort, {
    readSanitizedSnapshot: async () => ({
      sourceVersion: 'candidate-current-v1', snapshotHash: fingerprint('candidate-mismatch'),
      resources: [{ ...resource, configurationHmac: fingerprint('different-configuration') }],
    }),
  }, reportScope);
  assert.equal(mismatchedReport.matches, false);
  await assert.rejects(switchMigrationWriter(credentialEntry, credentialEntry.version, 'CENTRAL',
    readyForCutover, mismatchedReport, candidatePort), MigrationExecutionInputError,
  'a mismatched shadow-read report blocks cutover');

  currentCandidateHash = fingerprint('candidate-updated-after-shadow-read');
  currentCandidateVersion = 'candidate-current-v2';
  await assert.rejects(switchMigrationWriter(credentialEntry, credentialEntry.version, 'CENTRAL',
    readyForCutover, matchedReport, candidatePort), MigrationExecutionInputError,
  'a previously matched report is rejected when the current candidate snapshot changed');
  currentCandidateHash = fingerprint('candidate-current');
  currentCandidateVersion = 'candidate-current-v1';

  const switchedCredential = await switchMigrationWriter(credentialEntry, credentialEntry.version, 'CENTRAL',
    readyForCutover, matchedReport, candidatePort);
  assert.equal(switchedCredential.driftReconciledSnapshotHash, emptyDrift.currentSnapshotHash);
  assert.equal(switchedCredential.shadowReadCandidateSnapshotHash, matchedReport.candidateSnapshotHash);
  const partial = shadow.map((entry) => entry.functionName === 'CREDENTIAL_REFERENCE' ? switchedCredential : entry);
  assert.equal(partial.filter((entry) => entry.phase === 'CUTOVER').length, 1);
  assert.equal(partial.filter((entry) => entry.phase === 'SHADOW_READ').length, 3);
  const revokedBefore = Object.freeze({ credential: 'REVOKED', grant: 'REVOKED' });
  const rolledBack = rollbackMigrationCohort(partial, Object.fromEntries(partial.map((entry) => [entry.functionName, entry.version])));
  assert.ok(rolledBack.assignments.every((entry) => entry.phase === 'ROLLED_BACK'));
  assert.ok(rolledBack.assignments.filter((entry) => entry.functionName !== 'CREDENTIAL_REFERENCE')
    .every((entry) => entry.writerOwner === 'LEGACY'));
  assert.equal(rolledBack.assignments.find((entry) => entry.functionName === 'CREDENTIAL_REFERENCE')?.writerOwner, 'CENTRAL');
  assert.equal(rolledBack.credentialReferencesKeptCentral, true);
  assert.deepEqual(rolledBack.cutoverFunctions, ['CREDENTIAL_REFERENCE']);
  assert.deepEqual([...rolledBack.abortedBeforeCutoverFunctions].sort(), ['CONFIGURATION', 'LEGACY_PROJECTION', 'OPERATION_RELAY']);
  assert.equal(rolledBack.credentialAction, 'NONE');
  assert.equal(rolledBack.grantAction, 'NONE');
  assert.equal(rolledBack.providerEffectsReconciled, false);
  assert.deepEqual(revokedBefore, { credential: 'REVOKED', grant: 'REVOKED' });
  const notReady = partial.map((entry) => entry.functionName === 'CONFIGURATION'
    ? { ...entry, legacyRouteVerified: false } : entry);
  assert.throws(() => rollbackMigrationCohort(notReady,
    Object.fromEntries(notReady.map((entry) => [entry.functionName, entry.version]))), MigrationExecutionInputError);
  const unresolved = partial.map((entry) => entry.functionName === 'OPERATION_RELAY'
    ? { ...entry, unresolvedExternalEffects: 1 } : entry);
  assert.throws(() => rollbackMigrationCohort(unresolved,
    Object.fromEntries(unresolved.map((entry) => [entry.functionName, entry.version]))), MigrationExecutionInputError);
});

class MemoryApplyLedger implements LegacyImportApplyPort {
  checkpoint?: LegacyImportBatchCheckpoint;
  readonly claims = new Set<string>();
  readonly quarantineReasons = new Map<string, string>();
  applyCount = 0;

  async beginOrResume(candidate: LegacyImportPlan): Promise<LegacyImportBatchCheckpoint> {
    this.checkpoint ??= {
      batchId: candidate.batchId, sourceSnapshotHash: candidate.report.sourceSnapshotHash,
      sourceVersion: candidate.sourceVersion, projectionVersion: candidate.projectionVersion,
      lastCompletedSequence: 0, state: 'PLANNED',
    };
    return { ...this.checkpoint };
  }

  async applyMetadataCandidateAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem): Promise<LegacyImportApplyResult> {
    assert.equal(item.sequence, checkpoint.lastCompletedSequence + 1);
    const replay = this.claims.has(item.sourceRecordHash);
    if (!replay) this.claims.add(item.sourceRecordHash);
    this.applyCount += 1;
    this.checkpoint = { ...checkpoint, lastCompletedSequence: item.sequence, state: 'APPLYING' };
    return { checkpoint: { ...this.checkpoint }, disposition: replay ? 'REPLAYED' : 'APPLIED_METADATA_ONLY' };
  }

  async recordQuarantineAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem): Promise<LegacyImportBatchCheckpoint> {
    assert.equal(item.sequence, checkpoint.lastCompletedSequence + 1);
    assert.equal(item.state, 'QUARANTINED');
    this.quarantineReasons.set(item.sourceRecordHash, item.reasonCode ?? 'UNKNOWN_SOURCE_SCHEMA');
    this.checkpoint = { ...checkpoint, lastCompletedSequence: item.sequence, state: 'APPLYING' };
    return { ...this.checkpoint };
  }

  async rollbackMetadataCandidateAndCheckpoint(
    checkpoint: LegacyImportBatchCheckpoint,
    _item: LegacyImportPlanItem,
    _expectedImportedAssetVersion: number,
  ): Promise<LegacyImportBatchCheckpoint> {
    this.checkpoint = { ...checkpoint };
    return { ...checkpoint };
  }

  async complete(checkpoint: LegacyImportBatchCheckpoint): Promise<LegacyImportBatchCheckpoint> {
    this.checkpoint = { ...checkpoint, state: 'COMPLETED' };
    return { ...this.checkpoint };
  }
}

test('M5.09 repeated batch is idempotent and resumes from its durable checkpoint', async () => {
  const candidate = plan();
  const ledger = new MemoryApplyLedger();
  let interrupted = false;
  const crashAfterCommit: LegacyImportApplyPort = {
    beginOrResume: (value) => ledger.beginOrResume(value),
    applyMetadataCandidateAndCheckpoint: async (checkpoint, item): Promise<LegacyImportApplyResult> => {
      const committed = await ledger.applyMetadataCandidateAndCheckpoint(checkpoint, item);
      if (!interrupted) {
        interrupted = true;
        throw new Error('synthetic interruption after checkpoint commit');
      }
      return committed;
    },
    recordQuarantineAndCheckpoint: (checkpoint, item) => ledger.recordQuarantineAndCheckpoint(checkpoint, item),
    rollbackMetadataCandidateAndCheckpoint: (checkpoint, item, version) => ledger.rollbackMetadataCandidateAndCheckpoint(checkpoint, item, version),
    complete: (checkpoint) => ledger.complete(checkpoint),
  };
  await assert.rejects(executeLegacyImportPlan(candidate, crashAfterCommit), /synthetic interruption/);
  assert.equal(ledger.checkpoint?.lastCompletedSequence, 1);
  const resumed = await executeLegacyImportPlan(candidate, ledger);
  assert.equal(resumed.state, 'COMPLETED');
  assert.equal(resumed.lastCompletedSequence, 2);
  assert.equal(ledger.applyCount, 1);
  assert.equal(ledger.quarantineReasons.size, 1);
  assert.ok([...ledger.quarantineReasons.values()].includes('UNSUPPORTED_SOURCE_KIND'));
  const replay = await executeLegacyImportPlan(candidate, ledger);
  assert.equal(replay.state, 'COMPLETED');
  assert.equal(ledger.applyCount, 1);
  assert.equal(ledger.claims.size, 1);
});
