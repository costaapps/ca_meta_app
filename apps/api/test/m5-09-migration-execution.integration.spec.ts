import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ApiEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import type { LegacyImportApplyPort, LegacyImportApplyResult } from '../src/legacy-import/legacy-import.ports.js';
import { executeLegacyImportPlan } from '../src/legacy-import/legacy-import.runner.js';
import { createLegacyImportReferenceHasher, planLegacyImport } from '../src/legacy-import/legacy-import.planner.js';
import type { LegacyImportBatchCheckpoint, LegacyImportPlan, LegacyImportPlanItem, LegacyInventorySnapshot } from '../src/legacy-import/legacy-import.types.js';
import { MysqlLegacyImportLedger } from '../src/legacy-import/mysql-legacy-import-ledger.js';
import { MigrationManifestTrackingApplyPort } from '../src/migration-execution/migration-execution.port.js';
import { MysqlMigrationBatchManifestRepository, MysqlMigrationCohortWriterRepository } from '../src/migration-execution/migration-execution-control.store.js';
import {
  createMigrationBatchManifest, detectMigrationSourceDrift, reconcileMigrationSourceDrift,
} from '../src/migration-execution/migration-execution.policy.js';
import type { MigrationSurfaceCounts, MigrationWriterAssignment, MigrationWriterOwner } from '../src/migration-execution/migration-execution.types.js';

const enabled = process.env.M5_09_TEST === '1';
const catalogRef = 'synthetic-m5-09-mariadb';
const hasher = createLegacyImportReferenceHasher(Buffer.from('m5.09-disposable-mariadb-fixture-hmac-key'));
const context = { allowedCatalogRefs: new Set([catalogRef]), hasher };
const syntheticCounts: MigrationSurfaceCounts = {
  assets: 2, templates: 1, messageConfigurations: 1, relationships: 0, credentialReferences: 1,
};

function sourceSnapshot(tenantId: string, appConfigurationId: string): LegacyInventorySnapshot {
  return {
    catalogRef, environment: 'test', sourceVersion: 'synthetic-watermark-v1',
    tenantMappings: [{ tenantId, legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'synthetic-company', environment: 'test' }],
    appBindings: [{ tenantId, appConfigurationId, environment: 'test' }],
    pages: [
      {
        legacyRowId: 'synthetic-row-a', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'synthetic-company',
        sourceType: 'FACEBOOK', externalId: 'synthetic-external-a', userCredentialPresent: true,
        pageCredentialPresent: false, userExpiresAt: 'Never', pageExpiresAt: null, parentChannelId: null,
      },
      {
        legacyRowId: 'synthetic-row-b', legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'synthetic-company',
        sourceType: 'INSTAGRAM', externalId: 'synthetic-external-b', userCredentialPresent: false,
        pageCredentialPresent: false, userExpiresAt: null, pageExpiresAt: null, parentChannelId: null,
      },
    ],
    numbers: [],
  };
}

function newWriterMatrix(tenantId: string): MigrationWriterAssignment[] {
  const definitions: Array<[MigrationWriterAssignment['functionName'], MigrationWriterOwner]> = [
    ['CONFIGURATION', 'LEGACY'], ['CREDENTIAL_REFERENCE', 'LEGACY'],
    ['LEGACY_PROJECTION', 'LEGACY'], ['OPERATION_RELAY', 'LEGACY'],
  ];
  const cohortId = randomUUID();
  return definitions.map(([functionName, writerOwner]) => ({
    cohortId, tenantId, channelFamily: 'WHATSAPP_EXCLUSIVE', consumerKind: 'PORTAL', functionName,
    writerOwner, previousWriterOwner: null, phase: 'PREPARED', shadowReadEnabled: false,
    legacyRouteVerified: true, unresolvedExternalEffects: 0, driftReconciledSnapshotHash: null, version: 1,
  }));
}

class CrashAfterFirstCommit implements LegacyImportApplyPort {
  private interrupted = false;
  constructor(private readonly delegate: LegacyImportApplyPort) {}
  beginOrResume(plan: LegacyImportPlan): Promise<LegacyImportBatchCheckpoint> { return this.delegate.beginOrResume(plan); }
  async applyMetadataCandidateAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem): Promise<LegacyImportApplyResult> {
    const committed = await this.delegate.applyMetadataCandidateAndCheckpoint(checkpoint, item);
    if (!this.interrupted) {
      this.interrupted = true;
      throw new Error('synthetic process interruption after committed checkpoint');
    }
    return committed;
  }
  recordQuarantineAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem): Promise<LegacyImportBatchCheckpoint> {
    return this.delegate.recordQuarantineAndCheckpoint(checkpoint, item);
  }
  rollbackMetadataCandidateAndCheckpoint(checkpoint: LegacyImportBatchCheckpoint, item: LegacyImportPlanItem, version: number): Promise<LegacyImportBatchCheckpoint> {
    return this.delegate.rollbackMetadataCandidateAndCheckpoint(checkpoint, item, version);
  }
  complete(checkpoint: LegacyImportBatchCheckpoint): Promise<LegacyImportBatchCheckpoint> { return this.delegate.complete(checkpoint); }
}

