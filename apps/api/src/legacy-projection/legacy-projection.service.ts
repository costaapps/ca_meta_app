import type {
  LegacyProjectionCheckpointStore,
  LegacyProjectionDestinationCatalog,
  LegacyProjectionRecord,
  LegacyProjectionRebuildSnapshot,
  LegacyProjectionResult,
  LegacyProjectionSnapshot,
} from './legacy-projection.types.js';
import { LegacyProjectionError } from './legacy-projection.types.js';
import { destinationKeyHash, projectionContentHash, validateProjectionRecord, validateProjectionTarget } from './legacy-projection.mapper.js';

export const LEGACY_PROJECTION_SCHEMA_VERSION = 1;

function supportedEvent(eventType: string): boolean {
  return eventType === 'connection.changed' || eventType === 'automation.config.changed';
}

function safeProjectionError(error: unknown): { readonly state: 'PENDING' | 'FAILED'; readonly code: string } {
  if (error instanceof LegacyProjectionError) {
    if (error.safeCode === 'PROJECTION_VERSION_CONFLICT') {
      return { state: 'PENDING', code: error.safeCode };
    }
    return { state: 'FAILED', code: error.safeCode };
  }
  return { state: 'PENDING', code: 'DESTINATION_UNAVAILABLE' };
}

/** Projects only a fresh, server-loaded central snapshot. Event payloads supply references, never destination IDs or content. */
export class LegacyProjectionService {
  constructor(
    private readonly checkpoints: LegacyProjectionCheckpointStore,
    private readonly destinations: LegacyProjectionDestinationCatalog,
  ) {}

  async project(snapshot: LegacyProjectionSnapshot): Promise<LegacyProjectionResult> {
    const { event } = snapshot;
    if (snapshot.tenantId !== event.tenantRef || !supportedEvent(event.eventType)) {
      throw new LegacyProjectionError('UNSUPPORTED_PROJECTION_EVENT', 'Outbox event is not eligible for metadata projection.');
    }
    return this.applySnapshot(snapshot, false);
  }

  /** Replays the full trusted current-state scan; target upserts restore missing rows without resetting versions. */
  async rebuild(snapshot: LegacyProjectionRebuildSnapshot): Promise<LegacyProjectionResult> {
    return this.applySnapshot(snapshot, true);
  }

