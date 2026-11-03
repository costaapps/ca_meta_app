import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLegacyImportReferenceHasher, credentialImportFenceMatches, parseLegacyInventorySnapshot,
  planLegacyImport, LegacyImportInputError } from '../src/legacy-import/legacy-import.planner.js';
import type { LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem, LegacyInventorySnapshot } from '../src/legacy-import/legacy-import.types.js';
import type { LegacyImportApplyPort, LegacyImportApplyResult } from '../src/legacy-import/legacy-import.ports.js';
import { executeLegacyImportPlan } from '../src/legacy-import/legacy-import.runner.js';
import { parseLegacyImportCliArguments } from '../src/legacy-import/legacy-import.cli.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const APP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context = {
  allowedCatalogRefs: new Set(['synthetic-m3-11']),
  hasher: createLegacyImportReferenceHasher(Buffer.from('m3.11-synthetic-test-key-not-for-production')),
};

class SyntheticImportTargetAndLedger implements LegacyImportApplyPort {
  private checkpoint: LegacyImportBatchCheckpoint | undefined;
  private failAfterFirstCommit = false;
  readonly assetRefs = new Set<string>();
  readonly completedItems = new Set<string>();

  interruptAfterFirstCommit(): void { this.failAfterFirstCommit = true; }

  async beginOrResume(plan: LegacyImportPlan): Promise<LegacyImportBatchCheckpoint> {
    this.checkpoint ??= {
      batchId: plan.batchId,
      sourceSnapshotHash: plan.report.sourceSnapshotHash,
      sourceVersion: plan.sourceVersion,
      projectionVersion: plan.projectionVersion,
      lastCompletedSequence: 0,
      state: 'PLANNED',
    };
    return this.checkpoint;
  }

  async applyMetadataCandidateAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem): Promise<LegacyImportApplyResult> {
    return { checkpoint: this.commit(checkpoint, item, true), disposition: 'APPLIED_METADATA_ONLY' };
  }

  async recordQuarantineAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem): Promise<LegacyImportBatchCheckpoint> {
    return this.commit(checkpoint, item, false);
  }

  async rollbackMetadataCandidateAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem,
    expectedImportedAssetVersion: number): Promise<LegacyImportBatchCheckpoint> {
    assert.equal(checkpoint.batchId, item.batchId);
    assert.equal(item.state, 'METADATA_ONLY_CANDIDATE');
    assert.equal(expectedImportedAssetVersion, 1);
    if (item.deterministicAssetId) this.assetRefs.delete(item.deterministicAssetId);
    return checkpoint;
  }

  async complete(checkpoint: LegacyImportBatchCheckpoint): Promise<LegacyImportBatchCheckpoint> {
    this.checkpoint = { ...checkpoint, state: 'COMPLETED' };
    return this.checkpoint;
  }

  private commit(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem, candidate: boolean): LegacyImportBatchCheckpoint {
    if (this.failAfterFirstCommit && checkpoint.lastCompletedSequence >= 1) {
      this.failAfterFirstCommit = false;
      throw new Error('synthetic interruption');
    }
    if (candidate && item.deterministicAssetId) this.assetRefs.add(item.deterministicAssetId);
    this.completedItems.add(item.sourceRecordHash);
    this.checkpoint = { ...checkpoint, lastCompletedSequence: item.sequence, state: 'APPLYING' };
    return this.checkpoint;
  }
}

