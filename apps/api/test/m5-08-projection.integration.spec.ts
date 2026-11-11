import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DataSource } from 'typeorm';
import type { ApiEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import { OutboxService } from '../src/outbox/outbox-service.js';
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

function event(eventId: string, aggregateVersion: number): OutboxEventEnvelope {
  return Object.freeze({
    eventId, tenantRef: tenantId, schemaVersion: 1, eventType: 'connection.changed', aggregateRef: 'connection-ref',
    aggregateVersion, actor: { kind: 'SYSTEM' as const, ref: 'm5-08-integration' }, correlationId: 'm5-08-integration',
    causationId: null, createdAt: '2026-11-11T00:00:00.000Z', enqueuedAt: '2026-11-11T00:00:00.000Z',
    data: { kind: 'CONNECTION_CHANGED', connectionRef: 'connection-ref', status: 'ACTIVE', observedAt: '2026-11-11T00:00:00.000Z' },
  });
}

const fixtureDdl = `CREATE TABLE IF NOT EXISTS MetaConnectedPages (
  IdDatabase VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  IdCompany VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
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
  PRIMARY KEY (IdDatabase, IdCompany, IdAsset)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;

test('M5.08 MariaDB fault injection: duplicate/order, company isolation, independent destination retry and metadata-only writes', { skip: !enabled }, async (t) => {
  const centralConfig = connection('CENTRAL');
  const aConfig = connection('DEST_A');
  const bConfig = connection('DEST_B');
  const centralName = required('M5_08_CENTRAL_DATABASE_NAME');
  const aName = required('M5_08_DEST_A_DATABASE_NAME');
  const bName = required('M5_08_DEST_B_DATABASE_NAME');
  assert.equal(centralName, 'ca_meta_m5_08', 'Central integration database must be the dedicated synthetic schema.');
  assert.equal(aName, 'ca_meta_m5_08_dest_a', 'Destination A must be the dedicated synthetic schema.');
  assert.equal(bName, 'ca_meta_m5_08_dest_b', 'Destination B must be the dedicated synthetic schema.');

  const central = new DurableWorkDatabase({ database: {
    host: centralConfig.host, port: centralConfig.port, name: centralConfig.database,
    user: centralConfig.username, password: centralConfig.password, connectTimeoutMs: 5000,
  } } as ApiEnvironment);
  const targetA = new DataSource(aConfig);
  const targetB = new DataSource(bConfig);
  const destinationCatalog = new AllowlistedLegacyProjectionCatalog([
    { target: companyA, dataSource: targetA }, { target: companyB, dataSource: targetA }, { target: destinationB, dataSource: targetB },
  ]);
  const projection = new LegacyProjectionService(new MysqlLegacyProjectionCheckpointStore(central), destinationCatalog);
  let fixtureReady = false;

  try {
    const centralSource = await central.getDataSource();
    await targetA.initialize();
    await targetB.initialize();
    const [{ database: actualCentral }] = await centralSource.query('SELECT DATABASE() AS database') as Array<{ database: string }>;
    const [{ database: actualA }] = await targetA.query('SELECT DATABASE() AS database') as Array<{ database: string }>;
    const [{ database: actualB }] = await targetB.query('SELECT DATABASE() AS database') as Array<{ database: string }>;
    assert.deepEqual([actualCentral, actualA, actualB], [centralName, aName, bName]);

    await targetA.query(fixtureDdl);
    await targetB.query(fixtureDdl);
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
    assert.equal(appended.duplicate, false);
    assert.equal(duplicateAppend.duplicate, true);
    const queued = await centralSource.query(
      `SELECT job_type FROM ca_meta_jobs WHERE tenant_id = ? AND correlation_id = ? ORDER BY job_type`,
      [tenantId, 'm5-08-integration'],
    ) as Array<{ job_type: string }>;
    assert.deepEqual(queued.map((job) => job.job_type), ['OUTBOX_DELIVER', 'PROJECTION_RECONCILE']);
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
       FROM MetaConnectedPages WHERE IdDatabase = ? AND IdAsset = ? ORDER BY IdCompany`,
      [companyA.legacyDatabaseId, 'same-legacy-page'],
    ) as Array<{ company: string; version: number | string; display_name: string }>;
    assert.deepEqual(companyRows.map((row) => [row.company, Number(row.version)]), [['company-a', 3], ['company-b', 3]]);
    assert.notEqual(companyRows[0]?.display_name, companyRows[1]?.display_name);

    await targetB.query('DROP TRIGGER m5_08_projection_fail_insert');
    const retry = await projection.project({ tenantId, event: event('event-retry', 1), targets: [
      { target: destinationB, records: [failingDestination] },
    ] });
    assert.equal(retry.destinations[0]?.state, 'SYNCED');
    assert.equal(retry.destinations[0]?.applied, 1);

    await targetB.query('DELETE FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND IdAsset = ?',
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, failingDestination.legacyAssetRef]);
    const rebuilt = await projection.rebuild({ tenantId, targets: [
      { target: companyA, records: [higher] },
      { target: companyB, records: [samePhysicalIdForOtherCompany] },
      { target: destinationB, records: [failingDestination] },
    ] });
    assert.deepEqual(rebuilt.destinations.map((result) => result.applied), [1, 1, 1]);

    const destinationAdapter = new MysqlLegacyProjectionDestination(destinationB, targetB);
    const tombstone = record('central-page-c', 'destination-b-page', { sourceVersion: 4, status: 'REMOVED', tombstone: true });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [tombstone], projectionSchemaVersion: 1 });
    await destinationAdapter.apply({ target: destinationB, tenantId, records: [failingDestination], projectionSchemaVersion: 1 });
    const [latest] = await targetB.query(
      `SELECT ProjectionVersion AS version, IsDeleted AS deleted, Status AS status
       FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND IdAsset = ?`,
      [destinationB.legacyDatabaseId, destinationB.legacyCompanyId, 'destination-b-page'],
    ) as Array<{ version: number | string; deleted: number | string; status: string }>;
    assert.deepEqual([Number(latest?.version), Number(latest?.deleted), latest?.status], [4, 1, 'REMOVED']);

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
      await targetA.query('DELETE FROM MetaConnectedPages WHERE IdDatabase IN (?, ?) AND IdCompany IN (?, ?)',
        [companyA.legacyDatabaseId, companyB.legacyDatabaseId, companyA.legacyCompanyId, companyB.legacyCompanyId]).catch(() => undefined);
      await targetB.query('DELETE FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ?',
        [destinationB.legacyDatabaseId, destinationB.legacyCompanyId]).catch(() => undefined);
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
