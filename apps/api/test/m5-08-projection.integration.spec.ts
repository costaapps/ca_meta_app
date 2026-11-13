import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DataSource } from 'typeorm';
import type { ApiEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import { OutboxService } from '../src/outbox/outbox-service.js';
import { MysqlLegacyProjectionSource } from '../src/legacy-projection/mysql-legacy-projection.source.js';
import { destinationKeyHash } from '../src/legacy-projection/legacy-projection.mapper.js';
import { AllowlistedLegacyProjectionCatalog } from '../src/legacy-projection/legacy-projection.catalog.js';
import { MysqlLegacyProjectionCheckpointStore } from '../src/legacy-projection/mysql-legacy-projection-checkpoints.js';
import { MysqlLegacyProjectionDestination } from '../src/legacy-projection/mysql-legacy-projection.destination.js';
import { LegacyProjectionService } from '../src/legacy-projection/legacy-projection.service.js';
import { DurableLegacyProjectionJobScheduler } from '../src/legacy-projection/legacy-projection.jobs.js';
import type { LegacyProjectionRecord, LegacyProjectionTargetKey } from '../src/legacy-projection/legacy-projection.types.js';
import type { OutboxEventEnvelope } from '../src/jobs/event-validation.js';

const enabled = process.env.M5_08_PROJECTION_INTEGRATION === '1';
const tenantId = randomUUID();
const companyA: LegacyProjectionTargetKey = { legacyDatabaseId: 'synthetic-db-a', legacyCompanyId: 'company-a', environment: 'test' };
const companyB: LegacyProjectionTargetKey = { legacyDatabaseId: 'synthetic-db-a', legacyCompanyId: 'company-b', environment: 'test' };
const destinationB: LegacyProjectionTargetKey = { legacyDatabaseId: 'synthetic-db-b', legacyCompanyId: 'company-c', environment: 'test' };

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value && value.trim().length > 0, `Missing test setting ${name}.`);
  return value;
}

function connection(prefix: 'CENTRAL' | 'DEST_A' | 'DEST_B') {
  const credentialPrefix = prefix === 'CENTRAL' ? 'M5_08_CENTRAL_API' : `M5_08_${prefix}`;
  return {
    type: 'mariadb' as const,
    host: required('M5_08_TEST_DB_HOST'),
    port: Number(required('M5_08_TEST_DB_PORT')),
    database: required(`M5_08_${prefix}_DATABASE_NAME`),
    username: required(`${credentialPrefix}_DATABASE_USER`),
    password: required(`${credentialPrefix}_DATABASE_PASSWORD`),
    timezone: 'Z' as const,
    synchronize: false,
    logging: false,
    extra: { connectionLimit: 3 },
  };
}

function record(centralRef: string, legacyAssetRef: string, overrides: Partial<LegacyProjectionRecord> = {}): LegacyProjectionRecord {
  return Object.freeze({
    kind: 'PAGE', centralRef, legacyAssetRef, sourceVersion: 1, status: 'ACTIVE',
    externalId: 'synthetic-meta-page', displayName: 'Synthetic page', assetKind: 'FACEBOOK_PAGE',
    parentLegacyAssetRef: null, capabilities: Object.freeze(['PAGES_READ']), configVersion: null, tombstone: false,
    ...overrides,
  });
}

function event(
  eventId: string,
  aggregateVersion: number,
  eventTenantId = tenantId,
  connectionRef = 'connection-ref',
): OutboxEventEnvelope {
  return Object.freeze({
    eventId, tenantRef: eventTenantId, schemaVersion: 1, eventType: 'connection.changed', aggregateRef: connectionRef,
    aggregateVersion, actor: { kind: 'SYSTEM' as const, ref: 'm5-08-integration' }, correlationId: 'm5-08-integration',
    causationId: null, createdAt: '2026-11-11T00:00:00.000Z', enqueuedAt: '2026-11-11T00:00:00.000Z',
    data: { kind: 'CONNECTION_CHANGED', connectionRef, status: 'ACTIVE', observedAt: '2026-11-11T00:00:00.000Z' },
  });
}

function projectionSnapshot(
  currentEvent: OutboxEventEnvelope,
  targets: readonly { readonly target: LegacyProjectionTargetKey; readonly records: readonly LegacyProjectionRecord[] }[],
) {
  return Object.freeze({ tenantId, event: currentEvent, targets });
}

