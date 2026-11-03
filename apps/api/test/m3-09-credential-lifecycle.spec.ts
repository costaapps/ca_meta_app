import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityManager } from 'typeorm';
import { CredentialInspectionWorker, CredentialLifecycleScheduler, CredentialReauthIntentReader,
  CredentialReplacementCasService } from '../src/credentials/credential-lifecycle.service.js';
import type { CredentialInspectionBinding, CredentialInspectionPort, CredentialLifecyclePolicyPort, CredentialLifecycleSecretPort } from '../src/credentials/credential-lifecycle.types.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { JOB_POLICIES, parseJobPayload } from '../src/jobs/event-validation.js';
import { decodeStoredJobPayload, type ClaimedJob, type JobStore } from '../src/jobs/job-store.js';
import { DurableWorker } from '../src/worker/durable-worker.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const credentialId = '00000000-0000-4000-8000-000000000002';
const authorizationId = '00000000-0000-4000-8000-000000000003';
const appConfigurationId = '00000000-0000-4000-8000-000000000004';
const leaseToken = '00000000-0000-4000-8000-000000000005';
const observedAt = '2026-11-03T12:00:00.000Z';
const expiryAt = '2026-11-04T12:00:00.000Z';

function syntheticPorts(callCounts: { secret: number; inspect: number }, health: 'HEALTHY' | 'EXPIRING' | 'EXPIRED' | 'ACTION_REQUIRED' | 'REVOKED' = 'HEALTHY',
  expiryState: 'KNOWN' | 'PROVIDER_NO_EXPIRY' | 'UNKNOWN' = 'KNOWN') {
  const policies: CredentialLifecyclePolicyPort = {
    forCredential: (flowVariant, authVariant, family) => family === 'SYNTHETIC_FAMILY' &&
      flowVariant === 'INSTAGRAM' && authVariant === 'INSTAGRAM_LOGIN'
      ? { flowVariant, authVariant, family, inspectEnabled: true, refreshEnabled: false, createReauthIntent: true,
        reauthImpactKey: 'SYNTHETIC_CREDENTIAL_ACCESS', checkIntervalSeconds: 3600, jitterPercent: 0 }
      : undefined,
  };
  const secrets: CredentialLifecycleSecretPort = {
    async withCredential(_binding, execute) { callCounts.secret += 1; await execute('synthetic-only-secret'); },
  };
  const inspector: CredentialInspectionPort = {
    async inspect(_binding, secret) {
      assert.equal(secret, 'synthetic-only-secret');
      callCounts.inspect += 1;
      return { health, issuedAt: observedAt, expiryState,
        expiresAt: expiryState === 'KNOWN' ? expiryAt : null, dataAccessExpiresAt: expiryAt,
        reasonCode: health === 'REVOKED' ? 'PERMISSION_REVOKED' : health === 'EXPIRED' ? 'TOKEN_EXPIRED' :
          health === 'ACTION_REQUIRED' ? 'REAUTH_REQUIRED' : 'NONE' };
    },
  };
  return { policies, secrets, inspector };
}

