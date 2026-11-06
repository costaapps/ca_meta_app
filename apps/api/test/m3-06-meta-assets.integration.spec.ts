import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { META_ASSETS_MIGRATION } from '../src/database/migrations/meta-assets.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { validateEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import { OutboxService } from '../src/outbox/outbox-service.js';
import { MysqlMetaAssetsRepository } from '../src/meta-assets/mysql-meta-assets.repository.js';
import { AuditEventWriter } from '../src/privacy/audit.service.js';
import {
  issueVerifiedMetaEvidence,
  type AssetClaimInput,
  type AuthorizationUpsertCommand,
} from '../src/meta-assets/meta-assets.types.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';
const timestamp = '2026-10-30T12:00:00.000Z';
const mysqlTimestamp = '2026-10-30 12:00:00.000000';
const evidence = () => issueVerifiedMetaEvidence({
  source: 'META_API',
  observedAt: timestamp,
  observationRef: `synthetic-provider-observation-${randomUUID()}`,
});

function command(input: {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly authorizationId: string;
  readonly externalId?: string;
  readonly grants?: readonly string[];
  readonly includeInstagramRelation?: boolean;
  readonly state?: AuthorizationUpsertCommand['state'];
}): AuthorizationUpsertCommand {
  const proof = evidence();
  const assets: AssetClaimInput[] = input.externalId === undefined ? [] : [{
    kind: 'FACEBOOK_PAGE',
    externalId: input.externalId,
    externalName: 'Synthetic Page',
    evidence: proof,
    ...(input.grants === undefined ? {} : { grants: input.grants }),
  }];
  if (input.externalId !== undefined && input.includeInstagramRelation) {
    assets.push({
      kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
      externalId: 'ig-business-synthetic-001',
      externalName: 'Synthetic Instagram',
      evidence: proof,
      relations: [{ type: 'INSTAGRAM_TO_PAGE', targetExternalId: input.externalId }],
    });
  }
  return {
    tenantId: input.tenantId,
    authorizationId: input.authorizationId,
    appConfigurationId: input.appConfigurationId,
    provider: 'META',
    environment: 'test',
    state: input.state ?? 'ACTIVE',
    grantedScopes: ['pages_show_list'],
    evidence: proof,
    assets,
    actor: { kind: 'SERVICE', ref: 'm3-06-mariadb-test' },
    correlationId: `m3-06-correlation-${randomUUID()}`,
    observedAt: timestamp,
  };
}