function assetFixtureDdl(table: 'MetaConnectedPages' | 'MetaConnectedNumbers'): string { return `CREATE TABLE IF NOT EXISTS ${table} (
  IdDatabase VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IdCompany VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  Environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IdAsset VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  CentralAssetRef VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ExternalId VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  DisplayName VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  AssetKind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ParentLegacyAssetRef VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  CapabilitiesJson JSON NOT NULL,
  Status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ProjectionVersion BIGINT UNSIGNED NOT NULL,
  ProjectionSchemaVersion SMALLINT UNSIGNED NOT NULL,
  ContentHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IsDeleted TINYINT(1) NOT NULL,
  UpdatedAt DATETIME(6) NOT NULL,
  PRIMARY KEY (IdDatabase, IdCompany, Environment, IdAsset)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`; }

const automationFixtureDdl = `CREATE TABLE IF NOT EXISTS MetaAssetAutomationConfigs (
  IdDatabase VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IdCompany VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  Environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IdAsset VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  CentralAssetRef VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ConfigVersion INT UNSIGNED NOT NULL,
  Status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ProjectionVersion BIGINT UNSIGNED NOT NULL,
  ProjectionSchemaVersion SMALLINT UNSIGNED NOT NULL,
  ContentHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IsDeleted TINYINT(1) NOT NULL,
  UpdatedAt DATETIME(6) NOT NULL,
  PRIMARY KEY (IdDatabase, IdCompany, Environment, IdAsset)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;

test('M5.08 MariaDB fault injection: duplicate/order, company isolation, independent destination retry and metadata-only writes', { skip: !enabled }, async (t) => {
  const centralConfig = connection('CENTRAL');
  const aConfig = connection('DEST_A');
  const bConfig = connection('DEST_B');
  const centralName = required('M5_08_CENTRAL_DATABASE_NAME');
  const aName = required('M5_08_DEST_A_DATABASE_NAME');
  const bName = required('M5_08_DEST_B_DATABASE_NAME');
  assert.equal(centralName, 'ca_meta_m5_08_v25', 'Central integration database must be the fresh v25 synthetic schema.');
  assert.equal(aName, 'ca_meta_m5_08_v25_dest_a', 'Destination A must be the fresh v25 synthetic schema.');
  assert.equal(bName, 'ca_meta_m5_08_v25_dest_b', 'Destination B must be the fresh v25 synthetic schema.');

  const central = new DurableWorkDatabase({ database: {
    host: centralConfig.host, port: centralConfig.port, name: centralConfig.database,
    user: centralConfig.username, password: centralConfig.password, connectTimeoutMs: 5000,
  } } as ApiEnvironment);
  const targetA = new DataSource(aConfig);
  const targetB = new DataSource(bConfig);
  const destinationCatalog = new AllowlistedLegacyProjectionCatalog([
    { target: companyA, dataSource: targetA }, { target: companyB, dataSource: targetA }, { target: destinationB, dataSource: targetB },
  ]);
  const checkpointStore = new MysqlLegacyProjectionCheckpointStore(central);
  const projection = new LegacyProjectionService(checkpointStore, destinationCatalog);
  let fixtureReady = false;

  try {
    const centralSource = await central.getDataSource();
    await targetA.initialize();
    await targetB.initialize();
    const [{ database: actualCentral }] = await centralSource.query('SELECT DATABASE() AS database') as Array<{ database: string }>;
    const [{ database: actualA }] = await targetA.query('SELECT DATABASE() AS database') as Array<{ database: string }>;
    const [{ database: actualB }] = await targetB.query('SELECT DATABASE() AS database') as Array<{ database: string }>;
    assert.deepEqual([actualCentral, actualA, actualB], [centralName, aName, bName]);

    for (const ddl of [assetFixtureDdl('MetaConnectedPages'), assetFixtureDdl('MetaConnectedNumbers'), automationFixtureDdl]) {
      await targetA.query(ddl);
      await targetB.query(ddl);
    }
    fixtureReady = true;
    await targetA.query('DROP TRIGGER IF EXISTS m5_08_projection_fail_insert');
    await targetB.query('DROP TRIGGER IF EXISTS m5_08_projection_fail_insert');
    await centralSource.query(
      `INSERT IGNORE INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`, [tenantId],
    );

    const jobStore = new DurableJobStore(central);
    const outbox = new OutboxService(central, jobStore, new DurableLegacyProjectionJobScheduler(jobStore));
    const eventToAppend = event('event-with-atomic-projection-job', 8);
    const appended = await outbox.append(eventToAppend);
    const duplicateAppend = await outbox.append(eventToAppend);
    await outbox.append(event('event-same-aggregate-newer', 9));
    assert.equal(appended.duplicate, false);
    assert.equal(duplicateAppend.duplicate, true);
    const queued = await centralSource.query(
      `SELECT job_type FROM ca_meta_jobs WHERE tenant_id = ? AND correlation_id = ? ORDER BY job_type`,
      [tenantId, 'm5-08-integration'],
    ) as Array<{ job_type: string }>;
    assert.deepEqual(queued.map((job) => job.job_type), [
      'OUTBOX_DELIVER', 'OUTBOX_DELIVER', 'PROJECTION_RECONCILE', 'PROJECTION_RECONCILE',
    ]);
    const projectionScopes = await centralSource.query(
      `SELECT resource_scope_ref FROM ca_meta_jobs WHERE tenant_id = ? AND correlation_id = ?
       AND job_type = 'PROJECTION_RECONCILE' ORDER BY created_at, id`,
      [tenantId, 'm5-08-integration'],
    ) as Array<{ resource_scope_ref: string }>;
    assert.equal(projectionScopes.length, 2);
    assert.equal(projectionScopes[0]?.resource_scope_ref, projectionScopes[1]?.resource_scope_ref,
      'same tenant aggregate projection jobs must use the same serialization scope');
    const firstProjectionClaim = await jobStore.claimNext('m5-08-projection-order-a', 300_000, ['PROJECTION_RECONCILE']);
    assert.ok(firstProjectionClaim);
    assert.equal(await jobStore.claimNext('m5-08-projection-order-b', 300_000, ['PROJECTION_RECONCILE']), null,
      'a second event for the same aggregate cannot run concurrently');
    assert.equal(await jobStore.finish(firstProjectionClaim, { kind: 'SUCCEEDED' }), true);
    const secondProjectionClaim = await jobStore.claimNext('m5-08-projection-order-b', 300_000, ['PROJECTION_RECONCILE']);
    assert.ok(secondProjectionClaim);
    assert.equal(await jobStore.finish(secondProjectionClaim, { kind: 'SUCCEEDED' }), true);
    const eventPayload = await centralSource.query(
      `SELECT payload_json FROM ca_meta_outbox_events WHERE tenant_id = ? AND event_id = ?`,
      [tenantId, eventToAppend.eventId],
    ) as Array<{ payload_json: string | Buffer }>;
    const storedPayload = eventPayload[0]?.payload_json;
    const persistedEnvelope = Buffer.isBuffer(storedPayload) ? storedPayload.toString('utf8') :
      typeof storedPayload === 'string' ? storedPayload : JSON.stringify(storedPayload ?? null);
    assert.doesNotMatch(persistedEnvelope, /token|secret|password|dsn/i);

    const higher = record('central-page-a', 'same-legacy-page', { sourceVersion: 3, displayName: 'Newest synthetic page' });
    const samePhysicalIdForOtherCompany = record('central-page-b', 'same-legacy-page', { sourceVersion: 3, displayName: 'Other company page' });
    const failingDestination = record('central-page-c', 'destination-b-page');
    await targetB.query(`CREATE TRIGGER m5_08_projection_fail_insert BEFORE INSERT ON MetaConnectedPages
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic M5.08 destination fault'`);

    const first = await projection.project({ tenantId, event: event('event-first', 1), targets: [
      { target: companyA, records: [higher] },
      { target: companyB, records: [samePhysicalIdForOtherCompany] },
      { target: destinationB, records: [failingDestination] },
    ] });
    assert.deepEqual(first.destinations.map((result) => result.state), ['SYNCED', 'SYNCED', 'PENDING']);

    const companyRows = await targetA.query(
      `SELECT IdCompany AS company, ProjectionVersion AS version, DisplayName AS display_name
       FROM MetaConnectedPages WHERE IdDatabase = ? AND Environment = ? AND IdAsset = ? ORDER BY IdCompany`,
      [companyA.legacyDatabaseId, companyA.environment, 'same-legacy-page'],
    ) as Array<{ company: string; version: number | string; display_name: string }>;
    assert.deepEqual(companyRows.map((row) => [row.company, Number(row.version)]), [['company-a', 3], ['company-b', 3]]);
    assert.notEqual(companyRows[0]?.display_name, companyRows[1]?.display_name);

    await targetB.query('DROP TRIGGER m5_08_projection_fail_insert');
    const retry = await projection.project({ tenantId, event: event('event-retry', 1), targets: [
      { target: destinationB, records: [failingDestination] },
    ] });
    assert.equal(retry.destinations[0]?.state, 'SYNCED');
    assert.equal(retry.destinations[0]?.applied, 1);

    const staleOwned = record('stale-owned-central-page', 'stale-owned-legacy-page');
    await projection.project(projectionSnapshot(event('event-stale-owned', 2), [{ target: companyA, records: [staleOwned] }]));
    await targetA.query(
      `INSERT INTO MetaConnectedPages
       (IdDatabase, IdCompany, Environment, IdAsset, CentralAssetRef, ExternalId, DisplayName, AssetKind, ParentLegacyAssetRef,
        CapabilitiesJson, Status, ProjectionVersion, ProjectionSchemaVersion, ContentHash, IsDeleted, UpdatedAt)
       VALUES (?, ?, ?, 'unknown-legacy-page', 'unknown-central-marker', 'synthetic-unknown', 'Unknown legacy row',
         'FACEBOOK_PAGE', NULL, JSON_ARRAY(), 'ACTIVE', 1, 1, ?, 0, UTC_TIMESTAMP(6))`,
      [companyA.legacyDatabaseId, companyA.legacyCompanyId, companyA.environment, '0'.repeat(64)],
    );

    await targetB.query('DELETE FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?',
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment, failingDestination.legacyAssetRef]);
    const rebuilt = await projection.rebuild({ tenantId, targets: [
      { target: companyA, records: [higher] },
      { target: companyB, records: [samePhysicalIdForOtherCompany] },
      { target: destinationB, records: [failingDestination] },
    ] });
    assert.deepEqual(rebuilt.destinations.map((result) => result.state), ['FAILED', 'SYNCED', 'SYNCED']);
    const rebuildReport = rebuilt.rebuildReports?.[0];
    assert.deepEqual([rebuildReport?.expectedCount, rebuildReport?.actualCount, rebuildReport?.reconciledExtraCount,
      rebuildReport?.ambiguousExtraCount, rebuildReport?.parity], [1, 1, 1, 1, 'AMBIGUOUS']);
    assert.match(rebuildReport?.expectedHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(rebuildReport?.actualHash, rebuildReport?.expectedHash);
    const [ownedExtra] = await targetA.query(
      `SELECT IsDeleted AS deleted, Status AS status FROM MetaConnectedPages
       WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?`,
      [companyA.legacyDatabaseId, companyA.legacyCompanyId, companyA.environment, staleOwned.legacyAssetRef],
    ) as Array<{ deleted: number | string; status: string }>;
    const [unknownExtra] = await targetA.query(
      `SELECT IsDeleted AS deleted, Status AS status FROM MetaConnectedPages
       WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = 'unknown-legacy-page'`,
      [companyA.legacyDatabaseId, companyA.legacyCompanyId, companyA.environment],
    ) as Array<{ deleted: number | string; status: string }>;
    assert.deepEqual([Number(ownedExtra?.deleted), ownedExtra?.status], [1, 'REMOVED']);
    assert.deepEqual([Number(unknownExtra?.deleted), unknownExtra?.status], [0, 'ACTIVE']);

    await targetB.query(
      `UPDATE MetaConnectedPages SET DisplayName = 'Corrupted fixture value'
       WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?`,
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment, failingDestination.legacyAssetRef],
    );
    const checkpoint = await checkpointStore.read(tenantId, destinationKeyHash(destinationB), failingDestination.centralRef);
    assert.ok(checkpoint);
    const destinationAdapter = new MysqlLegacyProjectionDestination(destinationB, targetB);
    const repaired = await destinationAdapter.reconcile({
      target: destinationB, tenantId, records: [failingDestination], knownOwnedCheckpoints: [checkpoint],
      projectionSchemaVersion: 1, destinationKeyHash: destinationKeyHash(destinationB),
    });
    assert.equal(repaired.parity, 'MATCHED');
    assert.equal(repaired.actualCount, 1);
    assert.equal(repaired.actualHash, repaired.expectedHash);
    await targetB.query(
      `UPDATE MetaConnectedPages SET DisplayName = 'Corrupted again'
       WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?`,
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment, failingDestination.legacyAssetRef],
    );
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [failingDestination], projectionSchemaVersion: 1 });
    const [repairedRow] = await targetB.query(
      `SELECT DisplayName AS display_name FROM MetaConnectedPages
       WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?`,
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment, failingDestination.legacyAssetRef],
    ) as Array<{ display_name: string }>;
    assert.equal(repairedRow?.display_name, failingDestination.displayName,
      'apply and reconcile must repair field drift even when the old ContentHash still matches the source');

    const tombstone = record('central-page-c', 'destination-b-page', { sourceVersion: 4, status: 'REMOVED', tombstone: true });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [tombstone], projectionSchemaVersion: 1 });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [failingDestination], projectionSchemaVersion: 1 });
    const [latest] = await targetB.query(
      `SELECT ProjectionVersion AS version, IsDeleted AS deleted, Status AS status
       FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?`,
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment, 'destination-b-page'],
    ) as Array<{ version: number | string; deleted: number | string; status: string }>;
    assert.deepEqual([Number(latest?.version), Number(latest?.deleted), latest?.status], [4, 1, 'REMOVED']);

    const activeFirst = record('central-order-active', 'destination-order-page', { sourceVersion: 3 });
    const tombstoneAfter = record('central-order-active', 'destination-order-page', {
      sourceVersion: 4, status: 'REMOVED', tombstone: true,
    });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [activeFirst], projectionSchemaVersion: 1 });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [tombstoneAfter], projectionSchemaVersion: 1 });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [activeFirst], projectionSchemaVersion: 1 });
    const [orderLatest] = await targetB.query(
      `SELECT ProjectionVersion AS version, Status AS status, IsDeleted AS deleted FROM MetaConnectedPages
       WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ? AND IdAsset = ?`,
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment, activeFirst.legacyAssetRef],
    ) as Array<{ version: number | string; status: string; deleted: number | string }>;
    assert.deepEqual([Number(orderLatest?.version), orderLatest?.status, Number(orderLatest?.deleted)], [4, 'REMOVED', 1],
      'active-then-revoked and revoked-then-stale-active application orders both retain the tombstone');

    const secretColumns = await targetA.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'MetaConnectedPages'
         AND LOWER(column_name) REGEXP 'token|secret|password|dsn|message|payload'`,
    ) as Array<{ column_name: string }>;
    assert.deepEqual(secretColumns, []);
    const checkpoints = await centralSource.query(
      `SELECT state FROM ca_meta_legacy_projection_checkpoints WHERE tenant_id = ?`, [tenantId],
    ) as Array<{ state: string }>;
    assert.ok(checkpoints.some((checkpoint) => checkpoint.state === 'SYNCED'));
    assert.ok(checkpoints.some((checkpoint) => checkpoint.state === 'PENDING' || checkpoint.state === 'SYNCED'));
    assert.notEqual(destinationKeyHash(companyA), destinationKeyHash(companyB));
  } finally {
    if (fixtureReady) {
      await targetA.query('DROP TRIGGER IF EXISTS m5_08_projection_fail_insert').catch(() => undefined);
      await targetB.query('DROP TRIGGER IF EXISTS m5_08_projection_fail_insert').catch(() => undefined);
      await targetA.query('DELETE FROM MetaConnectedPages WHERE IdDatabase IN (?, ?) AND IdCompany IN (?, ?) AND Environment = ?',
        [companyA.legacyDatabaseId, companyB.legacyDatabaseId, companyA.legacyCompanyId, companyB.legacyCompanyId, 'test']).catch(() => undefined);
      await targetB.query('DELETE FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND Environment = ?',
        [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, destinationB.environment]).catch(() => undefined);
      const centralSource = await central.getDataSource().catch(() => undefined);
      if (centralSource) {
        await centralSource.query('DELETE FROM ca_meta_jobs WHERE tenant_id = ? AND correlation_id = ?',
          [tenantId, 'm5-08-integration']).catch(() => undefined);
        await centralSource.query('DELETE FROM ca_meta_outbox_events WHERE tenant_id = ? AND correlation_id = ?',
          [tenantId, 'm5-08-integration']).catch(() => undefined);
        await centralSource.query('DELETE FROM ca_meta_legacy_projection_checkpoints WHERE tenant_id = ?', [tenantId]).catch(() => undefined);
        await centralSource.query('DELETE FROM ca_meta_tenants WHERE id = ?', [tenantId]).catch(() => undefined);
      }
    }
    if (targetA.isInitialized) await targetA.destroy();
    if (targetB.isInitialized) await targetB.destroy();
    await central.close();
  }
});

test('MariaDB source adapter fences tenants, companies, grants and unmapped parents', { skip: !enabled }, async () => {
  const central = new DurableWorkDatabase({ database: {
    host: required('M5_08_TEST_DB_HOST'), port: Number(required('M5_08_TEST_DB_PORT')),
    name: required('M5_08_CENTRAL_DATABASE_NAME'), user: required('M5_08_CENTRAL_API_DATABASE_USER'),
    password: required('M5_08_CENTRAL_API_DATABASE_PASSWORD'), connectTimeoutMs: 5000,
  } } as ApiEnvironment);
  const sourceTenantA = randomUUID();
  const sourceTenantB = randomUUID();
  const appA = randomUUID();
  const appB = randomUUID();
  const authorizationA = randomUUID();
  const authorizationB = randomUUID();
  const authorizationParentless = randomUUID();
  const assetA = randomUUID();
  const assetARevoked = randomUUID();
  const assetB = randomUUID();
  const phoneWithoutMappedParent = randomUUID();
  const wabaWithoutMapping = randomUUID();
  const mapA = randomUUID();
  const mapB = randomUUID();
  const refA = randomUUID();
  const refARevoked = randomUUID();
  const refB = randomUUID();
  const refPhone = randomUUID();
  const sharedDatabaseId = `source-shared-${randomUUID()}`;
  const sourceTargetA: LegacyProjectionTargetKey = {
    legacyDatabaseId: sharedDatabaseId, legacyCompanyId: 'source-company-a', environment: 'test',
  };
  const sourceTargetB: LegacyProjectionTargetKey = {
    legacyDatabaseId: sharedDatabaseId, legacyCompanyId: 'source-company-b', environment: 'test',
  };
  const centralRows = [sourceTenantA, sourceTenantB];
  let centralSource: Awaited<ReturnType<DurableWorkDatabase['getDataSource']>> | undefined;

  try {
    centralSource = await central.getDataSource();
    const jobs = new DurableJobStore(central);
    const outbox = new OutboxService(central, jobs, new DurableLegacyProjectionJobScheduler(jobs));
    const source = new MysqlLegacyProjectionSource(central);
    const timestamp = '2026-11-11 00:00:00.000000';
    await centralSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [sourceTenantA, timestamp, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [sourceTenantB, timestamp, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_tenant_legacy_maps (id, tenant_id, legacy_database_id, legacy_company_id, environment, created_at)
       VALUES (?, ?, ?, 'source-company-a', 'test', ?), (?, ?, ?, 'source-company-b', 'test', ?)`,
      [mapA, sourceTenantA, sharedDatabaseId, timestamp, mapB, sourceTenantB, sharedDatabaseId, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, credential_ref, version, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', NULL, 1, ?, ?), (?, ?, 'META', ?, 'test', NULL, 1, ?, ?)`,
      [appA, sourceTenantA, `synthetic-app-${sourceTenantA}`, timestamp, timestamp,
        appB, sourceTenantB, `synthetic-app-${sourceTenantB}`, timestamp, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_authorizations
       (id, tenant_id, app_configuration_id, provider, environment, provider_authorization_id, authorization_state, version, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 1, ?, ?, ?),
              (?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 1, ?, ?, ?),
              (?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 1, ?, ?, ?)`,
      [authorizationA, sourceTenantA, appA, timestamp, timestamp, timestamp,
        authorizationB, sourceTenantB, appB, timestamp, timestamp, timestamp,
        authorizationParentless, sourceTenantA, appA, timestamp, timestamp, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, external_name, version, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'FACEBOOK_PAGE', 'synthetic-a', 'Tenant A page', 'Tenant A page', 1, ?, ?),
              (?, ?, ?, 'META', 'test', 'FACEBOOK_PAGE', 'synthetic-a-revoked', 'Revoked page', 'Revoked page', 1, ?, ?),
              (?, ?, ?, 'META', 'test', 'FACEBOOK_PAGE', 'synthetic-b', 'Tenant B page', 'Tenant B page', 1, ?, ?),
              (?, ?, ?, 'META', 'test', 'WHATSAPP_BUSINESS_ACCOUNT', 'synthetic-parent', 'Unmapped parent', 'Unmapped parent', 1, ?, ?),
              (?, ?, ?, 'META', 'test', 'WHATSAPP_PHONE_NUMBER', 'synthetic-phone', 'Phone child', 'Phone child', 1, ?, ?)`,
      [assetA, sourceTenantA, appA, timestamp, timestamp,
        assetARevoked, sourceTenantA, appA, timestamp, timestamp,
        assetB, sourceTenantB, appB, timestamp, timestamp,
        wabaWithoutMapping, sourceTenantA, appA, timestamp, timestamp,
        phoneWithoutMappedParent, sourceTenantA, appA, timestamp, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_asset_authorizations
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id, state,
        verification_state, verification_source, verification_ref_hash, verified_at, subscription_state, projection_state,
        version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 'VERIFIED', 'META_API', ?, ?, 'UNKNOWN', 'UNKNOWN', 1, ?, ?),
              (?, ?, ?, ?, 'META', 'test', NULL, 'REVOKED', 'VERIFIED', 'META_API', ?, ?, 'UNKNOWN', 'UNKNOWN', 1, ?, ?),
              (?, ?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 'VERIFIED', 'META_API', ?, ?, 'UNKNOWN', 'UNKNOWN', 1, ?, ?),
              (?, ?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 'VERIFIED', 'META_API', ?, ?, 'UNKNOWN', 'UNKNOWN', 1, ?, ?)`,
      [sourceTenantA, authorizationA, assetA, appA, 'a'.repeat(64), timestamp, timestamp, timestamp,
        sourceTenantA, authorizationA, assetARevoked, appA, 'b'.repeat(64), timestamp, timestamp, timestamp,
        sourceTenantB, authorizationB, assetB, appB, 'c'.repeat(64), timestamp, timestamp, timestamp,
        sourceTenantA, authorizationParentless, phoneWithoutMappedParent, appA, 'd'.repeat(64), timestamp, timestamp, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_asset_legacy_refs (id, tenant_id, asset_id, legacy_database_id, legacy_company_id, environment, legacy_asset_ref, created_at)
       VALUES (?, ?, ?, ?, 'source-company-a', 'test', 'legacy-a', ?),
              (?, ?, ?, ?, 'source-company-a', 'test', 'legacy-a-revoked', ?),
              (?, ?, ?, ?, 'source-company-b', 'test', 'legacy-b', ?),
              (?, ?, ?, ?, 'source-company-a', 'test', 'legacy-phone', ?)`,
      [refA, sourceTenantA, assetA, sharedDatabaseId, timestamp,
        refARevoked, sourceTenantA, assetARevoked, sharedDatabaseId, timestamp,
        refB, sourceTenantB, assetB, sharedDatabaseId, timestamp,
        refPhone, sourceTenantA, phoneWithoutMappedParent, sharedDatabaseId, timestamp],
    );
    await centralSource.query(
      `INSERT INTO ca_meta_asset_grants
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, grant_name, status, source, observed_at, version)
       VALUES (?, ?, ?, ?, 'META', 'test', 'pages_read_engagement', 'GRANTED', 'META_API', ?, 1),
              (?, ?, ?, ?, 'META', 'test', 'pages_manage_metadata', 'REVOKED', 'META_API', ?, 2),
              (?, ?, ?, ?, 'META', 'test', 'pages_show_list', 'GRANTED', 'META_API', ?, 1),
              (?, ?, ?, ?, 'META', 'test', 'pages_show_list', 'GRANTED', 'META_API', ?, 1)`,
      [sourceTenantA, authorizationA, assetA, appA, timestamp,
        sourceTenantA, authorizationA, assetA, appA, timestamp,
        sourceTenantA, authorizationA, assetARevoked, appA, timestamp,
        sourceTenantB, authorizationB, assetB, appB, timestamp],
    );

    const outboxA = await outbox.append(event(`source-a-${randomUUID()}`, 1, sourceTenantA, authorizationA));
    const outboxB = await outbox.append(event(`source-b-${randomUUID()}`, 1, sourceTenantB, authorizationB));
    const parentlessEvent = await outbox.append(event(`source-parent-${randomUUID()}`, 1, sourceTenantA, authorizationParentless));

    assert.equal(await source.loadCurrent(sourceTenantA, outboxB.id, 1), undefined,
      'A cannot load B outbox records by changing the event reference.');
    const snapshotA = await source.loadCurrent(sourceTenantA, outboxA.id, 1);
    assert.ok(snapshotA);
    assert.deepEqual(snapshotA.targets.map((target) => [target.target.legacyDatabaseId, target.target.legacyCompanyId]),
      [[sharedDatabaseId, sourceTargetA.legacyCompanyId]]);
    const activeA = snapshotA.targets[0]?.records.find((record) => record.centralRef === assetA);
    const revokedA = snapshotA.targets[0]?.records.find((record) => record.centralRef === assetARevoked);
    assert.deepEqual(activeA?.capabilities, ['PAGES_READ_ENGAGEMENT']);
    assert.equal(activeA?.status, 'ACTIVE');
    assert.deepEqual(revokedA?.capabilities, []);
    assert.equal(revokedA?.status, 'REMOVED');
    assert.equal(snapshotA.targets[0]?.records.some((record) => record.centralRef === assetB), false);

    const fullA = await source.loadTenantCurrent(sourceTenantA);
    assert.deepEqual(fullA.targets[0]?.records.find((record) => record.centralRef === assetA)?.capabilities,
      ['PAGES_READ_ENGAGEMENT']);
    assert.deepEqual(fullA.targets[0]?.records.find((record) => record.centralRef === assetARevoked)?.capabilities, []);
    await centralSource.query(
      `INSERT INTO ca_meta_asset_relations
       (tenant_id, source_asset_id, target_asset_id, app_configuration_id, provider, environment, relation_type,
        verification_source, verification_ref_hash, verified_at, version)
       VALUES (?, ?, ?, ?, 'META', 'test', 'PHONE_TO_ACCOUNT', 'META_API', ?, ?, 1)`,
      [sourceTenantA, phoneWithoutMappedParent, wabaWithoutMapping, appA, 'e'.repeat(64), timestamp],
    );
    const snapshotB = await source.loadCurrent(sourceTenantB, outboxB.id, 1);
    assert.ok(snapshotB);
    assert.deepEqual(snapshotB.targets.map((target) => target.target), [sourceTargetB]);
    assert.deepEqual(snapshotB.targets[0]?.records.map((record) => record.centralRef), [assetB]);
    assert.deepEqual(snapshotB.targets[0]?.records[0]?.capabilities, ['PAGES_SHOW_LIST']);
    await assert.rejects(source.loadCurrent(sourceTenantA, parentlessEvent.id, 1),
      (error: unknown) => error instanceof Error && error.message.includes('mapping in this destination company'));

    const targetA = new DataSource(connection('DEST_A'));
    await targetA.initialize();
    try {
      const catalog = new AllowlistedLegacyProjectionCatalog([
        { target: sourceTargetA, dataSource: targetA }, { target: sourceTargetB, dataSource: targetA },
      ]);
      const projection = new LegacyProjectionService(new MysqlLegacyProjectionCheckpointStore(central), catalog);
      assert.equal((await projection.project(snapshotA)).destinations[0]?.state, 'SYNCED');
      const targetRows = await targetA.query(
        `SELECT IdCompany AS company, CentralAssetRef AS central_ref, CapabilitiesJson AS capabilities
         FROM MetaConnectedPages WHERE IdDatabase = ? AND Environment = ? AND IdCompany IN (?, ?)`,
        [sharedDatabaseId, 'test', sourceTargetA.legacyCompanyId, sourceTargetB.legacyCompanyId],
      ) as Array<{ company: string; central_ref: string; capabilities: string | object }>;
      assert.equal(targetRows.some((row) => row.central_ref === assetB), false);
      assert.ok(targetRows.every((row) => row.company === sourceTargetA.legacyCompanyId));
    } finally {
      await targetA.query('DELETE FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany IN (?, ?) AND Environment = ?',
        [sharedDatabaseId, sourceTargetA.legacyCompanyId, sourceTargetB.legacyCompanyId, 'test']).catch(() => undefined);
      await targetA.destroy();
    }
  } finally {
    if (centralSource) {
      const tenantIds = [sourceTenantA, sourceTenantB];
      const placeholders = tenantIds.map(() => '?').join(',');
      await centralSource.query(`DELETE FROM ca_meta_jobs WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_outbox_events WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_legacy_projection_checkpoints WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_asset_grants WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_asset_relations WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_asset_authorizations WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_asset_legacy_refs WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_assets WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_authorizations WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_tenant_legacy_maps WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_app_configurations WHERE tenant_id IN (${placeholders})`, tenantIds).catch(() => undefined);
      await centralSource.query(`DELETE FROM ca_meta_tenants WHERE id IN (${placeholders})`, tenantIds).catch(() => undefined);
    }
    await central.close();
  }
});
