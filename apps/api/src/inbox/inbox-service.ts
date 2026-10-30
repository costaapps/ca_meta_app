import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { canonicalJson, parseInboxEvent, type InboxEventEnvelope } from '../jobs/event-validation.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { ClaimedJob, JobFinalization, JobStore } from '../jobs/job-store.js';

export interface PersistInboxResult {
  readonly id: string;
  readonly duplicate: boolean;
  readonly routingState: InboxEventEnvelope['routingState'];
  readonly jobId: string | null;
}

interface ExistingInboxRow {
  id: string;
  payload_hash: string;
}

function opaqueScope(kind: string, reference: string): string {
  return `${kind}:${createHash('sha256').update(reference).digest('hex')}`;
}

function mysqlDate(value: string): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000`;
}

function resourceReference(event: InboxEventEnvelope): string {
  const metadata = event.safeMetadata;
  for (const key of ['assetRef', 'authorizationRef', 'subscriptionRef', 'callbackRef', 'eventRef']) {
    const value = metadata[key];
    if (typeof value === 'string') return opaqueScope(key, value);
  }
  return opaqueScope('inbox-event', event.eventId);
}

function semanticPayloadHash(event: InboxEventEnvelope): Buffer {
  // Provider redelivery may change local receive time, correlation, routing, or protected-store handle.
  // Compare normalized provider meaning so a transport refresh does not become a false content conflict.
  const semantic = {
    appConfigRef: event.appConfigRef,
    eventId: event.eventId,
    eventType: event.eventType,
    actor: event.actor,
    aggregateRef: event.aggregateRef ?? null,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    safeMetadata: event.safeMetadata,
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest();
}

export class InboxService {
  constructor(private readonly database: DurableWorkDatabase, private readonly jobs: JobStore) {}

  async persist(value: unknown): Promise<PersistInboxResult> {
    // The external caller supplies no tenant authority. Route using the server-owned app config row.
    const input = parseInboxEvent(value);
    if (input.tenantRef !== null || (input.routingState !== 'PENDING' && input.routingState !== 'QUARANTINED')) {
      throw new Error('Inbox tenant routing must be resolved by the server.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.appConfigRef)) {
      throw new Error('Invalid application configuration reference.');
    }

    const dataSource = await this.database.getDataSource();
    return dataSource.transaction((manager) => this.persistWithin(manager, input));
  }

  async finalizeProcessingWithin(manager: EntityManager, job: ClaimedJob, finalization: JobFinalization): Promise<void> {
    if (job.type !== 'INBOX_PROCESS' || job.payload.kind !== 'INBOX_PROCESS') {
      throw new Error('Inbox finalizer received a different job type.');
    }
    const processingState = finalization.status === 'SUCCEEDED' ? 'PROCESSED' :
      finalization.status === 'RETRY_PENDING' ? 'PENDING' : finalization.status;
    const result: unknown = await manager.query(
      `UPDATE ca_meta_inbox_events SET processing_state = ?
       WHERE id = ? AND tenant_id = ? AND routing_state = 'ROUTED' AND processing_state IN ('PENDING', 'RUNNING')`,
      [processingState, job.payload.inboxEventRef, job.tenantId],
    );
    const header = Array.isArray(result) ? result[0] : result;
    const affected = typeof header === 'object' && header !== null && 'affectedRows' in header
      ? Number((header as { affectedRows?: number }).affectedRows ?? 0)
      : 0;
    if (affected !== 1) throw new Error('Inbox event is missing or no longer processable.');
  }

  private async persistWithin(
    manager: EntityManager,
    input: InboxEventEnvelope,
  ): Promise<PersistInboxResult> {
    const configRows = await manager.query(
      'SELECT tenant_id FROM ca_meta_app_configurations WHERE id = ? FOR UPDATE',
      [input.appConfigRef],
    ) as Array<{ tenant_id: string }>;
    const isUnclassified = input.eventType === 'provider.unclassified';
    const tenantId = isUnclassified ? null : (configRows[0]?.tenant_id ?? null);
    const routingState: InboxEventEnvelope['routingState'] = isUnclassified
      ? 'QUARANTINED'
      : tenantId ? 'ROUTED' : 'QUARANTINED';
    const event = parseInboxEvent({
      ...input,
      tenantRef: tenantId,
      routingState,
    });
    const serialized = canonicalJson(event);
    const payloadHash = semanticPayloadHash(event);
    const existing = await manager.query(
      `SELECT id, HEX(payload_hash) AS payload_hash FROM ca_meta_inbox_events
       WHERE app_config_ref = ? AND provider_event_id = ? FOR UPDATE`,
      [event.appConfigRef, event.eventId],
    ) as ExistingInboxRow[];
    const existingRow = existing[0];
    if (existingRow) {
      if (existingRow.payload_hash.toLowerCase() !== payloadHash.toString('hex')) {
        throw new Error('Inbox provider event ID conflicts with different normalized content.');
      }
      return { id: existingRow.id, duplicate: true, routingState, jobId: null };
    }

    const id = randomUUID();
    await manager.query(
      `INSERT INTO ca_meta_inbox_events
       (id, app_config_ref, provider_event_id, event_type, schema_version, tenant_id, routing_state,
        processing_state, protected_payload_ref, correlation_id, payload_hash, envelope_json, received_at, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
      [
        id, event.appConfigRef, event.eventId, event.eventType, event.schemaVersion, tenantId,
        routingState, event.protectedPayloadRef, event.correlationId, payloadHash, serialized,
        mysqlDate(event.receivedAt), mysqlDate(event.occurredAt),
      ],
    );

    let jobId: string | null = null;
    if (tenantId && routingState === 'ROUTED') {
      const result = await this.jobs.enqueueWithin(manager, {
        tenantId,
        type: 'INBOX_PROCESS',
        idempotencyKey: `inbox:${createHash('sha256').update(`${event.appConfigRef}:${event.eventId}`).digest('hex')}`,
        correlationId: event.correlationId,
        causationId: event.causationId,
        resourceScopeRef: resourceReference(event),
        payload: { kind: 'INBOX_PROCESS', inboxEventRef: id },
      });
      jobId = result.id;
    }
    return { id, duplicate: false, routingState, jobId };
  }
}
