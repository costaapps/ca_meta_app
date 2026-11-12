import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import type { ApiEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import { OutboxService } from '../src/outbox/outbox-service.js';
import { AutomationConfigVersionConflictError } from '../src/automation-config/automation-config.types.js';
import { MysqlAutomationConfigRepository } from '../src/automation-config/mysql-automation-config.repository.js';

const enabled = process.env.M5_05_AUTOMATION_TEST === '1';
const tenantId = '90000000-0000-4000-8000-000000000059';
const appConfigurationId = '90000000-0000-4000-8000-000000000051';
const firstAssetId = '90000000-0000-4000-8000-000000000052';
const secondAssetId = '90000000-0000-4000-8000-000000000053';
const actorId = '90000000-0000-4000-8000-000000000054';
const requestId = 'req-m5-05-synthetic-0001';
const message = 'M5.05 synthetic text never copied to the outbox';

test('MariaDB transaction keeps asset settings isolated, rejects stale versions and stores only intent metadata in the outbox', { skip: !enabled }, async () => {
  const required = [
    'API_DATABASE_HOST', 'API_DATABASE_PORT', 'API_DATABASE_NAME', 'API_DATABASE_USER', 'API_DATABASE_PASSWORD',
  ] as const;
  const missing = required.filter((name) => !process.env[name]);
  assert.deepEqual(missing, [], 'scoped API database environment must be provided for the isolated integration test');

  const environment = {
    database: {
      host: process.env.API_DATABASE_HOST!,
      port: Number(process.env.API_DATABASE_PORT),
      name: process.env.API_DATABASE_NAME!,
      user: process.env.API_DATABASE_USER!,
      password: process.env.API_DATABASE_PASSWORD!,
      connectTimeoutMs: 5000,
    },
  } as ApiEnvironment;
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();

  try {
    await runner.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`, [tenantId],
    );
    await runner.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, credential_ref, version, created_at, updated_at)
       VALUES (?, ?, 'META', 'm5-05-synthetic-app', 'test', NULL, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [appConfigurationId, tenantId],
    );
    for (const [assetId, externalId] of [[firstAssetId, 'm5-05-number-1'], [secondAssetId, 'm5-05-number-2']] as const) {
      await runner.query(
        `INSERT INTO ca_meta_assets
         (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id,
          display_name, external_name, version, created_at, updated_at)
         VALUES (?, ?, ?, 'META', 'test', 'WHATSAPP_PHONE_NUMBER', ?, 'Synthetic M5.05 asset',
          'Synthetic M5.05 asset', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [assetId, tenantId, appConfigurationId, externalId],
      );
    }

    // Repository and outbox transactions share the test-owned transaction. Rolling it back
    // removes every synthetic fixture and append-only audit row at the end of this test.
    const scopedDataSource = {
      query: (sql: string, parameters?: readonly unknown[]) => runner.manager.query(sql, parameters),
      transaction: async <T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> => operation(runner.manager),
    } as unknown as DataSource;
    const scopedDatabase = {
      getDataSource: async () => scopedDataSource,
    } as unknown as DurableWorkDatabase;
    const jobs = new DurableJobStore(scopedDatabase);
    const outbox = new OutboxService(scopedDatabase, jobs);
    const repository = new MysqlAutomationConfigRepository(scopedDatabase, outbox);

    const saved = await repository.update({
      tenantId, assetId: firstAssetId, actorId, requestId,
      patch: { version: 0, privateWelcomeMessage: message },
    });
    const separateAsset = await repository.read({ tenantId, assetId: secondAssetId });
    assert.equal(saved.version, 1);
    assert.equal(saved.privateWelcomeMessage, message);
    assert.equal(saved.projectionState, 'PENDING');
    assert.equal(separateAsset.version, 0);
    assert.equal(separateAsset.privateWelcomeMessage, null);

    await assert.rejects(repository.update({
      tenantId, assetId: firstAssetId, actorId, requestId: `${requestId}-stale`,
      patch: { version: 0, privateWelcomeMessage: 'stale synthetic value' },
    }), AutomationConfigVersionConflictError);

    const historyRows = await runner.manager.query(
      `SELECT version, changed_fields_json FROM ca_meta_asset_automation_config_versions
       WHERE tenant_id = ? AND asset_id = ? ORDER BY version`, [tenantId, firstAssetId],
    ) as Array<{ version: number | string; changed_fields_json: string | readonly string[] }>;
    assert.equal(historyRows.length, 1);
    assert.equal(Number(historyRows[0]?.version), 1);
    const changedFields = typeof historyRows[0]?.changed_fields_json === 'string'
      ? JSON.parse(historyRows[0].changed_fields_json) as readonly string[]
      : historyRows[0]?.changed_fields_json;
    assert.deepEqual(changedFields, ['privateWelcomeMessage']);

    const outboxRows = await runner.manager.query(
      `SELECT event_type, payload_json FROM ca_meta_outbox_events WHERE tenant_id = ? ORDER BY event_id`, [tenantId],
    ) as Array<{ event_type: string; payload_json: string | object }>;
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0]?.event_type, 'automation.config.changed');
    const payload = typeof outboxRows[0]?.payload_json === 'string'
      ? outboxRows[0].payload_json : JSON.stringify(outboxRows[0]?.payload_json);
    assert.ok(payload);
    assert.equal(payload.includes(message), false);
    assert.match(payload, /AUTOMATION_CONFIG_CHANGED/);

    const jobsRows = await runner.manager.query(
      'SELECT COUNT(*) AS count FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = \'OUTBOX_DELIVER\'', [tenantId],
    ) as Array<{ count: number | string }>;
    assert.equal(Number(jobsRows[0]?.count), 1);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    await database.close();
  }
});
