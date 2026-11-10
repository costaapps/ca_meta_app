import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { META_SUBSCRIPTIONS_MIGRATION, META_SUBSCRIPTIONS_TABLES } from '../src/database/migrations/meta-subscriptions.js';
import { DOMAIN_TABLES, MIGRATIONS } from '../src/database/migrations/migrations.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { MysqlMetaSubscriptionCatalog } from '../src/meta-subscriptions/mysql-meta-subscription.catalog.js';
import { MysqlMetaSubscriptionStore } from '../src/meta-subscriptions/mysql-meta-subscription.store.js';
import { seedMariaDbFourPhoneWabaFixture } from './fixtures/m4-11-subscriptions.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';

test('M4.11 MariaDB migration/store shares one WABA target across four phone bindings', {
  skip: enabled ? false : 'Run only in the disposable M2/M3 MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  assert.ok(MIGRATIONS.some((migration) => migration.id === META_SUBSCRIPTIONS_MIGRATION.id),
    'the M4.11 migration is registered');
  assert.ok(META_SUBSCRIPTIONS_TABLES.every((table) => DOMAIN_TABLES.includes(table)),
    'all M4.11 tables are registered in the domain table list');

  await deployMigrations(readMigrationEnvironment(process.env));
  const database = new DurableWorkDatabase(validateEnvironment(process.env));
  try {
    const dataSource = await database.getDataSource();
    await dataSource.query("SET time_zone = '+00:00'");
    const migrationRows = await dataSource.query(
      'SELECT state FROM ca_meta_schema_migrations WHERE migration_id = ?',
      [META_SUBSCRIPTIONS_MIGRATION.id],
    ) as Array<{ state: string }>;
    assert.equal(migrationRows[0]?.state, 'APPLIED', 'the focused migration runner applies the subscription schema');

    const fixture = await seedMariaDbFourPhoneWabaFixture(dataSource);
    const catalog = new MysqlMetaSubscriptionCatalog(database);
    const store = new MysqlMetaSubscriptionStore(database);
    const contexts = await Promise.all(fixture.sourceAssetIds.map(async (assetId) => {
      const context = await catalog.resolveByAsset({
        tenantId: fixture.tenantId,
        appConfigurationId: fixture.appConfigurationId,
        environment: 'test',
        assetId,
        authorizationId: fixture.authorizationId,
      });
      assert.ok(context, 'each synthetic phone resolves through its verified PHONE_TO_ACCOUNT relation');
      assert.equal(context.targetAssetId, fixture.targetAssetId);
      assert.equal(context.kind, 'WHATSAPP_BUSINESS_ACCOUNT');
      return context;
    }));
    const ambiguousContext = await catalog.resolveByAsset({
      tenantId: fixture.tenantId,
      appConfigurationId: fixture.appConfigurationId,
      environment: 'test',
      assetId: fixture.sourceAssetIds[0]!,
    });
    assert.equal(ambiguousContext, undefined, 'the real catalog fails closed when one phone has two eligible grants and none is selected');
    const secondGrantContext = await catalog.resolveByAsset({
      tenantId: fixture.tenantId,
      appConfigurationId: fixture.appConfigurationId,
      environment: 'test',
      assetId: fixture.sourceAssetIds[0]!,
      authorizationId: fixture.secondAuthorizationId,
    });
    assert.ok(secondGrantContext, 'the real catalog resolves the explicitly selected second grant');
    assert.equal(secondGrantContext.authorizationId, fixture.secondAuthorizationId);
    assert.equal(secondGrantContext.targetAssetId, fixture.targetAssetId);

    const bindingInput = (context: (typeof contexts)[number]) => ({
      ...context,
      desiredFields: Object.freeze([]),
      actorRef: 'm4-11-mariadb-fixture',
      correlationId: randomUUID(),
    });
    const concurrentResults = await Promise.all(contexts.map((context) => store.ensureBinding(bindingInput(context))));
    assert.equal(new Set(concurrentResults.map((result) => result.targetId)).size, 1,
      'concurrent phone upserts converge on one physical WABA target');
    await store.ensureBinding(bindingInput(secondGrantContext));

    const beforeIdempotentRetry = await dataSource.query(
      `SELECT id, desired_state, desired_fields, version FROM ca_meta_subscription_targets
       WHERE tenant_id = ? AND app_configuration_id = ? AND environment = 'test' AND target_asset_id = ?`,
      [fixture.tenantId, fixture.appConfigurationId, fixture.targetAssetId],
    ) as Array<{ id: string; desired_state: string; desired_fields: string; version: string | number }>;
    assert.equal(beforeIdempotentRetry.length, 1);
    assert.equal(beforeIdempotentRetry[0]?.desired_state, 'SUBSCRIBED');
    assert.deepEqual(JSON.parse(beforeIdempotentRetry[0]?.desired_fields ?? 'null'), []);
    const firstTargetVersion = Number(beforeIdempotentRetry[0]?.version);

    await Promise.all([...contexts, secondGrantContext].map((context) => store.ensureBinding(bindingInput(context))));
    const [targetsAfterRetry, bindingsAfterRetry] = await Promise.all([
      dataSource.query(
        `SELECT id, desired_state, desired_fields, version FROM ca_meta_subscription_targets
         WHERE tenant_id = ? AND app_configuration_id = ? AND environment = 'test' AND target_asset_id = ?`,
        [fixture.tenantId, fixture.appConfigurationId, fixture.targetAssetId],
      ) as Promise<Array<{ id: string; desired_state: string; desired_fields: string; version: string | number }>>,
      dataSource.query(
        `SELECT asset_id, binding_state FROM ca_meta_subscription_bindings
         WHERE tenant_id = ? AND target_id = ? ORDER BY asset_id`,
        [fixture.tenantId, beforeIdempotentRetry[0]!.id],
      ) as Promise<Array<{ asset_id: string; binding_state: string }>>,
    ]);
    assert.equal(targetsAfterRetry.length, 1, 'repeated upserts do not duplicate the target row');
    assert.equal(Number(targetsAfterRetry[0]?.version), firstTargetVersion,
      'repeated upserts with unchanged desired state do not advance the target version');
    assert.equal(bindingsAfterRetry.length, 5, 'four phones plus a second grant for one phone remain unique after repeated upserts');
    assert.ok(bindingsAfterRetry.every((binding) => binding.binding_state === 'ACTIVE'));

    const removed = await store.removeBinding({
      ...contexts[0]!,
      actorRef: 'm4-11-mariadb-fixture',
      correlationId: randomUUID(),
    });
    assert.equal(removed.desiredState, 'SUBSCRIBED',
      'disconnect preserves external subscription intent while other eligible bindings remain');
    assert.equal(removed.lastErrorCode, null,
      'the shared target does not claim remote unsubscribe is needed while consumers remain');
    assert.equal(removed.bindings.filter((binding) => binding.state === 'ACTIVE').length, 4);
    assert.equal(removed.bindings.find((binding) => binding.assetId === contexts[0]!.sourceAssetId &&
      binding.authorizationId === fixture.authorizationId)?.state, 'REMOVED');
    assert.equal(removed.bindings.find((binding) => binding.assetId === contexts[0]!.sourceAssetId &&
      binding.authorizationId === fixture.secondAuthorizationId)?.state, 'ACTIVE',
    'disconnecting the selected grant preserves the other eligible grant for the same phone');

    const [persistedTarget, persistedActiveBindings] = await Promise.all([
      dataSource.query(
        `SELECT desired_state, reconcile_state, last_safe_reason_code FROM ca_meta_subscription_targets
         WHERE tenant_id = ? AND id = ?`,
        [fixture.tenantId, removed.targetId],
      ) as Promise<Array<{ desired_state: string; reconcile_state: string; last_safe_reason_code: string | null }>>,
      dataSource.query(
        `SELECT COUNT(*) AS count FROM ca_meta_subscription_bindings
         WHERE tenant_id = ? AND target_id = ? AND binding_state = 'ACTIVE'`,
        [fixture.tenantId, removed.targetId],
      ) as Promise<Array<{ count: string | number }>>,
    ]);
    assert.equal(persistedTarget[0]?.desired_state, 'SUBSCRIBED');
    assert.equal(persistedTarget[0]?.last_safe_reason_code, null);
    assert.equal(Number(persistedActiveBindings[0]?.count ?? 0), 4,
      'the committed shared target retains the other three phones and the second grant for the selected phone');

    const auditRows = await dataSource.query(
      `SELECT reason_code FROM ca_meta_subscription_audit
       WHERE tenant_id = ? AND target_id = ? ORDER BY created_at, id`,
      [fixture.tenantId, removed.targetId],
    ) as Array<{ reason_code: string }>;
    assert.ok(auditRows.some((row) => row.reason_code === 'SHARED_CONSUMER_REMAINS'));
    assert.ok(!auditRows.some((row) => row.reason_code === 'REMOTE_UNSUBSCRIBE_NOT_CONFIRMED'));
    // This fixture constructs only the catalog and SQL store; no Graph client or HTTP transport is involved.
  } finally {
    await database.close();
  }
});
