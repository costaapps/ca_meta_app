import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareProjectionVersion, destinationKeyHash, projectionContentHash, validateProjectionRecord, validateProjectionTarget } from '../src/legacy-projection/legacy-projection.mapper.js';
import { LegacyProjectionService } from '../src/legacy-projection/legacy-projection.service.js';
import type {
  LegacyProjectionCheckpoint, LegacyProjectionCheckpointStore, LegacyProjectionDestination,
  LegacyProjectionDestinationCatalog, LegacyProjectionRecord, LegacyProjectionSnapshot, LegacyProjectionTargetKey,
} from '../src/legacy-projection/legacy-projection.types.js';
import type { OutboxEventEnvelope } from '../src/jobs/event-validation.js';

const tenantId = '90000000-0000-4000-8000-000000000088';
const dbACompanyA: LegacyProjectionTargetKey = { legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-a', environment: 'test' };
const dbACompanyB: LegacyProjectionTargetKey = { legacyDatabaseId: 'synthetic-db', legacyCompanyId: 'company-b', environment: 'test' };
const dbBCompanyC: LegacyProjectionTargetKey = { legacyDatabaseId: 'synthetic-db-b', legacyCompanyId: 'company-c', environment: 'test' };

function event(eventId: string, aggregateVersion: number): OutboxEventEnvelope {
  return Object.freeze({
    eventId, tenantRef: tenantId, schemaVersion: 1, eventType: 'connection.changed', aggregateRef: 'connection-ref',
    aggregateVersion, actor: { kind: 'SYSTEM' as const, ref: 'projection-test' }, correlationId: 'corr-m5-08', causationId: null,
    createdAt: '2026-11-11T00:00:00.000Z', enqueuedAt: '2026-11-11T00:00:00.000Z',
    data: { kind: 'CONNECTION_CHANGED', connectionRef: 'connection-ref', status: 'ACTIVE', observedAt: '2026-11-11T00:00:00.000Z' },
  });
}

function record(overrides: Partial<LegacyProjectionRecord> = {}): LegacyProjectionRecord {
  return Object.freeze({
    kind: 'PAGE', centralRef: 'central-asset-a', legacyAssetRef: 'legacy-page-1', sourceVersion: 1,
    status: 'ACTIVE', externalId: 'meta-page-id-1', displayName: 'Synthetic Page', assetKind: 'FACEBOOK_PAGE',
    parentLegacyAssetRef: null, capabilities: Object.freeze(['PAGES_READ']), configVersion: null, tombstone: false,
    ...overrides,
  });
}

function snapshot(
  currentEvent: OutboxEventEnvelope,
  targets: readonly { target: LegacyProjectionTargetKey; records: readonly LegacyProjectionRecord[] }[],
): LegacyProjectionSnapshot {
  return Object.freeze({ tenantId, event: currentEvent, targets });
}

class MemoryCheckpointStore implements LegacyProjectionCheckpointStore {
  readonly rows = new Map<string, LegacyProjectionCheckpoint>();
  private key(tenant: string, destination: string, ref: string): string { return `${tenant}\0${destination}\0${ref}`; }
  async read(tenant: string, destination: string, ref: string) { return this.rows.get(this.key(tenant, destination, ref)); }
  async record(checkpoint: LegacyProjectionCheckpoint) {
    this.rows.set(this.key(checkpoint.tenantId, checkpoint.destinationKeyHash, checkpoint.centralRef), checkpoint);
  }
}

class MemoryDestination implements LegacyProjectionDestination {
  readonly rows = new Map<string, LegacyProjectionRecord>();
  fail = false;
  async apply(input: { target: LegacyProjectionTargetKey; tenantId: string; records: readonly LegacyProjectionRecord[] }) {
    if (this.fail) throw new Error('synthetic destination outage');
    for (const row of input.records) {
      const key = `${input.target.legacyDatabaseId}\0${input.target.legacyCompanyId}\0${row.legacyAssetRef}`;
      this.rows.set(key, row);
    }
  }
}

class MemoryCatalog implements LegacyProjectionDestinationCatalog {
  constructor(readonly entries: readonly { target: LegacyProjectionTargetKey; destination: MemoryDestination }[]) {}
  resolve(target: LegacyProjectionTargetKey) {
    return this.entries.find((entry) => destinationKeyHash(entry.target) === destinationKeyHash(target))?.destination;
  }
}

test('destination key includes database, company and environment; projection DTO rejects unlisted fields', () => {
  assert.notEqual(destinationKeyHash(dbACompanyA), destinationKeyHash(dbACompanyB));
  assert.notEqual(destinationKeyHash(dbACompanyA), destinationKeyHash({ ...dbACompanyA, environment: 'production' }));
  assert.equal(projectionContentHash(record({ sourceVersion: 1 })), projectionContentHash(record({ sourceVersion: 3 })));
  assert.throws(() => validateProjectionTarget({ ...dbACompanyA, legacyCompanyId: 'company-a\n' }));
  assert.throws(() => validateProjectionRecord({ ...record(), token: 'synthetic-secret' } as unknown as LegacyProjectionRecord));
});

test('projection is idempotent and reprocessing a current tombstone does not resurrect the resource', async () => {
  const destination = new MemoryDestination();
  const store = new MemoryCheckpointStore();
  const projection = new LegacyProjectionService(store, new MemoryCatalog([{ target: dbACompanyA, destination }]));
  const first = snapshot(event('outbox-1', 1), [{ target: dbACompanyA, records: [record()] }]);
  assert.equal((await projection.project(first)).destinations[0]?.applied, 1);
  assert.equal((await projection.project(first)).destinations[0]?.duplicate, 1);

  const tombstone = record({ sourceVersion: 2, status: 'REMOVED', tombstone: true });
  const latest = snapshot(event('outbox-2', 2), [{ target: dbACompanyA, records: [tombstone] }]);
  assert.equal((await projection.project(latest)).destinations[0]?.applied, 1);
  // The source loader supplies the current snapshot even when a prior outbox event is retried.
  const oldEventWithCurrentSnapshot = snapshot(event('outbox-1', 1), [{ target: dbACompanyA, records: [tombstone] }]);
  assert.equal((await projection.project(oldEventWithCurrentSnapshot)).destinations[0]?.duplicate, 1);
  const projected = destination.rows.get('synthetic-db\0company-a\0legacy-page-1');
  assert.equal(projected?.tombstone, true);
  assert.equal(projected?.status, 'REMOVED');
});

test('same IdDatabase companies and separate destinations fail independently and recover on redelivery', async () => {
  const destinationA = new MemoryDestination();
  const destinationB = new MemoryDestination();
  destinationB.fail = true;
  const store = new MemoryCheckpointStore();
  const projection = new LegacyProjectionService(store, new MemoryCatalog([
    { target: dbACompanyA, destination: destinationA },
    { target: dbACompanyB, destination: destinationA },
    { target: dbBCompanyC, destination: destinationB },
  ]));
  const multiTenantSnapshot = snapshot(event('outbox-multi', 1), [
    { target: dbACompanyA, records: [record({ centralRef: 'asset-a', legacyAssetRef: 'same-legacy-row' })] },
    { target: dbACompanyB, records: [record({ centralRef: 'asset-b', legacyAssetRef: 'same-legacy-row' })] },
    { target: dbBCompanyC, records: [record({ centralRef: 'asset-c', legacyAssetRef: 'second-database-row' })] },
  ]);
  const failed = await projection.project(multiTenantSnapshot);
  assert.deepEqual(failed.destinations.map((destination) => destination.state), ['SYNCED', 'SYNCED', 'PENDING']);
  assert.equal(destinationA.rows.size, 2);
  assert.equal(destinationA.rows.has('synthetic-db\0company-a\0same-legacy-row'), true);
  assert.equal(destinationA.rows.has('synthetic-db\0company-b\0same-legacy-row'), true);
  assert.equal(destinationB.rows.size, 0);

  destinationB.fail = false;
  const recovered = await projection.project(multiTenantSnapshot);
  assert.equal(recovered.destinations[2]?.state, 'SYNCED');
  assert.equal(destinationB.rows.size, 1);
});

test('full rebuild repairs a missing legacy row from the trusted current snapshot', async () => {
  const destination = new MemoryDestination();
  const store = new MemoryCheckpointStore();
  const projection = new LegacyProjectionService(store, new MemoryCatalog([{ target: dbACompanyA, destination }]));
  const current = Object.freeze({ tenantId, targets: [{ target: dbACompanyA, records: [record()] }] });
  assert.equal((await projection.rebuild(current)).destinations[0]?.applied, 1);
  destination.rows.clear();
  const rebuilt = await projection.rebuild(current);
  assert.equal(rebuilt.destinations[0]?.applied, 1);
  assert.equal(destination.rows.size, 1);
  assert.equal(destination.rows.get('synthetic-db\0company-a\0legacy-page-1')?.externalId, 'meta-page-id-1');
});

test('unknown source version with a changed hash fails the monotonic comparator', () => {
  assert.equal(compareProjectionVersion({ sourceVersion: 3, contentHash: 'a' }, { sourceVersion: 2, contentHash: 'a' }), 'STALE');
  assert.throws(() => compareProjectionVersion({ sourceVersion: 3, contentHash: 'a' }, { sourceVersion: 3, contentHash: 'b' }));
  assert.equal(compareProjectionVersion({ sourceVersion: 3, contentHash: 'a' }, { sourceVersion: 3, contentHash: 'a' }), 'DUPLICATE');
});