function fakeDatabase(flowAuthConfigured = true) {
  const scheduleStatements: string[] = [];
  const finalizedStatements: Array<{ sql: string; parameters: unknown[] }> = [];
  let leasedPayload: Record<string, unknown> | undefined;
  let authorizationVersion = 3;
  let authorizationState = 'ACTIVE';
  const manager = {
    async query(sql: string, parameters: unknown[] = []) {
      scheduleStatements.push(sql);
      if (sql.includes('SELECT c.tenant_id, c.id AS credential_id')) return flowAuthConfigured ? [{
        tenant_id: tenantId, credential_id: credentialId, authorization_id: authorizationId,
        app_configuration_id: appConfigurationId, provider: 'META', environment: 'test', family: 'SYNTHETIC_FAMILY',
        flow_variant: 'INSTAGRAM', auth_variant: 'INSTAGRAM_LOGIN',
        credential_version: 7, secret_version: 4, lifecycle_version: 1, generation: 0,
        authorization_version: 3,
      }] : [];
      if (sql.includes('UPDATE ca_meta_credential_lifecycle') && sql.includes('SET lease_owner')) return { affectedRows: 1 };
      if (sql.includes('SELECT l.version, l.schedule_generation')) return [{
        version: 2, schedule_generation: 1, lease_token: leaseToken, lease_owner: 'test-scheduler',
        lease_expires_at: new Date(Date.now() + 60_000), lease_valid: 1, health_state: 'UNKNOWN',
        credential_version: 7, secret_version: 4, authorization_version: 3,
        flow_variant: 'INSTAGRAM', auth_variant: 'INSTAGRAM_LOGIN',
      }];
      if (sql.includes('SELECT l.version AS lifecycle_version')) return [{
        lifecycle_version: 2, generation: 1, lease_owner: 'test-scheduler', lease_token: leaseToken,
        lease_valid: 1, authorization_state: authorizationState, authorization_version: authorizationVersion,
        credential_status: 'ACTIVE', credential_version: 7, secret_version: 4,
        flow_variant: 'INSTAGRAM', auth_variant: 'INSTAGRAM_LOGIN',
      }];
      if (sql.includes('SELECT auth.authorization_state, auth.version AS authorization_version')) return [{
        authorization_state: authorizationState, authorization_version: authorizationVersion,
        flow_variant: 'INSTAGRAM', auth_variant: 'INSTAGRAM_LOGIN', credential_status: 'ACTIVE',
        credential_version: 7, secret_version: 4, lifecycle_version: 2, generation: 1,
        lease_owner: 'test-scheduler', lease_token: leaseToken, lease_valid: 1,
      }];
      if (sql.includes('SELECT id FROM ca_meta_credential_reauth_intents')) return [{ id: '00000000-0000-4000-8000-000000000008' }];
      if (sql.includes('SELECT c.version AS credential_version')) return [{
        credential_version: 7, secret_version: 4, lifecycle_version: 2, generation: 1,
        authorization_version: 3, lease_owner: 'test-scheduler', lease_token: leaseToken, lease_valid: 1,
        flow_variant: 'INSTAGRAM', auth_variant: 'INSTAGRAM_LOGIN',
      }];
      finalizedStatements.push({ sql, parameters });
      return { affectedRows: 1 };
    },
  };
  const dataSource = {
    async transaction<T>(callback: (value: typeof manager) => Promise<T>): Promise<T> { return callback(manager); },
    async query(sql: string, parameters?: unknown[]) { return manager.query(sql, parameters); },
  };
  const database = { async getDataSource() { return dataSource; } } as unknown as DurableWorkDatabase;
  return { database, manager, scheduleStatements, finalizedStatements,
    setAuthorization(state: string, version: number) { authorizationState = state; authorizationVersion = version; },
    setPayload(value: Record<string, unknown>) { leasedPayload = value; }, get payload() { return leasedPayload; } };
}

test('inspection job payload rejects secret fields and requires version/lease fences', () => {
  const payload = {
    kind: 'CREDENTIAL_INSPECTION', credentialId, authorizationId, appConfigurationId, provider: 'META',
    environment: 'test', flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', family: 'SYNTHETIC_FAMILY', credentialVersion: 7, secretVersion: 4,
    authorizationVersion: 3, lifecycleVersion: 2, generation: 1, leaseOwner: 'test-scheduler', leaseToken,
  };
  assert.deepEqual(parseJobPayload('CREDENTIAL_INSPECTION', payload), payload);
  assert.deepEqual(parseJobPayload('CREDENTIAL_INSPECTION', decodeStoredJobPayload(JSON.stringify(payload))), payload);
  assert.deepEqual(parseJobPayload('CREDENTIAL_INSPECTION', decodeStoredJobPayload(Buffer.from(JSON.stringify(payload)))), payload);
  assert.deepEqual(parseJobPayload('CREDENTIAL_INSPECTION', decodeStoredJobPayload(payload)), payload);
  assert.throws(() => decodeStoredJobPayload(Buffer.from([0xff])));
  assert.throws(() => parseJobPayload('CREDENTIAL_INSPECTION',
    decodeStoredJobPayload(Buffer.from(JSON.stringify({ ...payload, access_token: 'synthetic-secret' })))));
  assert.throws(() => parseJobPayload('CREDENTIAL_INSPECTION', { ...payload, access_token: 'synthetic-secret' }));
  assert.throws(() => parseJobPayload('CREDENTIAL_INSPECTION', { ...payload, secretVersion: 0 }));
  assert.equal(JOB_POLICIES.CREDENTIAL_INSPECTION.lane, 'HISTORICAL_PROJECTION');
  assert.equal(JOB_POLICIES.CREDENTIAL_INSPECTION.effectMode, 'IDEMPOTENT');
});

