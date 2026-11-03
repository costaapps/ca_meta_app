import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CredentialKeyRingConfiguration, validateEnvironment } from '../src/config/environment.js';
import { ConfiguredCredentialKeyProvider } from '../src/credentials/credential-key-provider.js';
import { CredentialInspectionWorker, CredentialLifecycleScheduler, CredentialReauthIntentReader,
  CredentialReplacementCasService } from '../src/credentials/credential-lifecycle.service.js';
import type { CredentialInspectionPort, CredentialInspectionBinding, CredentialLifecyclePolicyPort,
  CredentialLifecycleSecretPort } from '../src/credentials/credential-lifecycle.types.js';
import { CredentialVaultService } from '../src/credentials/credential-vault.service.js';
import type { CredentialVaultAuthorizationPort } from '../src/credentials/credential-vault.types.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MysqlCredentialVaultRepository } from '../src/credentials/mysql-credential-vault.repository.js';
import { issueVerifiedMetaEvidence, MetaAssetsConflictError } from '../src/meta-assets/meta-assets.types.js';
import { MysqlMetaAssetsRepository } from '../src/meta-assets/mysql-meta-assets.repository.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../src/jobs/job-store.js';
import type { JobType } from '../src/jobs/event-validation.js';
import { AuditEventWriter } from '../src/privacy/audit.service.js';
import { DurableWorker, type JobFinalizer, type JobHandler } from '../src/worker/durable-worker.js';

const enabled = process.env.M3_09_TEST === '1';
const timestamp = '2026-11-03 12:00:00.000000';

class SyntheticVaultAuthorization implements CredentialVaultAuthorizationPort {
  async authorize(): Promise<void> {}
}