test('M5.09 MariaDB persists redacted provenance, resumes M3.11 checkpoints, and controls one writer per cohort', {
  skip: enabled ? false : 'Run with the M5.09 disposable MariaDB harness (`--database`).',
}, async () => {
  const tenantId = randomUUID();
  const appConfigurationId = randomUUID();
  const authorizationId = randomUUID();
  const timestamp = '2026-11-12 12:00:00.000000';
  const dbEnvironment = {
    database: {
      host: process.env.API_DATABASE_HOST,
      port: Number(process.env.API_DATABASE_PORT),
      name: process.env.API_DATABASE_NAME,
      user: process.env.API_DATABASE_USER,
      password: process.env.API_DATABASE_PASSWORD,
      connectTimeoutMs: 5_000,
    },
  } as ApiEnvironment;
  const database = new DurableWorkDatabase(dbEnvironment);
  const dataSource = await database.getDataSource();
  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, credential_ref, version, created_at, updated_at)
       VALUES (?, ?, 'META', 'synthetic-app', 'test', NULL, 1, ?, ?)`,
      [appConfigurationId, tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_authorizations
       (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id,
        authorization_state, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'synthetic-revoked-authorization', 'REVOKED', ?, ?, ?)`,
      [authorizationId, tenantId, appConfigurationId, timestamp, timestamp, timestamp],
    );

    const sourcePlan = planLegacyImport(sourceSnapshot(tenantId, appConfigurationId), context);
    const manifest = createMigrationBatchManifest(sourcePlan, catalogRef, syntheticCounts);
    const legacyLedger = new MysqlLegacyImportLedger(database);
    const manifestRepository = new MysqlMigrationBatchManifestRepository(database);
    const tracked = new MigrationManifestTrackingApplyPort(legacyLedger, manifestRepository, manifest);
    await assert.rejects(executeLegacyImportPlan(sourcePlan, new CrashAfterFirstCommit(tracked)), /synthetic process interruption/);
    const interrupted = await manifestRepository.readCheckpoint(sourcePlan.batchId);
    assert.equal(interrupted.lastCompletedSequence, 1);
    assert.equal(interrupted.state, 'APPLYING');

    const resumed = await executeLegacyImportPlan(sourcePlan, tracked);
    assert.equal(resumed.state, 'COMPLETED');
    assert.equal(resumed.lastCompletedSequence, 2);
    const checkpoint = await manifestRepository.readCheckpoint(sourcePlan.batchId);
    assert.equal(checkpoint.lastCompletedSequence, 2);
    const report = await manifestRepository.recordAfterCounts(sourcePlan.batchId, checkpoint.version, syntheticCounts);
    assert.equal(report.mode, 'DRY_RUN');
    assert.deepEqual(report.beforeCounts, syntheticCounts);
    assert.deepEqual(report.afterCounts, syntheticCounts);
    assert.deepEqual(report.countDeltas, { assets: 0, templates: 0, messageConfigurations: 0, relationships: 0, credentialReferences: 0 });
    await executeLegacyImportPlan(sourcePlan, tracked);
    const claims = await dataSource.query('SELECT COUNT(*) AS count FROM ca_meta_legacy_import_claims') as Array<{ count: number | string }>;
    assert.equal(Number(claims[0]?.count), 1);
    const authorizationRows = await dataSource.query(
      'SELECT authorization_state FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ?', [tenantId, authorizationId],
    ) as Array<{ authorization_state: string }>;
    assert.equal(authorizationRows[0]?.authorization_state, 'REVOKED', 'cohort rollback does not restore a revoked authorization');
    const persistedManifest = await dataSource.query(
      'SELECT * FROM ca_meta_migration_batch_manifests WHERE batch_id = ?', [sourcePlan.batchId],
    );
    const persistedItems = await dataSource.query(
      'SELECT * FROM ca_meta_legacy_import_items WHERE batch_id = ?', [sourcePlan.batchId],
    );
    const quarantineRows = await dataSource.query(
      `SELECT reason_code FROM ca_meta_legacy_import_items
       WHERE batch_id = ? AND item_state = 'QUARANTINED' ORDER BY sequence`, [sourcePlan.batchId],
    ) as Array<{ reason_code: string }>;
    assert.deepEqual(quarantineRows.map((row) => row.reason_code), ['UNSUPPORTED_SOURCE_KIND']);
    const safeJson = JSON.stringify([persistedManifest, persistedItems]);
    assert.equal(safeJson.includes('synthetic-row-a'), false);
    assert.equal(safeJson.includes('synthetic-external-a'), false);
    assert.equal(safeJson.includes('synthetic-company'), false);

    const cohortScope = { cohortId: '', tenantId, channelFamily: 'WHATSAPP_EXCLUSIVE' as const, consumerKind: 'PORTAL' as const };
    const writerRepository = new MysqlMigrationCohortWriterRepository(database);
    const emptyDrift = detectMigrationSourceDrift({ snapshotHash: hasher.digest('empty-before'), records: [] },
      { snapshotHash: hasher.digest('empty-current'), records: [] });
    const readyForCutover = reconcileMigrationSourceDrift(emptyDrift, {
      currentSnapshotHash: emptyDrift.currentSnapshotHash,
      addedSourceRecordHashes: [], changedSourceRecordHashes: [], removedSourceRecordHashes: [],
    });
    const initial = newWriterMatrix(tenantId);
    cohortScope.cohortId = initial[0]!.cohortId;
    let matrix = await writerRepository.initialize(initial);
    matrix = await writerRepository.enableShadowRead(cohortScope);
    assert.ok(matrix.every((entry) => entry.shadowReadEnabled && entry.writerOwner === 'LEGACY'));
    const targets: Record<MigrationWriterAssignment['functionName'], MigrationWriterOwner> = {
      CONFIGURATION: 'CENTRAL', CREDENTIAL_REFERENCE: 'CENTRAL', LEGACY_PROJECTION: 'PROJECTOR',
      OPERATION_RELAY: 'RELAY', WEBHOOK_DISPATCH: 'NEW',
    };
    const configuration = matrix.find((entry) => entry.functionName === 'CONFIGURATION')!;
    const races = await Promise.allSettled([
      writerRepository.switchWriter({ scope: cohortScope, functionName: 'CONFIGURATION', expectedVersion: configuration.version,
        nextOwner: targets.CONFIGURATION, driftReconciliation: readyForCutover }),
      writerRepository.switchWriter({ scope: cohortScope, functionName: 'CONFIGURATION', expectedVersion: configuration.version,
        nextOwner: targets.CONFIGURATION, driftReconciliation: readyForCutover }),
    ]);
    assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(races.filter((result) => result.status === 'rejected').length, 1);
    matrix = await writerRepository.enableShadowRead(cohortScope);
    assert.equal(matrix.find((entry) => entry.functionName === 'CONFIGURATION')?.driftReconciledSnapshotHash,
      emptyDrift.currentSnapshotHash);
    for (const entry of matrix) {
      if (entry.writerOwner === 'LEGACY') {
        await writerRepository.switchWriter({
          scope: cohortScope, functionName: entry.functionName, expectedVersion: entry.version,
          nextOwner: targets[entry.functionName], driftReconciliation: readyForCutover,
        });
      }
    }
    matrix = await writerRepository.enableShadowRead(cohortScope);
    const expectedVersions = Object.fromEntries(matrix.map((entry) => [entry.functionName, entry.version]));
    const rollback = await writerRepository.rollbackCohort({ scope: cohortScope, expectedVersions });
    assert.ok(rollback.assignments.every((entry) => entry.phase === 'ROLLED_BACK'));
    assert.ok(rollback.assignments.filter((entry) => entry.functionName !== 'CREDENTIAL_REFERENCE')
      .every((entry) => entry.writerOwner === 'LEGACY'));
    assert.equal(rollback.assignments.find((entry) => entry.functionName === 'CREDENTIAL_REFERENCE')?.writerOwner, 'CENTRAL');
    assert.equal(rollback.credentialReferencesKeptCentral, true);
    assert.equal(rollback.credentialAction, 'NONE');
    assert.equal(rollback.grantAction, 'NONE');
    assert.equal(rollback.providerEffectsReconciled, false);
    const authorizationAfterRollback = await dataSource.query(
      'SELECT authorization_state FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ?', [tenantId, authorizationId],
    ) as Array<{ authorization_state: string }>;
    assert.equal(authorizationAfterRollback[0]?.authorization_state, 'REVOKED');
  } finally {
    await database.close();
  }
});
