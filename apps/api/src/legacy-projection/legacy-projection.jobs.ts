import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { JobOutcome } from '../jobs/job-store.js';
import type { JobHandler } from '../worker/durable-worker.js';
import type { JobType } from '../jobs/event-validation.js';
import type { JobStore } from '../jobs/job-store.js';
import type { OutboxEventEnvelope } from '../jobs/event-validation.js';
import type { LegacyProjectionSource } from './legacy-projection.types.js';
import { LegacyProjectionError } from './legacy-projection.types.js';
import { LegacyProjectionService } from './legacy-projection.service.js';

export interface LegacyProjectionJobScheduler {
  enqueueWithin(manager: EntityManager, event: OutboxEventEnvelope, outboxEventId: string): Promise<void>;
}

function projectable(event: OutboxEventEnvelope): boolean {
  return event.eventType === 'connection.changed' || event.eventType === 'automation.config.changed';
}

/** Optional hook for producers that have an allowlisted destination runtime. Appending remains atomic with source state. */
export class DurableLegacyProjectionJobScheduler implements LegacyProjectionJobScheduler {
  constructor(private readonly jobs: JobStore) {}

  async enqueueWithin(manager: EntityManager, event: OutboxEventEnvelope, outboxEventId: string): Promise<void> {
    if (!projectable(event)) return;
    const digest = createHash('sha256').update(outboxEventId, 'utf8').digest('hex');
    // CONNECTION_CHANGED identifies an authorization, while one asset can belong to
    // multiple authorizations. Serialize the tenant's connection snapshots together
    // so two authorization events cannot project competing views concurrently.
    const resourceRef = event.eventType === 'connection.changed'
      ? 'tenant-connection-snapshot'
      : typeof event.data['assetRef'] === 'string' ? event.data['assetRef'] : event.aggregateRef;
    const resourceDigest = createHash('sha256')
      .update(JSON.stringify([event.tenantRef, resourceRef]), 'utf8')
      .digest('hex');
    await this.jobs.enqueueWithin(manager, {
      tenantId: event.tenantRef,
      type: 'PROJECTION_RECONCILE',
      idempotencyKey: `legacy-projection:${digest}`,
      correlationId: event.correlationId,
      causationId: event.causationId,
      // The queue fences active jobs by tenant + resourceScopeRef. Keep distinct event
      // idempotency keys while serializing shared connection snapshots tenant-wide.
      resourceScopeRef: `projection:${resourceDigest}`,
      payload: { kind: 'PROJECTION_RECONCILE', projectionRef: outboxEventId, sourceVersion: event.aggregateVersion },
    });
  }
}

export function createLegacyProjectionJobHandler(
  source: LegacyProjectionSource,
  projection: LegacyProjectionService,
): JobHandler {
  return async (job): Promise<JobOutcome> => {
    if (job.type !== 'PROJECTION_RECONCILE' || job.payload.kind !== 'PROJECTION_RECONCILE') {
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
    }
    let snapshot;
    try {
      snapshot = await source.loadCurrent(job.tenantId, job.payload.projectionRef, job.payload.sourceVersion);
    } catch (error) {
      if (error instanceof LegacyProjectionError) {
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: error.safeCode };
      }
      // A driver/network error from the central source may recover; let the durable
      // job policy retry it, while exposing only a stable safe code to operators.
      return { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' };
    }
    if (!snapshot) return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'SOURCE_NOT_FOUND' };
    try {
      const result = await projection.project(snapshot);
      if (result.destinations.some((destination) => destination.state === 'PENDING')) {
        const conflict = result.destinations.find((destination) => destination.safeErrorCode === 'PROJECTION_VERSION_CONFLICT');
        return { kind: 'RETRYABLE_FAILURE', safeErrorCode: conflict ? 'DEPENDENCY_UNAVAILABLE' : 'DESTINATION_UNAVAILABLE' };
      }
      if (result.destinations.some((destination) => destination.state === 'FAILED')) {
        return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'DESTINATION_NOT_READY' };
      }
      return { kind: 'SUCCEEDED' };
    } catch (error) {
      if (error instanceof LegacyProjectionError && error.safeCode === 'PROJECTION_VERSION_CONFLICT') {
        // Retry invokes loadCurrent again, so the calculation uses the latest committed state.
        return { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' };
      }
      return { kind: 'PERMANENT_FAILURE', safeErrorCode: error instanceof LegacyProjectionError ? error.safeCode : 'PROJECTION_INVALID' };
    }
  };
}

/** Type-only sentinel prevents accidental expansion of worker policies in this package. */
export type LegacyProjectionJobType = Extract<JobType, 'PROJECTION_RECONCILE'>;