function snapshot(): LegacyInventorySnapshot {
  return {
    catalogRef: 'synthetic-m3-11',
    environment: 'test',
    sourceVersion: 'synthetic-v1',
    tenantMappings: [
      { tenantId: TENANT_A, legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', environment: 'test' },
      { tenantId: TENANT_B, legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-b', environment: 'test' },
    ],
    appBindings: [
      { tenantId: TENANT_A, appConfigurationId: APP_A, environment: 'test' },
      { tenantId: TENANT_B, appConfigurationId: APP_B, environment: 'test' },
    ],
    pages: [
      { legacyRowId: 'page-1', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', sourceType: 'FACEBOOK',
        externalId: 'shared-external-id', userCredentialPresent: true, pageCredentialPresent: false,
        userExpiresAt: 'Never', pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'waba-1', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', sourceType: 'WHATSAPP',
        externalId: 'synthetic-waba-a', userCredentialPresent: false, pageCredentialPresent: false,
        userExpiresAt: null, pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'instagram-1', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', sourceType: 'INSTAGRAM',
        externalId: 'synthetic-instagram', userCredentialPresent: false, pageCredentialPresent: false,
        userExpiresAt: null, pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'duplicate-1', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', sourceType: 'FACEBOOK',
        externalId: 'duplicate-external-id', userCredentialPresent: false, pageCredentialPresent: false,
        userExpiresAt: null, pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'duplicate-2', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', sourceType: 'FACEBOOK',
        externalId: 'duplicate-external-id', userCredentialPresent: false, pageCredentialPresent: false,
        userExpiresAt: null, pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'page-2', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-b', sourceType: 'FACEBOOK',
        externalId: 'shared-external-id', userCredentialPresent: false, pageCredentialPresent: false,
        userExpiresAt: null, pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'unmapped-page', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'unknown-company', sourceType: 'FACEBOOK',
        externalId: 'synthetic-unmapped', userCredentialPresent: false, pageCredentialPresent: false,
        userExpiresAt: null, pageExpiresAt: null, parentChannelId: null },
      { legacyRowId: 'invalid-expiry', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', sourceType: 'FACEBOOK',
        externalId: 'synthetic-invalid-expiry', userCredentialPresent: true, pageCredentialPresent: false,
        userExpiresAt: '2030-01-01T00:00:00', pageExpiresAt: null, parentChannelId: null },
    ],
    numbers: [
      { legacyRowId: 'phone-1', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a',
        legacyWabaRowId: 'waba-1', externalId: 'synthetic-phone-a' },
      { legacyRowId: 'phone-cross', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-b',
        legacyWabaRowId: 'waba-1', externalId: 'synthetic-phone-cross' },
      { legacyRowId: 'phone-orphan', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-b',
        legacyWabaRowId: 'missing-waba', externalId: 'synthetic-phone-orphan' },
    ],
  };
}

test('M3.11 dry-run keeps companies in the same legacy database separated and quarantines ambiguous rows', () => {
  const plan = planLegacyImport(snapshot(), context);
  const shared = plan.items.filter((item) => item.externalId === 'shared-external-id');
  assert.equal(shared.length, 2);
  assert.notEqual(shared[0]?.tenantId, shared[1]?.tenantId);
  assert.notEqual(shared[0]?.deterministicAssetId, shared[1]?.deterministicAssetId);
  assert.ok(shared.every((item) => item.state === 'METADATA_ONLY_CANDIDATE'));

  const duplicates = plan.items.filter((item) => item.externalId === 'duplicate-external-id');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((item) => item.state === 'QUARANTINED' && item.reasonCode === 'DUPLICATE_TARGET_ASSET'));
  assert.equal(plan.items.find((item) => item.legacyRowId === 'unmapped-page')?.reasonCode, 'TENANT_MAPPING_MISSING');
  assert.equal(plan.items.find((item) => item.legacyRowId === 'instagram-1')?.reasonCode, 'UNSUPPORTED_SOURCE_KIND');
  assert.equal(plan.items.find((item) => item.legacyRowId === 'phone-cross')?.reasonCode, 'WHATSAPP_PARENT_CROSS_TENANT');
  assert.equal(plan.items.find((item) => item.legacyRowId === 'phone-orphan')?.reasonCode, 'WHATSAPP_PARENT_MISSING');
  assert.equal(plan.items.find((item) => item.legacyRowId === 'phone-1')?.state, 'METADATA_ONLY_CANDIDATE');
});

test('M3.11 dry-run reports credential presence and unknown expiry without importing secrets', () => {
  const plan = planLegacyImport(snapshot(), context);
  const credentialRow = plan.items.find((item) => item.legacyRowId === 'page-1');
  assert.equal(credentialRow?.credentialDisposition, 'REQUIRES_REAUTH');
  assert.equal(credentialRow?.expiryObservation, 'UNKNOWN');
  assert.equal(credentialRow?.reasonCode, 'CREDENTIAL_REQUIRES_REAUTH');
  assert.equal(plan.items.find((item) => item.legacyRowId === 'invalid-expiry')?.expiryObservation, 'INVALID');
  assert.equal(plan.report.generalSettingsDisposition, 'NOT_READ_SCHEMA_NOT_CONFIRMED');
  assert.equal(plan.report.credentialReauthCount, 2);

  const report = JSON.stringify(plan.report);
  assert.equal(report.includes('page-1'), false);
  assert.equal(report.includes('shared-external-id'), false);
  assert.equal(report.includes('synthetic-db'), false);
  assert.equal(report.includes('company-a'), false);
  assert.equal(report.includes('UserAccessToken'), false);
});

test('M3.11 input rejects secret fields and an unapproved catalog alias', () => {
  const source = snapshot() as unknown as Record<string, unknown>;
  const rows = [...(source.pages as Record<string, unknown>[])];
  rows[0] = { ...rows[0], userAccessToken: 'synthetic-marker-never-logged' };
  assert.throws(() => parseLegacyInventorySnapshot({ ...source, pages: rows }), LegacyImportInputError);
  assert.throws(() => planLegacyImport({ ...snapshot(), catalogRef: 'customer-database' }, context), LegacyImportInputError);
  const invalidExternalId = snapshot() as unknown as Record<string, unknown>;
  const invalidRows = [...(invalidExternalId.pages as Record<string, unknown>[])];
  const first = invalidRows[0];
  assert.ok(first);
  invalidRows[0] = { ...first, externalId: '' };
  const invalidPlan = planLegacyImport({ ...invalidExternalId, pages: invalidRows }, context);
  assert.equal(invalidPlan.items.find((item) => item.legacyRowId === 'page-1')?.reasonCode, 'INVALID_EXTERNAL_ID');
});

test('M3.11 ambiguous tenant and app mappings quarantine records without choosing a winner', () => {
  const base = snapshot() as unknown as Record<string, unknown>;
  const mappings = [...(base.tenantMappings as Record<string, unknown>[])];
  const original = mappings[0];
  assert.ok(original);
  mappings.push({ ...original });
  const ambiguousTenantPlan = planLegacyImport({ ...base, tenantMappings: mappings }, context);
  assert.equal(ambiguousTenantPlan.items.find((item) => item.legacyRowId === 'page-1')?.reasonCode, 'TENANT_MAPPING_AMBIGUOUS');

  const apps = [...(base.appBindings as Record<string, unknown>[])];
  const originalApp = apps[0];
  assert.ok(originalApp);
  apps.push({ ...originalApp });
  const ambiguousAppPlan = planLegacyImport({ ...base, appBindings: apps }, context);
  assert.equal(ambiguousAppPlan.items.find((item) => item.legacyRowId === 'page-1')?.reasonCode, 'APP_CONFIGURATION_AMBIGUOUS');
});

test('M3.11 plan identifiers and checkpoints are deterministic for the same sanitized source version', () => {
  const first = planLegacyImport(snapshot(), context);
  const second = planLegacyImport(snapshot(), context);
  assert.equal(first.batchId, second.batchId);
  assert.deepEqual(first.items.map((item) => item.sourceRecordHash), second.items.map((item) => item.sourceRecordHash));
  assert.equal(first.checkpointSequence, 0);
  assert.equal(first.report.mode, 'DRY_RUN');
});

test('M3.11 source identity stays stable while a changed row payload remains detectable', () => {
  const first = planLegacyImport(snapshot(), context).items.find((item) => item.legacyRowId === 'page-1');
  const changed = snapshot() as unknown as Record<string, unknown>;
  const rows = [...(changed.pages as Record<string, unknown>[])];
  const page = rows.find((item) => item.legacyRowId === 'page-1');
  assert.ok(page);
  const rowIndex = rows.indexOf(page);
  rows[rowIndex] = { ...page, externalId: 'synthetic-page-changed' };
  const second = planLegacyImport({ ...changed, pages: rows }, context).items.find((item) => item.legacyRowId === 'page-1');
  assert.ok(first && second);
  assert.equal(first.sourceRecordHash, second.sourceRecordHash);
  assert.notEqual(first.sourcePayloadHash, second.sourcePayloadHash);
  assert.equal(first.deterministicAssetId, second.deterministicAssetId);
});

test('M3.11 runner resumes after a checkpoint without duplicating metadata candidates', async () => {
  const plan = planLegacyImport(snapshot(), context);
  const targetAndLedger = new SyntheticImportTargetAndLedger();
  targetAndLedger.interruptAfterFirstCommit();
  await assert.rejects(executeLegacyImportPlan(plan, targetAndLedger), /synthetic interruption/);
  const countAfterInterruption = targetAndLedger.assetRefs.size;
  const completed = await executeLegacyImportPlan(plan, targetAndLedger);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.lastCompletedSequence, plan.items.length);
  assert.equal(targetAndLedger.completedItems.size, plan.items.length);
  assert.equal(targetAndLedger.assetRefs.size, plan.report.candidateCount);
  assert.ok(targetAndLedger.assetRefs.size >= countAfterInterruption);
  const rollbackCandidate = plan.items.find((item) => item.state === 'METADATA_ONLY_CANDIDATE');
  assert.ok(rollbackCandidate?.deterministicAssetId);
  await targetAndLedger.rollbackMetadataCandidateAndCheckpoint(completed, rollbackCandidate, 1);
  assert.equal(targetAndLedger.assetRefs.has(rollbackCandidate.deterministicAssetId), false);
  assert.equal(targetAndLedger.assetRefs.size, plan.report.candidateCount - 1);
});

test('M3.11 credential CAS fence refuses to overwrite a newer reauthorization', () => {
  const expected = { expectedCredentialVersion: 4, expectedSecretVersion: 7, expectedReauthorizationGeneration: 2 };
  assert.equal(credentialImportFenceMatches(expected, {
    credentialVersion: 4, secretVersion: 7, reauthorizationGeneration: 2,
  }), true);
  assert.equal(credentialImportFenceMatches(expected, {
    credentialVersion: 5, secretVersion: 8, reauthorizationGeneration: 3,
  }), false);
  assert.equal(credentialImportFenceMatches({ ...expected, expectedSecretVersion: Number.NaN }, {
    credentialVersion: 4, secretVersion: 7, reauthorizationGeneration: 2,
  }), false);
});

test('M3.11 CLI defaults to the synthetic dry-run and rejects apply mode', () => {
  assert.deepEqual(parseLegacyImportCliArguments([]), { dryRun: true, fixtureName: 'synthetic-inventory.json' });
  assert.throws(() => parseLegacyImportCliArguments(['--apply']), /Apply mode is not available in M3\.11/);
});
