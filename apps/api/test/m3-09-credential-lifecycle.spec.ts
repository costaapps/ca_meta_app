import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityManager } from 'typeorm';
import { CredentialInspectionWorker, CredentialLifecycleScheduler } from '../src/credentials/credential-lifecycle.service.js';
import type { CredentialInspectionPort, CredentialLifecyclePolicyPort, CredentialLifecycleSecretPort } from '../src/credentials/credential-lifecycle.types.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { JOB_POLICIES, parseJobPayload } from '../src/jobs/event-validation.js';
import type { ClaimedJob, JobStore } from '../src/jobs/job-store.js';
import { DurableWorker } from '../src/worker/durable-worker.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const credentialId = '00000000-0000-4000-8000-000000000002';
const authorizationId = '00000000-0000-4000-8000-000000000003';
const appConfigurationId = '00000000-0000-4000-8000-000000000004';
const leaseToken = '00000000-0000-4000-8000-000000000005';
const observedAt = '2026-11-03T12:00:00.000Z';
const expiryAt = '2026-11-04T12:00:00.000Z';

function syntheticPorts(callCounts: { secret: number; inspect: number; renew: number; replace: number;
  replacementMatched: boolean; fenceMatched: boolean }, health: 'HEALTHY' | 'EXPIRING' | 'REVOKED' = 'HEALTHY',
  expiryState: 'KNOWN' | 'PROVIDER_NO_EXPIRY' | 'UNKNOWN' = 'KNOWN', options: {
    readonly refreshEnabled?: boolean;
    readonly onRenewal?: () => Promise<void>;
  } = {}) {
  const policies: CredentialLifecyclePolicyPort = {
    forCredential: (flowVariant, authVariant, family) => family === 'SYNTHETIC_FAMILY' &&
      flowVariant === 'INSTAGRAM' && authVariant === 'INSTAGRAM_LOGIN'
      ? { flowVariant, authVariant, family, inspectEnabled: true, refreshEnabled: options.refreshEnabled ?? false, createReauthIntent: true,
        reauthImpactKey: 'SYNTHETIC_CREDENTIAL_ACCESS', checkIntervalSeconds: 3600, jitterPercent: 0 }
      : undefined,
  };
  const secrets: CredentialLifecycleSecretPort = {
    async withCredential(_binding, execute) { callCounts.secret += 1; await execute('synthetic-only-secret'); },
    async replaceCredentialWithin(_manager, _binding, fence, replacementSecret) {
      callCounts.replace += 1;
      callCounts.replacementMatched = replacementSecret === 'synthetic-renewal-result';
      callCounts.fenceMatched = fence.authorizationVersion === 3 && fence.credentialVersion === 7 &&
        fence.secretVersion === 4 && fence.lifecycleVersion === 2 && fence.generation === 1;
      return true;
    },
  };
  const inspector: CredentialInspectionPort = {
    async inspect(_binding, secret) {
      assert.equal(secret, 'synthetic-only-secret');
      callCounts.inspect += 1;
      return { health, issuedAt: observedAt, expiryState,
        expiresAt: expiryState === 'KNOWN' ? expiryAt : null, dataAccessExpiresAt: expiryAt,
        reasonCode: health === 'REVOKED' ? 'PERMISSION_REVOKED' : 'NONE' };
    },
  };
  const renewal = options.refreshEnabled ? {
    async renew() {
      callCounts.renew += 1;
      await options.onRenewal?.();
      return { replacementSecret: 'synthetic-renewal-result', observation: {
        health: 'HEALTHY' as const, issuedAt: observedAt, expiryState: 'KNOWN' as const,
        expiresAt: expiryAt, dataAccessExpiresAt: expiryAt, reasonCode: 'NONE' as const,
      } };
    },
  } : undefined;
  return { policies, secrets, inspector, renewal };
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
  assert.ok(fake.scheduleStatements.some((sql) => sql.includes('auth.flow_variant IS NOT NULL AND auth.auth_variant IS NOT NULL')));
});

async function runSyntheticLifecycle(input: { readonly adapter: boolean; readonly health?: 'HEALTHY' | 'EXPIRING' | 'REVOKED';
  readonly expiryState?: 'KNOWN' | 'PROVIDER_NO_EXPIRY' | 'UNKNOWN'; readonly refreshEnabled?: boolean;
  readonly authorizationChangesDuringRenewal?: boolean }) {
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

  const calls = { secret: 0, inspect: 0, renew: 0, replace: 0, replacementMatched: false, fenceMatched: false };
  const ports = syntheticPorts(calls, input.health, input.expiryState, {
    refreshEnabled: input.refreshEnabled,
    onRenewal: input.authorizationChangesDuringRenewal
      ? async () => fake.setAuthorization('REVOKED', 4) : undefined,
  });
  const processor = input.adapter
    ? new CredentialInspectionWorker(fake.database, ports.policies, ports.secrets, ports.inspector, () => 0.5, ports.renewal)
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

test('explicit synthetic renewal commits only with matching credential, secret, lifecycle, lease and authorization versions', async () => {
  const current = await runSyntheticLifecycle({ adapter: true, health: 'EXPIRING', refreshEnabled: true });
  assert.equal(current.calls.renew, 1);
  assert.equal(current.calls.replace, 1);
  assert.equal(current.calls.replacementMatched, true);
  assert.equal(current.calls.fenceMatched, true);
  assert.ok(current.fake.finalizedStatements.some(({ sql }) => sql.includes('SET issued_at = ?')));

  const concurrent = await runSyntheticLifecycle({ adapter: true, health: 'EXPIRING', refreshEnabled: true,
    authorizationChangesDuringRenewal: true });
  assert.equal(concurrent.calls.renew, 1);
  assert.equal(concurrent.calls.replace, 0, 'revoked and version-changed authorization prevents a late secret write');
  assert.ok(concurrent.fake.finalizedStatements.some(({ sql }) => sql.includes("IF(health_state = 'UNKNOWN', 'UNKNOWN', 'STALE')")));
  assert.equal(concurrent.fake.finalizedStatements.some(({ sql }) => sql.includes('SET issued_at = ?')), false);
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