test('M3.09 MariaDB v13 schema, due lease/idempotent job, reauth impact dedupe, and stale-version fencing', {
  skip: enabled ? false : 'Run in the disposable M2.05 MariaDB profile with M3_09_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const keyState = await dataSource.query(
    'SELECT active_key_version FROM ca_meta_credential_vault_key_state WHERE singleton_id = 1',
  ) as Array<{ active_key_version: string }>;
  const configuredKeyV3 = process.env.M3_TEST_CREDENTIAL_KEY_V3;
  if (configuredKeyV3 !== undefined) assert.match(configuredKeyV3, /^[0-9a-f]{64}$/i);
  const activeKeyVersion = keyState[0]?.active_key_version;
  if (activeKeyVersion !== undefined) {
    assert.ok(configuredKeyV3, 'the shared MariaDB profile supplies the active synthetic vault key outside Git');
    assert.equal(activeKeyVersion, 'm3-test-v3', 'the M3.07/M3.09 integration profile shares its active test key version');
  }
  const credentialKey = configuredKeyV3 === undefined ? randomBytes(32) : Buffer.from(configuredKeyV3, 'hex');
  // The M2.05 profile runs M3.07 first, so both fixtures use the same key bytes/version for its persisted rows.
  const keyVersion = activeKeyVersion ?? (configuredKeyV3 === undefined ? `m3-09-${randomUUID().slice(0, 8)}` : 'm3-test-v3');
  const secretMarker = `m3-09-synthetic-${randomUUID()}`;
  const replacementMarker = `m3-09-replacement-${randomUUID()}`;
  const tenantId = randomUUID();
  const appConfigurationId = randomUUID();
  const authorizationId = randomUUID();
  const bindings = [randomUUID(), randomUUID()].map((credentialId) => ({
    tenantId, credentialId, authorizationId, appConfigurationId, provider: 'META' as const,
    environment: 'test', flowVariant: 'INSTAGRAM' as const, authVariant: 'INSTAGRAM_LOGIN' as const, family: 'SYNTHETIC_FAMILY',
  }));
  const actors = bindings.map(() => ({ actorRef: randomUUID(), correlationId: randomUUID() }));
  const assetIds: Array<{ credentialId: string; assetId: string }> = [];
  const healthByCredential = new Map<string, 'REVOKED' | 'EXPIRED' | 'ACTION_REQUIRED'>();
  const vaultRepository = new MysqlCredentialVaultRepository(database, new AuditEventWriter(database));
  const keyProvider = new ConfiguredCredentialKeyProvider(new CredentialKeyRingConfiguration(keyVersion,
    [{ version: keyVersion, key: credentialKey }]));
  const vault = new CredentialVaultService(vaultRepository, keyProvider, new SyntheticVaultAuthorization());
  const jobs = new DurableJobStore(database, () => 0);
  const policy: CredentialLifecyclePolicyPort = {
    forCredential: (flowVariant, authVariant, family) => flowVariant === 'INSTAGRAM' && authVariant === 'INSTAGRAM_LOGIN' &&
      family === 'SYNTHETIC_FAMILY'
      ? { flowVariant, authVariant, family, inspectEnabled: true, refreshEnabled: false,
        createReauthIntent: true, reauthImpactKey: 'SYNTHETIC_AUTHORIZATION_ACCESS',
        checkIntervalSeconds: 3600, jitterPercent: 0 }
      : undefined,
  };
  let inspectorCalls = 0;
  const inspection: CredentialInspectionPort = {
    async inspect(binding, secret) {
      assert.equal(secret, secretMarker);
      inspectorCalls += 1;
      const health = healthByCredential.get(binding.credentialId) ?? 'REVOKED';
      return { health, issuedAt: '2026-11-03T12:00:00.000Z',
        expiryState: 'KNOWN', expiresAt: '2026-11-04T12:00:00.000Z', dataAccessExpiresAt: '2026-11-04T12:00:00.000Z',
        reasonCode: health === 'REVOKED' ? 'PERMISSION_REVOKED' : health === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'REAUTH_REQUIRED' };
    },
  };
  const secretAccess: CredentialLifecycleSecretPort = {
    async withCredential(binding, execute) {
      const actor = actors[bindings.findIndex((candidate) => candidate.credentialId === binding.credentialId)];
      assert.ok(actor);
      await vault.withCredential({ ...binding, ...actor, operation: 'CREDENTIAL_INSPECTION' }, execute);
    },
  };

  const addSyntheticCredentialAndAsset = async (index: number): Promise<void> => {
    const binding = bindings[index]!;
    await dataSource.query(
      `INSERT INTO ca_meta_credentials
       (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', 'SYNTHETIC_FAMILY', 'ACTIVE', 1, ?, ?)`,
      [binding.credentialId, tenantId, authorizationId, appConfigurationId, timestamp, timestamp],
    );
    await vault.store({ ...binding, ...actors[index]!, secret: secretMarker });
    const assetId = randomUUID();
    await dataSource.query(
      `INSERT INTO ca_meta_assets
       (id, tenant_id, app_configuration_id, provider, environment, asset_kind, external_id, display_name, external_name, version, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'INSTAGRAM_BUSINESS_ACCOUNT', ?, NULL, NULL, 1, ?, ?)`,
      [assetId, tenantId, appConfigurationId, `m3-09-asset-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_asset_authorizations
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, credential_id, state,
        verification_state, verification_source, verification_ref_hash, verified_at, subscription_state, projection_state, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'META', 'test', ?, 'ACTIVE', 'VERIFIED', 'META_API', ?, ?, 'UNKNOWN', 'UNKNOWN', 1, ?, ?)`,
      [tenantId, authorizationId, assetId, appConfigurationId, binding.credentialId, 'a'.repeat(64), timestamp, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_asset_grants
       (tenant_id, authorization_id, asset_id, app_configuration_id, provider, environment, grant_name, status, source, observed_at, version)
       VALUES (?, ?, ?, ?, 'META', 'test', 'SYNTHETIC_ASSET_ACCESS', 'GRANTED', 'META_API', ?, 1)`,
      [tenantId, authorizationId, assetId, appConfigurationId, timestamp],
    );
    assetIds.push({ credentialId: binding.credentialId, assetId });
  };
  const addReauthCredential = async (health: 'EXPIRED' | 'ACTION_REQUIRED') => {
    const binding = {
      tenantId, credentialId: randomUUID(), authorizationId, appConfigurationId, provider: 'META' as const,
      environment: 'test', flowVariant: 'INSTAGRAM' as const, authVariant: 'INSTAGRAM_LOGIN' as const,
      family: 'SYNTHETIC_FAMILY',
    };
    const actor = { actorRef: randomUUID(), correlationId: randomUUID() };
    bindings.push(binding);
    actors.push(actor);
    healthByCredential.set(binding.credentialId, health);
    await addSyntheticCredentialAndAsset(bindings.length - 1);
    return { binding, actor };
  };

  try {
    await dataSource.query('SET time_zone = ?', ['+00:00']);
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', ?, ?)`,
      [appConfigurationId, tenantId, `m3-09-app-${randomUUID()}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_authorizations (id, tenant_id, app_configuration_id, provider, environment, flow_variant, auth_variant,
        provider_authorization_id, authorization_state, observed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'META', 'test', 'INSTAGRAM', 'INSTAGRAM_LOGIN', ?, 'ACTIVE', ?, ?, ?)`,
      [authorizationId, tenantId, appConfigurationId, `m3-09-auth-${randomUUID()}`, timestamp, timestamp, timestamp],
    );
    await addSyntheticCredentialAndAsset(0);

    const shape = await dataSource.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE()
       AND table_name IN ('ca_meta_authorizations', 'ca_meta_asset_authorizations', 'ca_meta_credential_lifecycle',
         'ca_meta_credential_reauth_intents', 'ca_meta_credential_reauth_impacts') ORDER BY table_name, ordinal_position`,
    ) as Array<{ table_name: string; column_name: string }>;
    const lifecycleColumns = shape.filter((row) => row.table_name === 'ca_meta_credential_lifecycle').map((row) => row.column_name);
    assert.ok(lifecycleColumns.includes('issued_at') && lifecycleColumns.includes('expires_at') &&
      lifecycleColumns.includes('data_access_expires_at') && lifecycleColumns.includes('health_source') &&
      lifecycleColumns.includes('last_checked_at') && lifecycleColumns.includes('schedule_generation'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_authorizations' && row.column_name === 'flow_variant'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_authorizations' && row.column_name === 'auth_variant'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_credential_reauth_intents' && row.column_name === 'dedupe_key'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_credential_reauth_impacts' && row.column_name === 'asset_id'));
    assert.ok(shape.some((row) => row.table_name === 'ca_meta_asset_authorizations' && row.column_name === 'credential_id'));

    const schedulerA = new CredentialLifecycleScheduler(database, jobs, `m3-09-scheduler-a:${randomUUID()}`);
    const schedulerB = new CredentialLifecycleScheduler(database, jobs, `m3-09-scheduler-b:${randomUUID()}`);
    const claims = await Promise.all([schedulerA.scheduleDue(1, 5_000), schedulerB.scheduleDue(1, 5_000)]);
    assert.equal(claims[0]! + claims[1]!, 1, 'one replica holds the per-credential schedule lease');
    const scheduled = await dataSource.query(
      `SELECT id, idempotency_key, correlation_id, payload_json, status FROM ca_meta_jobs
       WHERE tenant_id = ? AND job_type = 'CREDENTIAL_INSPECTION'`, [tenantId],
    ) as Array<{ id: string; idempotency_key: string; correlation_id: string; payload_json: string; status: string }>;
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.status, 'QUEUED');
    assert.ok(!scheduled[0]?.payload_json.includes(secretMarker));
    const payload = JSON.parse(scheduled[0]!.payload_json) as Record<string, unknown>;
    const duplicate = await jobs.enqueue({ tenantId, type: 'CREDENTIAL_INSPECTION',
      idempotencyKey: scheduled[0]!.idempotency_key, correlationId: scheduled[0]!.correlation_id,
      resourceScopeRef: String(payload.credentialId), payload });
    assert.equal(duplicate.duplicate, true, 'durable enqueue deduplicates the same authorized observation job');
    const queuedForRevokedCredential = await jobs.enqueue({ tenantId, type: 'CREDENTIAL_INSPECTION',
      idempotencyKey: `synthetic-extra-inspection:${String(payload.credentialId)}`, correlationId: randomUUID(),
      resourceScopeRef: String(payload.credentialId), payload });
    await addSyntheticCredentialAndAsset(1);

    const processor = new CredentialInspectionWorker(database, policy, secretAccess, inspection, () => 0.5);
    const runWorker = async (): Promise<void> => {
      const controller = new AbortController();
      const finalizer: JobFinalizer = async (manager, job, finalization) => {
          await processor.finalizer(manager, job, finalization);
          controller.abort();
        };
      const handlers = new Map<JobType, JobHandler>([['CREDENTIAL_INSPECTION', processor.handler]]);
      const finalizers = new Map<JobType, JobFinalizer>([['CREDENTIAL_INSPECTION', finalizer]]);
      const worker = new DurableWorker(jobs, { workerRef: `m3-09-worker:${randomUUID()}`, leaseMs: 30_000 }, handlers, finalizers);
      await worker.run(controller.signal);
    };
    await runWorker();
    assert.equal(inspectorCalls, 1);
    const canceledRows = await dataSource.query(
      'SELECT status, last_safe_error_code, last_safe_error_action FROM ca_meta_jobs WHERE tenant_id = ? AND id = ?',
      [tenantId, queuedForRevokedCredential.id],
    ) as Array<{ status: string; last_safe_error_code: string; last_safe_error_action: string }>;
    assert.equal(canceledRows[0]?.status, 'FAILED', 'queued inspection for a revoked credential is canceled');
    assert.equal(canceledRows[0]?.last_safe_error_code, 'CREDENTIAL_REVOKED');
    assert.equal(canceledRows[0]?.last_safe_error_action, 'REAUTHORIZE');
    const firstCredential = String(payload.credentialId);
    const firstResource = assetIds.find((item) => item.credentialId === firstCredential);
    const unaffectedResource = assetIds.find((item) => item.credentialId !== firstCredential);
    assert.ok(firstResource && unaffectedResource);
    const firstImpactState = await dataSource.query(
      `SELECT aa.credential_id, aa.asset_id, aa.state, grant_row.status AS grant_status
       FROM ca_meta_asset_authorizations aa JOIN ca_meta_asset_grants grant_row
         ON grant_row.tenant_id = aa.tenant_id AND grant_row.authorization_id = aa.authorization_id AND grant_row.asset_id = aa.asset_id
       WHERE aa.tenant_id = ? AND aa.authorization_id = ? ORDER BY aa.asset_id`, [tenantId, authorizationId],
    ) as Array<{ credential_id: string; asset_id: string; state: string; grant_status: string }>;
    assert.equal(firstImpactState.find((item) => item.asset_id === firstResource.assetId)?.state, 'REVOKED');
    assert.equal(firstImpactState.find((item) => item.asset_id === firstResource.assetId)?.grant_status, 'REVOKED');
    assert.equal(firstImpactState.find((item) => item.asset_id === unaffectedResource.assetId)?.state, 'ACTIVE',
      'confirmed revocation changes only the asset authorization linked to that credential');
    assert.equal(firstImpactState.find((item) => item.asset_id === unaffectedResource.assetId)?.grant_status, 'GRANTED',
      'the other credential grant remains usable');
    const authAfterSingleCredentialRevocation = await dataSource.query(
      'SELECT authorization_state FROM ca_meta_authorizations WHERE tenant_id = ? AND id = ?', [tenantId, authorizationId],
    ) as Array<{ authorization_state: string }>;
    assert.equal(authAfterSingleCredentialRevocation[0]?.authorization_state, 'ACTIVE',
      'one revoked credential does not revoke the shared authorization');
    const secondCredential = bindings.find((binding) => binding.credentialId !== firstCredential);
    assert.ok(secondCredential);
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1, 'a separate due credential is scheduled on the next bounded run');
    await runWorker();
    assert.equal(inspectorCalls, 2);
    const intents = await dataSource.query(
      `SELECT id, credential_id, authorization_id, dedupe_key, reason_code, occurrences FROM ca_meta_credential_reauth_intents
       WHERE tenant_id = ?`, [tenantId],
    ) as Array<{ id: string; credential_id: string; authorization_id: string; dedupe_key: string; reason_code: string; occurrences: number | string }>;
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.credential_id, secondCredential.credentialId, 'intent retains one safe reference to the latest affected credential');
    assert.equal(Number(intents[0]?.occurrences), 2, 'two credentials under one authorization+impact coalesce');
    assert.equal(intents[0]?.authorization_id, authorizationId);
    assert.equal(intents[0]?.reason_code, 'PERMISSION_REVOKED');
    assert.match(intents[0]?.dedupe_key ?? '', new RegExp(`^authorization:${authorizationId}:impact:SYNTHETIC_AUTHORIZATION_ACCESS$`));
    assert.ok(!JSON.stringify(intents).includes(secretMarker));

    // Use a separate active credential; the two credentials revoked above are no longer schedulable.
    const staleLifecycle = await addReauthCredential('EXPIRED');
    await dataSource.query(
      `UPDATE ca_meta_credential_lifecycle SET next_check_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE tenant_id = ? AND credential_id = ?`, [tenantId, staleLifecycle.binding.credentialId],
    );
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1);
    await dataSource.query(
      'UPDATE ca_meta_credentials SET version = version + 1 WHERE tenant_id = ? AND id = ?',
      [tenantId, staleLifecycle.binding.credentialId],
    );
    const beforeFence = await dataSource.query(
      'SELECT health_state, version FROM ca_meta_credential_lifecycle WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, staleLifecycle.binding.credentialId],
    ) as Array<{ health_state: string; version: number | string }>;
    await runWorker();
    assert.equal(inspectorCalls, 2, 'stale credential version is rejected before decrypted secret or inspector access');
    const afterFence = await dataSource.query(
      'SELECT health_state, version FROM ca_meta_credential_lifecycle WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, staleLifecycle.binding.credentialId],
    ) as Array<{ health_state: string; version: number | string }>;
    assert.equal(afterFence[0]?.health_state, beforeFence[0]?.health_state);
    assert.equal(Number(afterFence[0]?.version), Number(beforeFence[0]?.version), 'stale finalizer cannot restore older metadata');

    const coalesced = await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_credential_reauth_intents WHERE tenant_id = ? AND authorization_id = ? AND dedupe_key = ?',
      [tenantId, authorizationId, intents[0]!.dedupe_key],
    ) as Array<{ count: string | number }>;
    assert.equal(Number(coalesced[0]?.count ?? 0), 1, 'one authorization+impact key produces one coalesced intent with multiple resource children');
    const impactRows = await dataSource.query(
      `SELECT impact.credential_id, impact.asset_id, aa.credential_id AS linked_credential_id, aa.state
       FROM ca_meta_credential_reauth_impacts impact JOIN ca_meta_asset_authorizations aa
         ON aa.tenant_id = impact.tenant_id AND aa.authorization_id = impact.authorization_id AND aa.asset_id = impact.asset_id
         AND aa.app_configuration_id = impact.app_configuration_id AND aa.provider = impact.provider AND aa.environment = impact.environment
       WHERE impact.tenant_id = ? AND impact.reauth_intent_id = ? ORDER BY impact.asset_id`,
      [tenantId, intents[0]!.id],
    ) as Array<{ credential_id: string; asset_id: string; linked_credential_id: string; state: string }>;
    assert.equal(impactRows.length, 2, 'the local reauth intent retains one child impact for each exactly linked revoked asset');
    assert.ok(impactRows.every((item) => item.credential_id === item.linked_credential_id && item.state === 'REVOKED'));

    const reader = new CredentialReauthIntentReader(database);
    const pendingPage = await reader.listPending(tenantId, null, 1);
    assert.equal(pendingPage.items.length, 1);
    const affectedFirstPage = await reader.listAffectedAssets(tenantId, pendingPage.items[0]!.intentRef, null, 1);
    assert.equal(affectedFirstPage.items.length, 1);
    assert.ok(affectedFirstPage.nextAfterAssetRef);
    const affectedSecondPage = await reader.listAffectedAssets(tenantId, pendingPage.items[0]!.intentRef,
      affectedFirstPage.nextAfterAssetRef, 1);
    assert.equal(affectedSecondPage.items.length, 1);
    assert.ok(!JSON.stringify([...affectedFirstPage.items, ...affectedSecondPage.items]).includes(secretMarker));

    const assertNonRevokingIntentImpact = async (health: 'EXPIRED' | 'ACTION_REQUIRED', reasonCode: string): Promise<void> => {
      const affected = await addReauthCredential(health);
      assert.equal(await schedulerA.scheduleDue(1, 5_000), 1);
      await runWorker();
      const resource = assetIds.find((item) => item.credentialId === affected.binding.credentialId);
      assert.ok(resource);
      const resourceState = await dataSource.query(
        `SELECT aa.state, grant_row.status AS grant_status FROM ca_meta_asset_authorizations aa
         JOIN ca_meta_asset_grants grant_row ON grant_row.tenant_id = aa.tenant_id
           AND grant_row.authorization_id = aa.authorization_id AND grant_row.asset_id = aa.asset_id
         WHERE aa.tenant_id = ? AND aa.authorization_id = ? AND aa.asset_id = ?`,
        [tenantId, authorizationId, resource.assetId],
      ) as Array<{ state: string; grant_status: string }>;
      assert.equal(resourceState[0]?.state, 'ACTIVE', `${health} leaves the linked asset authorization active`);
      assert.equal(resourceState[0]?.grant_status, 'GRANTED', `${health} leaves its grant unchanged`);
      const savedImpact = await dataSource.query(
        `SELECT reason_code FROM ca_meta_credential_reauth_impacts
         WHERE tenant_id = ? AND reauth_intent_id = ? AND credential_id = ? AND asset_id = ?`,
        [tenantId, pendingPage.items[0]!.intentRef, affected.binding.credentialId, resource.assetId],
      ) as Array<{ reason_code: string }>;
      assert.equal(savedImpact[0]?.reason_code, reasonCode);
      const exposed = await reader.listAffectedAssets(tenantId, pendingPage.items[0]!.intentRef, null, 50);
      assert.ok(exposed.items.some((item) => item.credentialRef === affected.binding.credentialId &&
        item.assetRef === resource.assetId && item.reasonCode === reasonCode),
      `${health} remains available to the bounded reauthorization reader while its exact grant is active`);
    };
    await assertNonRevokingIntentImpact('EXPIRED', 'TOKEN_EXPIRED');
    await assertNonRevokingIntentImpact('ACTION_REQUIRED', 'REAUTH_REQUIRED');

    const addCasCredential = async () => {
      const binding = {
        tenantId, credentialId: randomUUID(), authorizationId, appConfigurationId, provider: 'META' as const,
        environment: 'test', flowVariant: 'INSTAGRAM' as const, authVariant: 'INSTAGRAM_LOGIN' as const,
        family: 'SYNTHETIC_FAMILY',
      };
      const actor = { actorRef: randomUUID(), correlationId: randomUUID() };
      bindings.push(binding);
      actors.push(actor);
      await dataSource.query(
        `INSERT INTO ca_meta_credentials
         (id, tenant_id, authorization_id, app_configuration_id, provider, environment, family, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'META', 'test', 'SYNTHETIC_FAMILY', 'ACTIVE', 1, ?, ?)`,
        [binding.credentialId, tenantId, authorizationId, appConfigurationId, timestamp, timestamp],
      );
      await vault.store({ ...binding, ...actor, secret: secretMarker });
      return { binding, actor };
    };

    const current = await addCasCredential();
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1, 'the synthetic credential gets one exact lifecycle lease');
    const currentJobRows = await dataSource.query(
      `SELECT payload_json FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = 'CREDENTIAL_INSPECTION'
       AND resource_scope_ref = ? AND status = 'QUEUED' ORDER BY created_at DESC LIMIT 1`,
      [tenantId, current.binding.credentialId],
    ) as Array<{ payload_json: string }>;
    const currentFence = JSON.parse(currentJobRows[0]!.payload_json) as unknown as CredentialInspectionBinding;
    const replacementCas = new CredentialReplacementCasService(database, vault);
    assert.equal(await replacementCas.replaceIfCurrent(currentFence, current.actor, replacementMarker), true,
      'a current isolated CAS atomically updates the vault secret');
    const renewedSecretVersion = await dataSource.query(
      'SELECT version FROM ca_meta_credential_secrets WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, current.binding.credentialId],
    ) as Array<{ version: number | string }>;
    assert.equal(Number(renewedSecretVersion[0]?.version), 2);
    let replacementStored = false;
    await vault.withCredential({ ...current.binding, ...current.actor, operation: 'CREDENTIAL_INSPECTION' },
      async (secret) => { replacementStored = secret === replacementMarker; });
    assert.equal(replacementStored, true, 'replacement material is observed only inside the vault callback');

    const stale = await addCasCredential();
    assert.equal(await schedulerA.scheduleDue(1, 5_000), 1);
    const staleJobRows = await dataSource.query(
      `SELECT payload_json FROM ca_meta_jobs WHERE tenant_id = ? AND job_type = 'CREDENTIAL_INSPECTION'
       AND resource_scope_ref = ? AND status = 'QUEUED' ORDER BY created_at DESC LIMIT 1`,
      [tenantId, stale.binding.credentialId],
    ) as Array<{ payload_json: string }>;
    const staleFence = JSON.parse(staleJobRows[0]!.payload_json) as unknown as CredentialInspectionBinding;
    const resourceIdentity = await dataSource.query(
      'SELECT external_id FROM ca_meta_assets WHERE tenant_id = ? AND id = ?', [tenantId, firstResource.assetId],
    ) as Array<{ external_id: string }>;
    const reauthorizationEvidence = issueVerifiedMetaEvidence({ source: 'META_API',
      observedAt: '2026-11-03T12:00:00.000Z', observationRef: `synthetic-reauthorization-${randomUUID()}` });
    const metaAssets = new MysqlMetaAssetsRepository(database, { async appendWithin() { return; } }, new AuditEventWriter(database));
    const reauthorizationCommand = (credentialId: string) => ({
      tenantId, authorizationId, appConfigurationId, provider: 'META' as const, environment: 'test' as const, state: 'ACTIVE' as const,
      grantedScopes: [], evidence: reauthorizationEvidence,
      flowVariant: 'INSTAGRAM' as const, authVariant: 'INSTAGRAM_LOGIN' as const,
      assets: [{ kind: 'INSTAGRAM_BUSINESS_ACCOUNT' as const, externalId: resourceIdentity[0]!.external_id,
        evidence: reauthorizationEvidence, credentialId, grants: ['SYNTHETIC_ASSET_ACCESS'] }],
      actor: { kind: 'SERVICE' as const, ref: current.actor.actorRef }, correlationId: randomUUID(),
      observedAt: '2026-11-03T12:00:00.000Z',
    });
    await metaAssets.upsert(reauthorizationCommand(current.binding.credentialId));
    const rebound = await dataSource.query(
      `SELECT aa.credential_id, aa.state, grant_row.status AS grant_status, old_credential.status AS old_credential_status
       FROM ca_meta_asset_authorizations aa JOIN ca_meta_asset_grants grant_row
         ON grant_row.tenant_id = aa.tenant_id AND grant_row.authorization_id = aa.authorization_id AND grant_row.asset_id = aa.asset_id
       JOIN ca_meta_credentials old_credential ON old_credential.tenant_id = aa.tenant_id AND old_credential.id = ?
       WHERE aa.tenant_id = ? AND aa.authorization_id = ? AND aa.asset_id = ?`,
      [firstCredential, tenantId, authorizationId, firstResource.assetId],
    ) as Array<{ credential_id: string; state: string; grant_status: string; old_credential_status: string }>;
    assert.equal(rebound[0]?.credential_id, current.binding.credentialId);
    assert.equal(rebound[0]?.state, 'ACTIVE', 'trusted reauthorization may bind the exact resource to a new active credential');
    assert.equal(rebound[0]?.grant_status, 'GRANTED');
    assert.equal(rebound[0]?.old_credential_status, 'REVOKED', 'the old credential and its history remain revoked');
    const oldLifecycle = await dataSource.query(
      'SELECT health_state FROM ca_meta_credential_lifecycle WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, firstCredential],
    ) as Array<{ health_state: string }>;
    assert.equal(oldLifecycle[0]?.health_state, 'REVOKED');
    const authorizationReadModels = await metaAssets.listReadModels({ tenantId, appConfigurationId, environment: 'test' });
    const reboundReadModel = authorizationReadModels[0]?.assets.find((asset) => asset.assetRef === firstResource.assetId);
    assert.equal(reboundReadModel?.authorizationState, 'ACTIVE');
    assert.equal(reboundReadModel?.credentialBindingState, 'BOUND');
    await assert.rejects(metaAssets.upsert(reauthorizationCommand(stale.binding.credentialId)), MetaAssetsConflictError,
      'an active linked resource cannot be rebound again');
    await assert.rejects(metaAssets.upsert(reauthorizationCommand(firstCredential)), MetaAssetsConflictError,
      'the prior revoked credential cannot be restored as the new binding');
    const afterRebindImpacts = await reader.listAffectedAssets(tenantId, pendingPage.items[0]!.intentRef, null, 50);
    assert.ok(!afterRebindImpacts.items.some((item) => item.assetRef === firstResource.assetId),
      'the reader no longer presents an old impact after the exact resource is rebound');

    await dataSource.query(
      `UPDATE ca_meta_authorizations SET authorization_state = 'REVOKED', version = version + 1
       WHERE tenant_id = ? AND id = ?`, [tenantId, authorizationId],
    );
    assert.equal(await replacementCas.replaceIfCurrent(staleFence, stale.actor, replacementMarker), false,
      'a late CAS is rejected after authorization state/version changes');
    const staleSecretVersion = await dataSource.query(
      'SELECT version FROM ca_meta_credential_secrets WHERE tenant_id = ? AND credential_id = ?',
      [tenantId, stale.binding.credentialId],
    ) as Array<{ version: number | string }>;
    assert.equal(Number(staleSecretVersion[0]?.version), 1, 'a stale CAS cannot restore a prior credential secret');
  } finally {
    credentialKey.fill(0);
    await database.close();
  }
});
