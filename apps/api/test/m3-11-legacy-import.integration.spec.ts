import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { LEGACY_IMPORT_MIGRATION } from '../src/database/migrations/legacy-import-ledger.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { createLegacyImportReferenceHasher, planLegacyImport } from '../src/legacy-import/legacy-import.planner.js';
import { executeLegacyImportPlan } from '../src/legacy-import/legacy-import.runner.js';
import type { LegacyImportApplyPort, LegacyImportApplyResult } from '../src/legacy-import/legacy-import.ports.js';
import type { LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem, LegacyInventorySnapshot } from '../src/legacy-import/legacy-import.types.js';
import { MysqlLegacyImportLedger } from '../src/legacy-import/mysql-legacy-import-ledger.js';

const enabled = process.env.M3_11_TEST === '1';
const testContext = {
  allowedCatalogRefs: new Set(['synthetic-m3-11-mariadb']),
  hasher: createLegacyImportReferenceHasher(Buffer.from('m3.11-mariadb-fixture-hmac-key-not-for-production')),
};
const externalIdMarker = 'synthetic-provider-id-never-persist-this';
const legacyRowIdMarker = 'synthetic-source-row-never-persist-this';

function snapshot(sourceVersion: string, externalId = externalIdMarker, legacyRowId = legacyRowIdMarker): LegacyInventorySnapshot {
  const tenantId = '61111111-1111-4111-8111-111111111111';
  const appConfigurationId = '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return {
    catalogRef: 'synthetic-m3-11-mariadb',
    environment: 'test',
    sourceVersion,
    tenantMappings: [{ tenantId, legacyDatabaseId: 'synthetic-source', legacyCompanyId: 'synthetic-company', environment: 'test' }],
    appBindings: [{ tenantId, appConfigurationId, environment: 'test' }],
    pages: [{
      legacyRowId,
      legacyDatabaseId: 'synthetic-source',
      legacyCompanyId: 'synthetic-company',
      sourceType: 'FACEBOOK',
      externalId,
      userCredentialPresent: false,
      pageCredentialPresent: false,
      userExpiresAt: null,
      pageExpiresAt: null,
      parentChannelId: null,
    }],
    numbers: [],
  };
}

function plan(sourceVersion: string, externalId?: string, legacyRowId?: string): LegacyImportPlan {
  return planLegacyImport(snapshot(sourceVersion, externalId, legacyRowId), testContext);
}