test('unknown persisted flow/auth context is excluded from scheduling', async () => {
  const fake = fakeDatabase(false);
  const jobs = { async enqueueWithin() { throw new Error('unknown flow/auth must not enqueue'); } } as never;
  const scheduler = new CredentialLifecycleScheduler(fake.database, jobs, 'test-scheduler', () => 10, () => leaseToken);
  assert.equal(await scheduler.scheduleDue(1, 100), 0);
  assert.ok(fake.scheduleStatements.some((sql) =>
    sql.includes("auth.flow_variant = 'INSTAGRAM' AND auth.auth_variant = 'INSTAGRAM_LOGIN'")));
});

async function runSyntheticLifecycle(input: { readonly adapter: boolean; readonly health?: 'HEALTHY' | 'EXPIRING' | 'EXPIRED' | 'ACTION_REQUIRED' | 'REVOKED';
  readonly expiryState?: 'KNOWN' | 'PROVIDER_NO_EXPIRY' | 'UNKNOWN' }) {
  const fake = fakeDatabase();
  const jobController = new AbortController();
  let claimed = false;
  let claim: ClaimedJob | undefined;
  const store: JobStore = {
    async enqueue() { throw new Error('unexpected non-transactional enqueue'); },
    async enqueueWithin(manager, job) {
      assert.equal(manager, fake.manager);
      fake.setPayload(job.payload as Record<string, unknown>);
      const payload = parseJobPayload('CREDENTIAL_INSPECTION', job.payload);
      assert.equal(payload.kind, 'CREDENTIAL_INSPECTION');
      assert.equal(job.idempotencyKey, `credential-inspection:${credentialId}:1`);
      claim = {
        id: 'synthetic-job-id', tenantId, type: 'CREDENTIAL_INSPECTION',
        lane: JOB_POLICIES.CREDENTIAL_INSPECTION.lane, effectMode: JOB_POLICIES.CREDENTIAL_INSPECTION.effectMode,
        payload, idempotencyKey: job.idempotencyKey, correlationId: job.correlationId, causationId: null,
        attempt: 1, maxAttempts: 1, claimToken: 'synthetic-claim-token', workerRef: 'synthetic-worker',
        budgetStartedAt: observedAt, createdAt: observedAt,
      };
      return { id: claim.id, duplicate: false };
    },
    async claimNext() {
      if (claimed || !claim) return null;
      claimed = true;
      return claim;
    },
    async renew() { return true; },
    async finish(job, outcome, _random, applyWithin) {
      assert.equal(outcome.kind, 'SUCCEEDED');
      await applyWithin?.(fake.manager as unknown as EntityManager, { status: 'SUCCEEDED', safeErrorCode: null, safeErrorAction: null });
      jobController.abort();
      return true;
    },
  };
  const scheduler = new CredentialLifecycleScheduler(fake.database, store, 'test-scheduler', () => 10,
    () => leaseToken);
  assert.equal(await scheduler.scheduleDue(1, 100), 1);
  const payload = fake.payload;
  assert.ok(payload);

  const calls = { secret: 0, inspect: 0 };
  const ports = syntheticPorts(calls, input.health, input.expiryState);
  const processor = input.adapter
    ? new CredentialInspectionWorker(fake.database, ports.policies, ports.secrets, ports.inspector, () => 0.5)
    : new CredentialInspectionWorker(fake.database, undefined, undefined, undefined, () => 0.5);
  const worker = new DurableWorker(store, { workerRef: 'synthetic-worker', leaseMs: 1_000, idlePollMs: 1 },
    new Map([['CREDENTIAL_INSPECTION', processor.handler]]), new Map([['CREDENTIAL_INSPECTION', processor.finalizer]]));
  await worker.run(jobController.signal);
  return { fake, calls };
}