test('M3.06 MariaDB tenant-safe asset upserts, constraints, string IDs and outbox rollback', {
  skip: enabled ? false : 'Run in the disposable M2.05/M3 MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const database = new DurableWorkDatabase(validateEnvironment(process.env));
  const dataSource = await database.getDataSource();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const appA = randomUUID();
  const appB = randomUUID();
  const concurrentAuthorization = randomUUID();
  const sharedAuthorization = randomUUID();
  const foreignAuthorization = randomUUID();
  const rollbackAuthorization = randomUUID();
  const externalId = '90071992547409931234567890';
  const outboxId = `meta-authorization:${rollbackAuthorization}:1`;

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    const applied = await dataSource.query(
      'SELECT state FROM ca_meta_schema_migrations WHERE migration_id = ?',
      [META_ASSETS_MIGRATION.id],
    ) as Array<{ state: string }>;
    assert.equal(applied[0]?.state, 'APPLIED', 'the disposable profile must apply M3.06 v6');

    await dataSource.query(
      'INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at) VALUES (?, \'ACTIVE\', 1, ?, ?), (?, \'ACTIVE\', 1, ?, ?)',
      [tenantA, mysqlTimestamp, mysqlTimestamp, tenantB, mysqlTimestamp, mysqlTimestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', 'm3-06-synthetic-app', 'test', ?, ?),
              (?, ?, 'META', 'm3-06-synthetic-app', 'test', ?, ?)`,
      [appA, tenantA, mysqlTimestamp, mysqlTimestamp, appB, tenantB, mysqlTimestamp, mysqlTimestamp],
    );

    const jobs = new DurableJobStore(database);
    const outbox = new OutboxService(database, jobs);
    const repository = new MysqlMetaAssetsRepository(database, outbox, new AuditEventWriter(database));

    const concurrentResults = await Promise.all([
      repository.upsert(command({ tenantId: tenantA, appConfigurationId: appA, authorizationId: concurrentAuthorization, externalId, grants: ['pages_read_engagement'] })),
      repository.upsert(command({ tenantId: tenantA, appConfigurationId: appA, authorizationId: concurrentAuthorization, externalId, grants: ['pages_read_engagement'] })),
    ]);
    assert.deepEqual(concurrentResults.map((result) => result.version).sort(), [1, 2]);
    const connectionAudit = await dataSource.query(
      `SELECT action, actor_ref_hash FROM ca_meta_audit_events WHERE tenant_id = ? AND target_ref = ? ORDER BY created_at`,
      [tenantA, concurrentAuthorization],
    ) as Array<{ action: string; actor_ref_hash: string }>;
    assert.deepEqual(connectionAudit.map((row) => row.action).sort(), ['AUTHORIZATION_CONNECTED', 'AUTHORIZATION_REAUTHORIZED']);
    assert.ok(connectionAudit.every((row) => row.actor_ref_hash !== 'm3-06-mariadb-test'));
    const firstAssetRef = concurrentResults[0]?.assets[0]?.assetRef;
    assert.ok(firstAssetRef);
    assert.equal(concurrentResults[1]?.assets[0]?.assetRef, firstAssetRef);

    const sharedResult = await repository.upsert(command({
      tenantId: tenantA, appConfigurationId: appA, authorizationId: sharedAuthorization, externalId,
      grants: ['pages_manage_metadata'], includeInstagramRelation: true,
    }));
    assert.equal(sharedResult.assets[0]?.assetRef, firstAssetRef, 'a second authorization in the tenant reuses the same asset');
    assert.equal(sharedResult.assets[1]?.verificationState, 'VERIFIED');
    await repository.upsert(command({
      tenantId: tenantA, appConfigurationId: appA, authorizationId: concurrentAuthorization,
      state: 'DISCONNECTED',
    }));
    const disconnectAudit = await dataSource.query(
      `SELECT action FROM ca_meta_audit_events WHERE tenant_id = ? AND target_ref = ? ORDER BY created_at`,
      [tenantA, concurrentAuthorization],
    ) as Array<{ action: string }>;
    assert.equal(disconnectAudit.at(-1)?.action, 'AUTHORIZATION_DISCONNECTED');
    const assetRows = await dataSource.query(
      'SELECT id, external_id FROM ca_meta_assets WHERE tenant_id = ? AND app_configuration_id = ? AND asset_kind = \'FACEBOOK_PAGE\' AND external_id = ?',
      [tenantA, appA, externalId],
    ) as Array<{ id: string; external_id: string }>;
    assert.equal(assetRows.length, 1, 'concurrent and repeated upserts do not duplicate the tenant asset');
    assert.equal(assetRows[0]?.external_id, externalId, 'external IDs above 2^53 remain exact strings');
    const links = await dataSource.query(
      'SELECT authorization_id FROM ca_meta_asset_authorizations WHERE tenant_id = ? AND asset_id = ?',
      [tenantA, firstAssetRef],
    ) as Array<{ authorization_id: string }>;
    assert.equal(links.length, 2, 'the same tenant asset may be linked to two authorizations');
    const grantedScopes = await dataSource.query(
      'SELECT scope_name FROM ca_meta_authorization_scopes WHERE tenant_id = ? AND authorization_id = ? AND status = \'GRANTED\'',
      [tenantA, concurrentAuthorization],
    ) as Array<{ scope_name: string }>;
    assert.deepEqual(grantedScopes.map((row) => row.scope_name), ['pages_show_list']);
    const assetGrants = await dataSource.query(
      'SELECT grant_name FROM ca_meta_asset_grants WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND status = \'GRANTED\'',
      [tenantA, concurrentAuthorization, firstAssetRef],
    ) as Array<{ grant_name: string }>;
    assert.deepEqual(assetGrants.map((row) => row.grant_name), ['pages_read_engagement']);
    const relationRows = await dataSource.query(
      'SELECT relation_type, target_asset_id FROM ca_meta_asset_relations WHERE tenant_id = ? AND source_asset_id = ?',
      [tenantA, sharedResult.assets[1]?.assetRef],
    ) as Array<{ relation_type: string; target_asset_id: string }>;
    assert.deepEqual(relationRows, [{ relation_type: 'INSTAGRAM_TO_PAGE', target_asset_id: firstAssetRef }]);

    await repository.upsert(command({
      tenantId: tenantA, appConfigurationId: appA, authorizationId: concurrentAuthorization, externalId,
    }));
    const preservedGrants = await dataSource.query(
      'SELECT grant_name FROM ca_meta_asset_grants WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND status = \'GRANTED\'',
      [tenantA, concurrentAuthorization, firstAssetRef],
    ) as Array<{ grant_name: string }>;
    assert.deepEqual(preservedGrants.map((row) => row.grant_name), ['pages_read_engagement'], 'omitted grants preserve the current grant set');
    const omittedHistory = await dataSource.query(
      'SELECT snapshot_json FROM ca_meta_asset_history WHERE tenant_id = ? AND asset_id = ? ORDER BY version DESC LIMIT 1',
      [tenantA, firstAssetRef],
    ) as Array<{ snapshot_json: string | { grants: readonly string[] } }>;
    const omittedSnapshot = typeof omittedHistory[0]?.snapshot_json === 'string'
      ? JSON.parse(omittedHistory[0].snapshot_json) as { grants: readonly string[] }
      : omittedHistory[0]?.snapshot_json;
    assert.deepEqual(omittedSnapshot?.grants, ['pages_read_engagement'], 'history records the preserved current grant set');

    await repository.upsert(command({
      tenantId: tenantA, appConfigurationId: appA, authorizationId: concurrentAuthorization, externalId, grants: [],
    }));
    const revokedGrants = await dataSource.query(
      'SELECT grant_name FROM ca_meta_asset_grants WHERE tenant_id = ? AND authorization_id = ? AND asset_id = ? AND status = \'GRANTED\'',
      [tenantA, concurrentAuthorization, firstAssetRef],
    ) as Array<{ grant_name: string }>;
    assert.deepEqual(revokedGrants, [], 'an explicit empty grant set revokes all grants');
    const revokedHistory = await dataSource.query(
      'SELECT snapshot_json FROM ca_meta_asset_history WHERE tenant_id = ? AND asset_id = ? ORDER BY version DESC LIMIT 1',
      [tenantA, firstAssetRef],
    ) as Array<{ snapshot_json: string | { grants: readonly string[] } }>;
    const revokedSnapshot = typeof revokedHistory[0]?.snapshot_json === 'string'
      ? JSON.parse(revokedHistory[0].snapshot_json) as { grants: readonly string[] }
      : revokedHistory[0]?.snapshot_json;
    assert.deepEqual(revokedSnapshot?.grants, [], 'history records the explicit revocation');
    const readModels = await repository.listReadModels({ tenantId: tenantA, appConfigurationId: appA, environment: 'test' });
    const listedAsset = readModels.flatMap((authorization) => authorization.assets).find((asset) => asset.assetRef === firstAssetRef);
    assert.equal(listedAsset?.externalId, externalId);

    const foreignResult = await repository.upsert(command({
      tenantId: tenantB, appConfigurationId: appB, authorizationId: foreignAuthorization, externalId,
    }));
    assert.equal(foreignResult.quarantinedCount, 1);
    assert.equal(foreignResult.assets[0]?.verificationState, 'QUARANTINED');
    const foreignAssets = await dataSource.query(
      'SELECT id FROM ca_meta_assets WHERE tenant_id = ? AND app_configuration_id = ? AND asset_kind = \'FACEBOOK_PAGE\' AND external_id = ?',
      [tenantB, appB, externalId],
    ) as Array<{ id: string }>;
    assert.equal(foreignAssets.length, 0, 'cross-tenant claims never create or reassign an asset');
    await assert.rejects(dataSource.query(
      `INSERT INTO ca_meta_asset_authorizations
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id,
        state, verification_state, verification_source, verification_ref_hash, verified_at,
        subscription_state, projection_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', NULL, 'ACTIVE', 'CLAIMED', 'BROWSER_CLAIM', NULL, NULL,
               'UNKNOWN', 'UNKNOWN', 1, ?, ?)`,
      [tenantB, foreignAuthorization, firstAssetRef, appB, mysqlTimestamp, mysqlTimestamp],
    ), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code?: string }).code === 'ER_NO_REFERENCED_ROW_2');

    const rollbackOutbox = {
      async appendWithin(manager: Parameters<OutboxService['appendWithin']>[0], event: unknown): Promise<void> {
        await outbox.appendWithin(manager, event);
        throw new Error('synthetic failure after outbox staging');
      },
    };
    const rollbackRepository = new MysqlMetaAssetsRepository(database, rollbackOutbox, new AuditEventWriter(database));
    await assert.rejects(
      rollbackRepository.upsert(command({ tenantId: tenantA, appConfigurationId: appA, authorizationId: rollbackAuthorization })),
      /synthetic failure after outbox staging/,
    );
    const rolledBackRows = await dataSource.query(
      'SELECT id FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ?',
      [tenantA, rollbackAuthorization],
    ) as Array<{ id: string }>;
    const rolledBackEvents = await dataSource.query(
      'SELECT id FROM ca_meta_outbox_events WHERE tenant_id = ? AND event_id = ?',
      [tenantA, outboxId],
    ) as Array<{ id: string }>;
    assert.equal(rolledBackRows.length, 0, 'failed transaction rolls back the authorization');
    assert.equal(rolledBackEvents.length, 0, 'failed transaction publishes no outbox row');
  } finally {
    await database.close();
  }
});
