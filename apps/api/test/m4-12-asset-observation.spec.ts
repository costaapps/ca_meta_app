import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetRefreshCoordinator, AssetRefreshRateLimitError } from '../src/meta-assets/asset-refresh.service.js';
import {
  isAssetObservationStale,
  reduceAssetObservation,
  toPublicAssetStatusObservation,
  validateAssetObservationInput,
  type AssetObservationInput,
  type AssetObservationSnapshot,
} from '../src/meta-assets/asset-observation.service.js';
import { MysqlAssetObservationRepository } from '../src/meta-assets/mysql-asset-observation.repository.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import type { DurableJobStore } from '../src/jobs/job-store.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const assetId = '10000000-0000-4000-8000-000000000002';
const authorizationId = '10000000-0000-4000-8000-000000000004';
const appConfigurationId = '10000000-0000-4000-8000-000000000003';
const observedAt = '2026-11-10T12:00:00.000Z';

function observation(overrides: Partial<AssetObservationInput> = {}): AssetObservationInput {
  return Object.freeze({
    kind: 'FACEBOOK_PAGE' as const, source: 'META_API' as const, observedAt,
    status: { value: 'ACTIVE' as const, availability: 'OBSERVED' as const },
    permissions: { availability: 'OBSERVED' as const, grantNames: ['pages_show_list'] },
    subscriptionState: 'ACTIVE' as const, projectionState: 'SYNCED' as const,
    ...overrides,
  });
}

function snapshot(input = observation(), previous: AssetObservationSnapshot | null = null, version = 1) {
  return reduceAssetObservation({ previous, authorizationRef: authorizationId, incoming: input,
    fetchedAt: '2026-11-10T12:00:01.000Z', nextVersion: version });
}

test('M4.12 keeps status unavailable distinct from negative and retains last known permissions', () => {
  const first = snapshot();
  assert.ok(first);
  const failed = snapshot({
    kind: 'FACEBOOK_PAGE', source: 'META_API', observedAt: null,
    status: { value: 'UNAVAILABLE', availability: 'UNAVAILABLE', providerCode: 'DEPENDENCY_UNAVAILABLE' },
    permissions: { availability: 'UNAVAILABLE' },
  }, first, 2);
  assert.ok(failed);
  assert.equal(failed.status.value, 'ACTIVE', 'an outage does not become a negative asset status');
  assert.equal(failed.status.availability, 'UNAVAILABLE');
  assert.deepEqual(failed.permissions.grantNames, ['pages_show_list']);
  assert.equal(isAssetObservationStale(failed, '2026-11-10T12:00:02.000Z'), true);
  const publicObservation = toPublicAssetStatusObservation(failed, 'VERIFIED', '2026-11-10T12:00:02.000Z');
  assert.equal(publicObservation.status, 'STALE');
  assert.equal(publicObservation.availability, 'UNAVAILABLE');
  assert.equal(publicObservation.actionableReason, 'CHECK_STATUS');
  assert.equal('grantNames' in publicObservation, false, 'the portal receives state, not raw grant-name lists');
  assert.equal(failed.version, 2);
});

test('M4.12 ignores late observations and preserves a safe token for an unknown provider enum', () => {
  const current = snapshot();
  assert.ok(current);
  const late = snapshot(observation({ observedAt: '2026-11-10T11:59:59.000Z',
    status: { value: 'INACTIVE', availability: 'OBSERVED' } }), current, 2);
  assert.equal(late, null);
  const unknown = snapshot(observation({ status: { value: 'UNKNOWN', availability: 'UNKNOWN', providerCode: 'NEW_STATUS_9' } }), current, 2);
  assert.ok(unknown);
  assert.equal(unknown.status.value, 'ACTIVE', 'an unmapped status does not replace the last known normalized state');
  assert.equal(unknown.status.availability, 'UNKNOWN');
  assert.equal(unknown.status.providerCode, 'NEW_STATUS_9');
  const revoked = toPublicAssetStatusObservation(current, 'REVOKED', '2026-11-10T12:00:02.000Z');
  assert.equal(revoked.actionableReason, 'REAUTHORIZE');
  assert.equal(revoked.status, 'ACTIVE', 'observed status does not overwrite authorization revocation');
});

test('M4.12 detects permission, subscription, and projection drift without repairing provider state', () => {
  const current = snapshot();
  assert.ok(current);
  const changed = snapshot(observation({ observedAt: '2026-11-10T12:00:02.000Z',
    permissions: { availability: 'OBSERVED', grantNames: [] },
    subscriptionState: 'FAILED', projectionState: 'STALE',
  }), current, 2);
  assert.ok(changed);
  assert.deepEqual(changed.driftCodes, ['PERMISSIONS_CHANGED', 'PROJECTION_STALE', 'SUBSCRIPTION_CHANGED']);
  assert.deepEqual(current.permissions.grantNames, ['pages_show_list'], 'append-only reducer does not mutate prior snapshots');
});