test('due schedule enqueues transactionally, runs registered inspection handler, and finalizes allowlisted observations', async () => {
  const { fake, calls } = await runSyntheticLifecycle({ adapter: true });
  assert.equal(calls.secret, 1);
  assert.equal(calls.inspect, 1);
  assert.ok(fake.scheduleStatements.some((sql) => sql.includes('INSERT IGNORE INTO ca_meta_credential_lifecycle')));
  assert.ok(fake.scheduleStatements.some((sql) => sql.includes('FOR UPDATE SKIP LOCKED')));
  const update = fake.finalizedStatements.find(({ sql }) => sql.includes('SET issued_at = ?'));
  assert.ok(update);
  assert.equal(update?.parameters[2], 'KNOWN');
  assert.equal(update?.parameters[4], 'HEALTHY');
  assert.equal(update?.parameters[5], 'NONE');
  assert.equal(fake.finalizedStatements.some(({ sql }) => sql.includes('ca_meta_credential_reauth_intents')), false);
});

test('provider no-expiry is persisted only through the explicit discriminant; NULL does not create it', async () => {
  const { fake } = await runSyntheticLifecycle({ adapter: true, expiryState: 'PROVIDER_NO_EXPIRY' });
  const update = fake.finalizedStatements.find(({ sql }) => sql.includes('SET issued_at = ?'));
  assert.ok(update);
  assert.equal(update?.parameters[1], null);
  assert.equal(update?.parameters[2], 'PROVIDER_NO_EXPIRY');
});

test('isolated replacement CAS writes only for the current exact fence and rejects changed authorization state/version', async () => {
  const binding: CredentialInspectionBinding = {
    tenantId, credentialId, authorizationId, appConfigurationId, provider: 'META', environment: 'test',
    flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN', family: 'SYNTHETIC_FAMILY',
    credentialVersion: 7, secretVersion: 4, authorizationVersion: 3, lifecycleVersion: 2,
    generation: 1, leaseOwner: 'test-scheduler', leaseToken,
  };
  const current = fakeDatabase();
  const writes: Array<{ secret: string; authorizationVersion: number; credentialVersion: number; secretVersion: number }> = [];
  const vault = {
    async replaceIfCurrentWithin(manager: EntityManager, input: { secret: string }, fence: {
      expectedAuthorizationVersion: number; expectedCredentialVersion: number; expectedSecretVersion: number;
    }) {
      assert.equal(manager, current.manager);
      writes.push({ secret: input.secret, authorizationVersion: fence.expectedAuthorizationVersion,
        credentialVersion: fence.expectedCredentialVersion, secretVersion: fence.expectedSecretVersion });
      return true;
    },
  };
  const cas = new CredentialReplacementCasService(current.database, vault as never);
  assert.equal(await cas.replaceIfCurrent(binding, { actorRef: 'synthetic-actor', correlationId: 'synthetic-correlation' },
    'synthetic-replacement-only'), true);
  assert.deepEqual(writes, [{ secret: 'synthetic-replacement-only', authorizationVersion: 3, credentialVersion: 7, secretVersion: 4 }]);

  const stale = fakeDatabase();
  stale.setAuthorization('REVOKED', 4);
  const staleVault = { async replaceIfCurrentWithin() { throw new Error('stale result must not reach vault write'); } };
  const staleCas = new CredentialReplacementCasService(stale.database, staleVault as never);
  assert.equal(await staleCas.replaceIfCurrent(binding, { actorRef: 'synthetic-actor', correlationId: 'synthetic-correlation' },
    'synthetic-late-result'), false);
});

