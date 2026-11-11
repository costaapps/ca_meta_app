import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { canonicalJson, isUuid, parseOutboxEvent, type OutboxEventEnvelope } from '../jobs/event-validation.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { ClaimedJob, JobFinalization, JobStore } from '../jobs/job-store.js';
import type { LegacyProjectionJobScheduler } from '../legacy-projection/legacy-projection.jobs.js';

export interface AppendOutboxResult {
  readonly id: string;
  readonly jobId: string | null;
  readonly duplicate: boolean;
}

interface ExistingOutboxRow {
  id: string;
  payload_hash: string;
}

function mysqlDate(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000`;
}

function resourceScope(event: OutboxEventEnvelope): string {
  const target = typeof event.data['assetRef'] === 'string' ? event.data['assetRef'] : event.aggregateRef;
  return `target:${createHash('sha256').update(target).digest('hex')}`;
}

/** Append with the caller's EntityManager so the caller's state update and delivery intent commit together. */
export class OutboxService {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly jobs: JobStore,
    private readonly projectionJobs?: LegacyProjectionJobScheduler,
  ) {}

  async append(eventValue: unknown): Promise<AppendOutboxResult> {
    const dataSource = await this.database.getDataSource();
    return dataSource.transaction((manager) => this.appendWithin(manager, eventValue));
  }

  async appendWithin(manager: EntityManager, eventValue: unknown): Promise<AppendOutboxResult> {
    const event = parseOutboxEvent(eventValue);
    if (!isUuid(event.tenantRef)) throw new Error('Outbox tenant reference must be an internal tenant UUID.');
    const serialized = canonicalJson(event);
    const payloadHash = createHash('sha256').update(serialized).digest();
    const existing = await manager.query(
      `SELECT id, HEX(payload_hash) AS payload_hash FROM ca_meta_outbox_events
       WHERE tenant_id = ? AND event_id = ? FOR UPDATE`,
      [event.tenantRef, event.eventId],
    ) as ExistingOutboxRow[];
    const existingRow = existing[0];
    if (existingRow) {
      if (existingRow.payload_hash.toLowerCase() !== payloadHash.toString('hex')) {
        throw new Error('Outbox event ID conflicts with different normalized content.');
      }
      return { id: existingRow.id, jobId: null, duplicate: true };
    }

    const id = randomUUID();
    await manager.query(
      `INSERT INTO ca_meta_outbox_events
       (id, tenant_id, event_id, aggregate_ref, aggregate_version, schema_version, event_type,
        idempotency_key, correlation_id, causation_id, payload_hash, payload_json, delivery_state,
        attempt, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL)`,
      [
        id, event.tenantRef, event.eventId, event.aggregateRef, event.aggregateVersion,
        event.schemaVersion, event.eventType, `outbox:${createHash('sha256').update(event.eventId).digest('hex')}`,
        event.correlationId, event.causationId, payloadHash, serialized, mysqlDate(event.enqueuedAt),
      ],
    );
    const job = await this.jobs.enqueueWithin(manager, {
      tenantId: event.tenantRef,
      type: 'OUTBOX_DELIVER',
      idempotencyKey: `outbox:${createHash('sha256').update(event.eventId).digest('hex')}`,
      correlationId: event.correlationId,
      causationId: event.causationId,
      resourceScopeRef: resourceScope(event),
      payload: { kind: 'OUTBOX_DELIVER', outboxEventRef: id },
    });
    await this.projectionJobs?.enqueueWithin(manager, event, id);
    return { id, jobId: job.id, duplicate: false };
  }

  async finalizeDeliveryWithin(manager: EntityManager, job: ClaimedJob, finalization: JobFinalization): Promise<void> {
    if (job.type !== 'OUTBOX_DELIVER' || job.payload.kind !== 'OUTBOX_DELIVER') {
      throw new Error('Outbox finalizer received a different job type.');
    }
    const deliveryState = finalization.status === 'SUCCEEDED' ? 'DELIVERED' :
      finalization.status === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'UNKNOWN';
    const result: unknown = await manager.query(
      `UPDATE ca_meta_outbox_events SET delivery_state = ?, attempt = ?,
         delivered_at = CASE WHEN ? = 'DELIVERED' THEN UTC_TIMESTAMP(6) ELSE delivered_at END
       WHERE id = ? AND tenant_id = ? AND delivery_state = 'PENDING'`,
      [deliveryState, job.attempt, deliveryState, job.payload.outboxEventRef, job.tenantId],
    );
    const header = Array.isArray(result) ? result[0] : result;
    const affected = typeof header === 'object' && header !== null && 'affectedRows' in header
      ? Number((header as { affectedRows?: number }).affectedRows ?? 0)
      : 0;
    if (affected !== 1) throw new Error('Outbox event is missing or no longer pending.');
  }
}