  private async applySnapshot(
    snapshot: LegacyProjectionRebuildSnapshot,
    forceRebuild: boolean,
  ): Promise<LegacyProjectionResult> {
    const seen = new Set<string>();
    const results: LegacyProjectionResult['destinations'][number][] = [];
    const rebuildReports: NonNullable<LegacyProjectionResult['rebuildReports']>[number][] = [];
    for (const group of snapshot.targets) {
      validateProjectionTarget(group.target);
      const keyHash = destinationKeyHash(group.target);
      if (seen.has(keyHash)) throw new LegacyProjectionError('DUPLICATE_DESTINATION', 'Projection snapshot repeats a destination.');
      seen.add(keyHash);
      const destination = this.destinations.resolve(group.target);
      let applied = 0;
      let duplicate = 0;
      let stale = 0;
      let prepared: Array<{ readonly record: LegacyProjectionRecord; readonly contentHash: string }> = [];
      try {
        const priorCheckpoints = forceRebuild
          ? await this.checkpoints.listByDestination(snapshot.tenantId, keyHash) : [];
        const seenRecords = new Set<string>();
        for (const input of group.records) {
          const record = validateProjectionRecord(input);
          if (seenRecords.has(record.centralRef)) {
            throw new LegacyProjectionError('DUPLICATE_PROJECTION_RECORD', 'Projection snapshot repeats a central resource.');
          }
          seenRecords.add(record.centralRef);
          const contentHash = projectionContentHash(record);
          const current = await this.checkpoints.read(snapshot.tenantId, keyHash, record.centralRef);
          if (current) {
            if (!forceRebuild && current.contentHash === contentHash && current.state === 'SYNCED') { duplicate += 1; continue; }
            // The source adapter loaded the current central row, so a changed snapshot advances
            // the destination revision even if independent source counters share/reset values.
            const effectiveVersion = current.contentHash === contentHash
              ? current.sourceVersion
              : current.sourceVersion + 1;
            prepared.push({ record: Object.freeze({ ...record, sourceVersion: effectiveVersion }), contentHash });
          } else {
            prepared.push({ record, contentHash });
          }
        }

        if (!destination) {
          const code = 'DESTINATION_NOT_ALLOWLISTED';
          for (const item of prepared) await this.checkpoints.record({
            tenantId: snapshot.tenantId, destinationKeyHash: keyHash, centralRef: item.record.centralRef,
            sourceVersion: item.record.sourceVersion, projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
            contentHash: item.contentHash, tombstone: item.record.tombstone, state: 'FAILED', safeErrorCode: code,
          });
          results.push({ destinationKeyHash: keyHash, applied: 0, duplicate, stale, state: 'FAILED', safeErrorCode: code });
          continue;
        }

        for (const item of prepared) await this.checkpoints.record({
          tenantId: snapshot.tenantId, destinationKeyHash: keyHash, centralRef: item.record.centralRef,
          sourceVersion: item.record.sourceVersion, projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
          contentHash: item.contentHash, tombstone: item.record.tombstone, state: 'PENDING', safeErrorCode: null,
        });
        if (prepared.length > 0) {
          await destination.apply({
            target: group.target, tenantId: snapshot.tenantId,
            records: prepared.map((item) => item.record), projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
          });
        }
        if (forceRebuild) {
          if (!destination.reconcile) {
            throw new LegacyProjectionError('REBUILD_UNSUPPORTED', 'Destination cannot safely report projector ownership for rebuild.');
          }
          const known = new Map(priorCheckpoints.map((checkpoint) => [checkpoint.centralRef, checkpoint]));
          for (const item of prepared) known.set(item.record.centralRef, {
            tenantId: snapshot.tenantId, destinationKeyHash: keyHash, centralRef: item.record.centralRef,
            sourceVersion: item.record.sourceVersion, projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
            contentHash: item.contentHash, tombstone: item.record.tombstone, state: 'PENDING', safeErrorCode: null,
          });
          const rebuild = await destination.reconcile({
            target: group.target, tenantId: snapshot.tenantId, records: prepared.map((item) => item.record),
            knownOwnedCheckpoints: [...known.values()], projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
            destinationKeyHash: keyHash,
          });
          rebuildReports.push({
            destinationKeyHash: keyHash, expectedCount: rebuild.expectedCount, actualCount: rebuild.actualCount,
            reconciledExtraCount: rebuild.reconciledExtraCount, ambiguousExtraCount: rebuild.ambiguousExtraCount,
            expectedHash: rebuild.expectedHash, actualHash: rebuild.actualHash, parity: rebuild.parity,
          });
          for (const tombstone of rebuild.tombstones) await this.checkpoints.record({
            tenantId: snapshot.tenantId, destinationKeyHash: keyHash, centralRef: tombstone.centralRef,
            sourceVersion: tombstone.sourceVersion, projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
            contentHash: projectionContentHash(tombstone), tombstone: true, state: 'SYNCED', safeErrorCode: null,
          });
          if (rebuild.parity === 'AMBIGUOUS') {
            throw new LegacyProjectionError('REBUILD_OWNERSHIP_AMBIGUOUS', 'Destination contains extras without a tenant-owned checkpoint.');
          }
          if (rebuild.parity === 'MISMATCH') {
            throw new LegacyProjectionError('REBUILD_PARITY_MISMATCH', 'Destination rows do not match the trusted projection snapshot.');
          }
        }
        for (const item of prepared) await this.checkpoints.record({
          tenantId: snapshot.tenantId, destinationKeyHash: keyHash, centralRef: item.record.centralRef,
          sourceVersion: item.record.sourceVersion, projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
          contentHash: item.contentHash, tombstone: item.record.tombstone, state: 'SYNCED', safeErrorCode: null,
        });
        applied = prepared.length;
        results.push({ destinationKeyHash: keyHash, applied, duplicate, stale, state: 'SYNCED', safeErrorCode: null });
      } catch (error) {
        const failure = safeProjectionError(error);
        for (const item of prepared) await this.checkpoints.record({
          tenantId: snapshot.tenantId, destinationKeyHash: keyHash, centralRef: item.record.centralRef,
          sourceVersion: item.record.sourceVersion, projectionSchemaVersion: LEGACY_PROJECTION_SCHEMA_VERSION,
          contentHash: item.contentHash, tombstone: item.record.tombstone, state: failure.state, safeErrorCode: failure.code,
        }).catch(() => undefined);
        results.push({ destinationKeyHash: keyHash, applied: 0, duplicate, stale,
          state: failure.state, safeErrorCode: failure.code });
      }
      prepared = [];
    }
    return Object.freeze({
      destinations: Object.freeze(results),
      ...(forceRebuild ? { rebuildReports: Object.freeze(rebuildReports) } : {}),
    });
  }
}