test('M4.12 accepts only bounded, shared catalog dimensions for the four resource families', () => {
  const kinds: AssetObservationInput['kind'][] = [
    'FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS_ACCOUNT', 'INSTAGRAM_CREATOR_ACCOUNT',
    'WHATSAPP_BUSINESS_ACCOUNT', 'WHATSAPP_PHONE_NUMBER',
  ];
  for (const kind of kinds) validateAssetObservationInput(observation({ kind }));
  assert.throws(() => validateAssetObservationInput(observation({
    permissions: { availability: 'OBSERVED', grantNames: Array.from({ length: 257 }, (_, index) => `grant_${index}`) },
  })));
  assert.throws(() => validateAssetObservationInput(observation({
    status: { value: 'UNKNOWN', availability: 'UNKNOWN', providerCode: 'provider response included customer payload' },
  })));
});

test('M4.12 repository locks and writes only within the requested tenant and stores a versioned snapshot', async () => {
  const statements: string[] = [];
  let inserted: unknown[] | undefined;
  let bindingActive = true;
  const manager = {
    async query(sql: string, parameters: unknown[] = []) {
      statements.push(sql);
      if (sql.includes('FROM ca_meta_tenants')) return parameters[0] === tenantId ? [{ id: tenantId }] : [];
      if (sql.includes('FROM ca_meta_asset_authorizations')) return bindingActive && parameters[0] === tenantId &&
          parameters[1] === authorizationId && parameters[2] === assetId
        ? [{ id: assetId, asset_kind: 'FACEBOOK_PAGE' }] : [];
      if (sql.includes('FROM ca_meta_asset_observations')) return [];
      if (sql.includes('INSERT INTO ca_meta_asset_observations')) { inserted = parameters; return []; }
      throw new Error('Unexpected synthetic SQL statement.');
    },
  };
  const dataSource = {
    async transaction<T>(run: (managerValue: typeof manager) => Promise<T>) { return run(manager); },
    async query() { return []; },
  };
  const repository = new MysqlAssetObservationRepository({ async getDataSource() { return dataSource; } } as unknown as DurableWorkDatabase,
    () => new Date('2026-11-10T12:00:01.000Z'));
  const written = await repository.record({ tenantId, authorizationId, assetId, observation: observation() });
  assert.equal(written.kind, 'RECORDED');
  assert.ok(inserted);
  const stored = JSON.parse(String(inserted[9])) as Record<string, unknown>;
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.version, 1);
  assert.equal(stored.authorizationRef, authorizationId);
  assert.equal('providerPayload' in stored, false);
  assert.ok(statements.some((sql) => sql.includes("aa.state = 'ACTIVE' AND aa.verification_state = 'VERIFIED'")));
  assert.equal(statements.some((sql) => /UPDATE\s+ca_meta_(?:authorizations|asset_authorizations|asset_grants|credentials)/i.test(sql)), false);

  bindingActive = false;
  const suppressed = await repository.record({ tenantId, authorizationId, assetId, observation: observation() });
  assert.equal(suppressed.kind, 'SUPPRESSED_REVOKED');
  assert.equal(inserted?.length, 11, 'a late observation after revocation creates no new version');

  await assert.rejects(repository.record({ tenantId: '20000000-0000-4000-8000-000000000001', authorizationId,
    assetId, observation: observation() }));
});

test('M4.12 refresh admission coalesces active work and enforces a per-asset cooldown budget', async () => {
  let activeId: string | undefined;
  let budgetReached = false;
  let enqueueCount = 0;
  const manager = {
    async query(sql: string) {
      if (sql.includes('FROM ca_meta_tenants')) return [{ id: tenantId }];
      if (sql.includes('FROM ca_meta_jobs') && sql.includes("status IN ('QUEUED', 'RETRY_PENDING', 'RUNNING')")) {
        return activeId ? [{ id: activeId }] : [];
      }
      if (sql.includes('FROM ca_meta_jobs')) return budgetReached ? [{ id: '10000000-0000-4000-8000-000000000004' }] : [];
      throw new Error('Unexpected synthetic SQL statement.');
    },
  };
  const database = {
    async getDataSource() {
      return { async transaction<T>(run: (managerValue: typeof manager) => Promise<T>) { return run(manager); } };
    },
  } as unknown as DurableWorkDatabase;
  const jobs = {
    async enqueueWithin() { enqueueCount += 1; activeId = '10000000-0000-4000-8000-000000000005'; return { id: activeId }; },
  } as unknown as DurableJobStore;
  const coordinator = new AssetRefreshCoordinator(database, jobs, { async refresh() {
    return [{ authorizationId, observation: observation() }];
  } });
  const input = { tenantId, assetId, appConfigurationId, environment: 'test' as const, requestId: 'request-synthetic' };
  const first = await coordinator.enqueue(input);
  const coalesced = await coordinator.enqueue(input);
  assert.equal(first.jobId, coalesced.jobId);
  assert.equal(enqueueCount, 1);
  activeId = undefined;
  budgetReached = true;
  await assert.rejects(coordinator.enqueue(input), AssetRefreshRateLimitError);
  assert.equal(enqueueCount, 1);
});
