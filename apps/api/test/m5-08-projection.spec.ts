import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compareProjectionVersion, destinationKeyHash, projectionContentHash, validateProjectionRecord, validateProjectionTarget } from '../src/legacy-projection/legacy-projection.mapper.js';
import { LegacyProjectionService } from '../src/legacy-projection/legacy-projection.service.js';
import type {
  LegacyProjectionCheckpoint, LegacyProjectionCheckpointStore, LegacyProjectionDestination,
  LegacyProjectionDestinationCatalog, LegacyProjectionRecord, LegacyProjectionRebuildResult,
  LegacyProjectionSnapshot, LegacyProjectionTargetKey,
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
  async listByDestination(tenant: string, destination: string) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenant && row.destinationKeyHash === destination);
  }
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
      const existing = this.rows.get(key);
      if (!existing || row.sourceVersion > existing.sourceVersion) this.rows.set(key, row);
    }
  }

  async reconcile(input: {
    target: LegacyProjectionTargetKey; tenantId: string; records: readonly LegacyProjectionRecord[];
    knownOwnedCheckpoints: readonly LegacyProjectionCheckpoint[]; projectionSchemaVersion: number; destinationKeyHash: string;
  }): Promise<LegacyProjectionRebuildResult> {
    const prefix = `${input.target.legacyDatabaseId}\0${input.target.legacyCompanyId}\0`;
    const expected = new Map(input.records.map((record) => [record.centralRef, record]));
    const known = new Map(input.knownOwnedCheckpoints.map((checkpoint) => [checkpoint.centralRef, checkpoint]));
    const tombstones: LegacyProjectionRecord[] = [];
    let reconciledExtraCount = 0;
    let ambiguousExtraCount = 0;
    for (const [key, row] of this.rows) {
      if (!key.startsWith(prefix) || expected.has(row.centralRef)) continue;
      const checkpoint = known.get(row.centralRef);
      if (!checkpoint) { ambiguousExtraCount += 1; continue; }
      const tombstone = validateProjectionRecord({ ...row, status: 'REMOVED', tombstone: true,
        sourceVersion: row.tombstone ? row.sourceVersion : Math.max(row.sourceVersion, checkpoint.sourceVersion) + 1 });
      this.rows.set(key, tombstone);
      tombstones.push(tombstone);
      reconciledExtraCount += 1;
    }
    const expectedRows = input.records.map((row) => `${row.centralRef}:${projectionContentHash(row)}`).sort();
    const actualRows = [...this.rows.entries()]
      .filter(([key, row]) => key.startsWith(prefix) && expected.has(row.centralRef))
      .map(([, row]) => `${row.centralRef}:${projectionContentHash(row)}`).sort();
    const expectedHash = createHash('sha256').update(JSON.stringify(expectedRows)).digest('hex');
    const actualHash = createHash('sha256').update(JSON.stringify(actualRows)).digest('hex');
    const actualCount = actualRows.length;
    return Object.freeze({
      destinationKeyHash: input.destinationKeyHash, expectedCount: input.records.length, actualCount,
      reconciledExtraCount, ambiguousExtraCount, expectedHash, actualHash,
      parity: ambiguousExtraCount > 0 ? 'AMBIGUOUS' : expectedHash === actualHash ? 'MATCHED' : 'MISMATCH',
      tombstones: Object.freeze(tombstones),
    });
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

test('rebuild tombstones checkpoint-owned extras and reports unknown rows as ambiguous without changing them', async () => {
  const destination = new MemoryDestination();
  const store = new MemoryCheckpointStore();
  const projection = new LegacyProjectionService(store, new MemoryCatalog([{ target: dbACompanyA, destination }]));
  const stale = record({ centralRef: 'stale-owned-ref', legacyAssetRef: 'stale-owned-asset' });
  await projection.project(snapshot(event('outbox-stale', 1), [{ target: dbACompanyA, records: [stale] }]));
  const unknown = record({ centralRef: 'unknown-legacy-ref', legacyAssetRef: 'unknown-legacy-asset' });
  destination.rows.set('synthetic-db\0company-a\0unknown-legacy-asset', unknown);

  const report = await projection.rebuild({ tenantId, targets: [{ target: dbACompanyA, records: [record()] }] });
  assert.equal(report.destinations[0]?.state, 'FAILED');
  assert.equal(report.destinations[0]?.safeErrorCode, 'REBUILD_OWNERSHIP_AMBIGUOUS');
  assert.equal(report.rebuildReports?.[0]?.expectedCount, 1);
  assert.equal(report.rebuildReports?.[0]?.actualCount, 1);
  assert.equal(report.rebuildReports?.[0]?.reconciledExtraCount, 1);
  assert.equal(report.rebuildReports?.[0]?.ambiguousExtraCount, 1);
  assert.equal(report.rebuildReports?.[0]?.parity, 'AMBIGUOUS');
  assert.equal(destination.rows.get('synthetic-db\0company-a\0stale-owned-asset')?.tombstone, true);
  assert.equal(destination.rows.get('synthetic-db\0company-a\0unknown-legacy-asset')?.tombstone, false);
});

test('unknown source version with a changed hash fails the monotonic comparator', () => {
  assert.equal(compareProjectionVersion({ sourceVersion: 3, contentHash: 'a' }, { sourceVersion: 2, contentHash: 'a' }), 'STALE');
  assert.throws(() => compareProjectionVersion({ sourceVersion: 3, contentHash: 'a' }, { sourceVersion: 3, contentHash: 'b' }));
  assert.equal(compareProjectionVersion({ sourceVersion: 3, contentHash: 'a' }, { sourceVersion: 3, contentHash: 'a' }), 'DUPLICATE');
});