test('M3.11 MariaDB ledger resumes atomically, deduplicates stable claims and quarantines changed payloads', {
  skip: enabled ? false : 'Run in the disposable M2.05/MariaDB fixture with M3_11_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const database = new DurableWorkDatabase(validateEnvironment(process.env));
  const dataSource = await database.getDataSource();
  const tenantId = '61111111-1111-4111-8111-111111111111';
  const appConfigurationId = '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const timestamp = '2026-11-04 12:00:00.000000';

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    const applied = await dataSource.query(
      'SELECT state FROM ca_meta_schema_migrations WHERE migration_id = ?',
      [LEGACY_IMPORT_MIGRATION.id],
    ) as Array<{ state: string }>;
    assert.equal(applied[0]?.state, 'APPLIED');
    await dataSource.query(
      'INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at) VALUES (?, \'ACTIVE\', 1, ?, ?)',
      [tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, credential_ref, version, created_at, updated_at)
       VALUES (?, ?, 'META', 'synthetic-app', 'test', NULL, 1, ?, ?)`,
      [appConfigurationId, tenantId, timestamp, timestamp],
    );

    const ledger = new MysqlLegacyImportLedger(database);
    const originalPlan = plan('synthetic-watermark-v1');
    let interrupted = false;
    const crashAfterCommit: LegacyImportApplyPort = {
      beginOrResume: (candidate) => ledger.beginOrResume(candidate),
      applyMetadataCandidateAndCheckpoint: async (current, item): Promise<LegacyImportApplyResult> => {
        const committed = await ledger.applyMetadataCandidateAndCheckpoint(current, item);
        if (!interrupted) {
          interrupted = true;
          throw new Error('synthetic process interruption after transaction commit');
        }
        return committed;
      },
      recordQuarantineAndCheckpoint: (current, item) => ledger.recordQuarantineAndCheckpoint(current, item),
      rollbackMetadataCandidateAndCheckpoint: (current, item, version) => ledger.rollbackMetadataCandidateAndCheckpoint(current, item, version),
      complete: (current) => ledger.complete(current),
    };
    await assert.rejects(executeLegacyImportPlan(originalPlan, crashAfterCommit), /synthetic process interruption/);
    const interruptedBatch = await dataSource.query(
      'SELECT last_completed_sequence, state FROM ca_meta_legacy_import_batches WHERE batch_id = ?',
      [originalPlan.batchId],
    ) as Array<{ last_completed_sequence: number | string; state: string }>;
    assert.deepEqual(interruptedBatch.map((row) => [Number(row.last_completed_sequence), row.state]), [[1, 'APPLYING']]);

    const resumed = await executeLegacyImportPlan(originalPlan, ledger);
    assert.equal(resumed.state, 'COMPLETED');
    assert.equal(resumed.lastCompletedSequence, 1);
    const initialClaimCount = await dataSource.query('SELECT COUNT(*) AS count FROM ca_meta_legacy_import_claims') as Array<{ count: number | string }>;
    assert.equal(Number(initialClaimCount[0]?.count), 1);

    const repeatedPlan = plan('synthetic-watermark-v2');
    const repeated = await executeLegacyImportPlan(repeatedPlan, ledger);
    assert.equal(repeated.state, 'COMPLETED');
    const repeatedItem = await dataSource.query(
      'SELECT item_state FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = 1',
      [repeatedPlan.batchId],
    ) as Array<{ item_state: string }>;
    assert.equal(repeatedItem[0]?.item_state, 'REPLAYED');
    const originalCandidate = originalPlan.items[0];
    assert.ok(originalCandidate);
    await assert.rejects(
      ledger.rollbackMetadataCandidateAndCheckpoint(resumed, originalCandidate, 1),
      /cannot be rolled back after another batch replayed it/,
    );
    const replayedItemAfterRollbackAttempt = await dataSource.query(
      'SELECT item_state FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = 1',
      [repeatedPlan.batchId],
    ) as Array<{ item_state: string }>;
    const ownerClaimAfterRollbackAttempt = await dataSource.query(
      'SELECT created_batch_id FROM ca_meta_legacy_import_claims WHERE source_record_hash = ?',
      [originalCandidate.sourceRecordHash],
    ) as Array<{ created_batch_id: string }>;
    assert.equal(replayedItemAfterRollbackAttempt[0]?.item_state, 'REPLAYED');
    assert.equal(ownerClaimAfterRollbackAttempt[0]?.created_batch_id, originalPlan.batchId);

    const changedPlan = plan('synthetic-watermark-v3', 'synthetic-provider-id-changed-payload');
    assert.equal(changedPlan.items[0]?.sourceRecordHash, originalPlan.items[0]?.sourceRecordHash);
    assert.notEqual(changedPlan.items[0]?.sourcePayloadHash, originalPlan.items[0]?.sourcePayloadHash);
    const changed = await executeLegacyImportPlan(changedPlan, ledger);
    assert.equal(changed.state, 'COMPLETED');
    const changedItem = await dataSource.query(
      'SELECT item_state, reason_code FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = 1',
      [changedPlan.batchId],
    ) as Array<{ item_state: string; reason_code: string | null }>;
    assert.deepEqual(changedItem.map((row) => [row.item_state, row.reason_code]), [['QUARANTINED_SOURCE_CHANGED', 'SOURCE_ROW_CHANGED']]);
    const claims = await dataSource.query(
      'SELECT source_payload_hash, claim_state FROM ca_meta_legacy_import_claims WHERE source_record_hash = ?',
      [originalPlan.items[0]?.sourceRecordHash],
    ) as Array<{ source_payload_hash: string; claim_state: string }>;
    assert.equal(claims[0]?.source_payload_hash, originalPlan.items[0]?.sourcePayloadHash);
    assert.equal(claims[0]?.claim_state, 'UNVERIFIED_METADATA_ONLY');

    const otherBatchPlan = plan('synthetic-watermark-v4', 'synthetic-provider-id-other-batch', 'synthetic-row-other-batch');
    const otherBatchStart = await ledger.beginOrResume(otherBatchPlan);
    const otherBatchItem = otherBatchPlan.items[0];
    assert.ok(otherBatchItem);
    const otherBatchClaim = await ledger.applyMetadataCandidateAndCheckpoint(otherBatchStart, otherBatchItem);
    assert.equal(otherBatchClaim.disposition, 'APPLIED_METADATA_ONLY');
    await assert.rejects(
      ledger.rollbackMetadataCandidateAndCheckpoint(resumed, otherBatchItem, 1),
      /checkpoint and item belong to different batches/,
    );
    const otherBatchItemAfter = await dataSource.query(
      'SELECT item_state FROM ca_meta_legacy_import_items WHERE batch_id = ? AND sequence = 1',
      [otherBatchPlan.batchId],
    ) as Array<{ item_state: string }>;
    const otherBatchClaimAfter = await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_legacy_import_claims WHERE source_record_hash = ?',
      [otherBatchItem.sourceRecordHash],
    ) as Array<{ count: number | string }>;
    assert.equal(otherBatchItemAfter[0]?.item_state, 'CLAIMED');
    assert.equal(Number(otherBatchClaimAfter[0]?.count), 1);

    const persistedLedger = {
      batches: await dataSource.query('SELECT * FROM ca_meta_legacy_import_batches'),
      items: await dataSource.query('SELECT * FROM ca_meta_legacy_import_items'),
      claims: await dataSource.query('SELECT * FROM ca_meta_legacy_import_claims'),
    };
    const serializedLedger = JSON.stringify(persistedLedger);
    assert.equal(serializedLedger.includes(externalIdMarker), false);
    assert.equal(serializedLedger.includes(legacyRowIdMarker), false);
    assert.equal(serializedLedger.includes('synthetic-provider-id-changed-payload'), false);
  } finally {
    await database.close();
  }
});