test('missing adapter preserves fail-closed state; validated revocation creates only a local deduplicated intent', async () => {
  const missing = await runSyntheticLifecycle({ adapter: false });
  assert.equal(missing.calls.secret, 0);
  assert.equal(missing.calls.inspect, 0);
  assert.ok(missing.fake.finalizedStatements.some(({ sql }) => sql.includes("IF(health_state = 'UNKNOWN', 'UNKNOWN', 'STALE')")));

  const revoked = await runSyntheticLifecycle({ adapter: true, health: 'REVOKED' });
  assert.equal(revoked.calls.inspect, 1);
  const intent = revoked.fake.finalizedStatements.find(({ sql }) => sql.includes('INSERT INTO ca_meta_credential_reauth_intents'));
  assert.ok(intent);
  assert.equal(intent?.parameters[7], 'PERMISSION_REVOKED');
  assert.equal(intent?.parameters.includes('synthetic-only-secret'), false);
});

test('EXPIRED and ACTION_REQUIRED reauth intents record exact active resource impacts without revoking grants', async () => {
  for (const [health, expectedReason] of [['EXPIRED', 'TOKEN_EXPIRED'], ['ACTION_REQUIRED', 'REAUTH_REQUIRED']] as const) {
    const result = await runSyntheticLifecycle({ adapter: true, health });
    const impact = result.fake.finalizedStatements.find(({ sql }) => sql.includes('INSERT INTO ca_meta_credential_reauth_impacts'));
    assert.ok(impact, `${health} intent records its affected exact resource links`);
    assert.ok(impact?.sql.includes('aa.credential_id = ?'));
    assert.ok(impact?.sql.includes("aa.state = 'ACTIVE'"));
    assert.equal(impact?.parameters.at(-1), credentialId);
    assert.equal(impact?.parameters[1], expectedReason);
    assert.equal(result.fake.finalizedStatements.some(({ sql }) => sql.includes('UPDATE ca_meta_asset_grants')), false,
      `${health} does not revoke resource grants`);
    assert.equal(result.fake.finalizedStatements.some(({ sql }) => sql.includes("SET state = 'REVOKED'")), false,
      `${health} does not revoke asset authorizations`);
  }
});

test('bounded reauth impact reader exposes only exact current resource references without provider data', async () => {
  let queryText = '';
  const database = {
    async getDataSource() {
      return { async query(sql: string) {
        queryText = sql;
        return [{ credential_id: credentialId, asset_id: '00000000-0000-4000-8000-000000000006',
          asset_kind: 'INSTAGRAM_BUSINESS_ACCOUNT', family: 'SYNTHETIC_FAMILY', reason_code: 'TOKEN_EXPIRED' }];
      } };
    },
  } as unknown as DurableWorkDatabase;
  const reader = new CredentialReauthIntentReader(database);
  const page = await reader.listAffectedAssets(tenantId, '00000000-0000-4000-8000-000000000007', null, 1);
  assert.deepEqual(page.items, [{ credentialRef: credentialId, assetRef: '00000000-0000-4000-8000-000000000006',
    assetKind: 'INSTAGRAM_BUSINESS_ACCOUNT', family: 'SYNTHETIC_FAMILY', reasonCode: 'TOKEN_EXPIRED' }]);
  assert.equal(page.nextAfterAssetRef, null);
  assert.ok(queryText.includes('asset_auth.credential_id = impact.credential_id'));
  assert.ok(queryText.includes('credential.id = impact.credential_id'));
  assert.ok(queryText.includes('intent.authorization_id = impact.authorization_id'));
  assert.ok(queryText.includes('asset.app_configuration_id = impact.app_configuration_id'));
  assert.ok(queryText.includes('lifecycle.health_state IN (\'EXPIRED\', \'ACTION_REQUIRED\')'));
  assert.equal(JSON.stringify(page).includes('token'), false, 'the internal reader returns no provider data or secret fields');
});
