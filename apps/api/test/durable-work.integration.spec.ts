import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { validateEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore, type ClaimedJob, type JobOutcome } from '../src/jobs/job-store.js';
import { InboxService } from '../src/inbox/inbox-service.js';
import { OutboxService } from '../src/outbox/outbox-service.js';
import {
  FailClosedReplayAuthorizationPort,
  ReplayDryRunService,
  type ReplayAuthorizationGrant,
  type ReplayAuthorizationPort,
  type ReplayAuthorizationRequest,
} from '../src/jobs/replay-dry-run.js';
import { DurableWorker } from '../src/worker/durable-worker.js';
import type { InboxEventEnvelope, OutboxEventEnvelope } from '../src/jobs/event-validation.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';
const uuid = (): string => randomUUID();
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const mysqlTime = (offsetMs: number): string => {
  const iso = new Date(Date.now() + offsetMs).toISOString();
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000`;
};

function inboxEvent(appConfigRef: string, eventId = `provider-${uuid()}`): InboxEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: 'provider.message.received',
    appConfigRef,
    tenantRef: null,
    actor: { kind: 'PROVIDER', ref: 'provider-synthetic' },
    correlationId: `corr-${uuid()}`,
    causationId: null,
    aggregateRef: 'aggregate-synthetic',
    aggregateVersion: 1,
    occurredAt: '2026-10-29T12:00:00.000Z',
    receivedAt: new Date().toISOString(),
    protectedPayloadRef: `payload-${uuid()}`,
    routingState: 'PENDING',
    safeMetadata: {
      kind: 'MESSAGE_RECEIVED', assetRef: 'asset-synthetic-01',
      messageRef: `message-${uuid()}`, channel: 'WHATSAPP',
    },
  };
}

function unclassifiedInboxEvent(appConfigRef: string, eventId: string): InboxEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: 'provider.unclassified',
    appConfigRef,
    tenantRef: null,
    actor: { kind: 'PROVIDER', ref: 'm2-05-synthetic-crash-fixture' },
    correlationId: 'corr-m2-05-crash-effect',
    causationId: null,
    aggregateRef: null,
    aggregateVersion: 0,
    occurredAt: '2026-10-29T12:00:00.000Z',
    receivedAt: '2026-10-29T12:00:01.000Z',
    protectedPayloadRef: 'payload-m2-05-crash-effect',
    routingState: 'QUARANTINED',
    safeMetadata: { kind: 'UNCLASSIFIED', eventRef: 'event-m2-05-crash-effect', reason: 'UNMAPPED_EVENT_TYPE' },
  };
}

function outboxEvent(tenantRef: string, eventId = `event-${uuid()}`, aggregateVersion = 1): OutboxEventEnvelope {
  return {
    eventId,
    tenantRef,
    schemaVersion: 1,
    eventType: 'reply.requested',
    aggregateRef: `operation-${uuid()}`,
    aggregateVersion,
    actor: { kind: 'SYSTEM', ref: 'm2-05-synthetic-harness' },
    correlationId: `corr-${uuid()}`,
    causationId: null,
    createdAt: new Date().toISOString(),
    enqueuedAt: new Date().toISOString(),
    data: { kind: 'REPLY_REQUESTED', assetRef: 'asset-synthetic-01', messageRef: 'message-synthetic-01', operationRef: `operation-${uuid()}` },
  };
}

function inboxPayload(ref = uuid()) {
  return { kind: 'INBOX_PROCESS' as const, inboxEventRef: ref };
}

test('MariaDB durable jobs, inbox/outbox, worker recovery, fencing, DLQ replay scope and plans', {
  skip: enabled ? false : 'Run through tools/m2-05/run-mariadb-tests.ps1 with its UUID-scoped MariaDB project.',
}, async () => {
  const migrationEnvironment = readMigrationEnvironment(process.env);
  await deployMigrations(migrationEnvironment);
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const tenantA = uuid();
  const tenantB = uuid();
  const tenantReplay = uuid();
  const tenantWorker = uuid();
  const tenantCap = uuid();
  const tenantConcurrent = uuid();
  const tenantFairA = '00000000-0000-4000-8000-000000000102';
  const tenantFairB = '00000000-0000-4000-8000-000000000101';
  const appConfig = uuid();
  const replayAppConfig = uuid();
  const timestamp = '2026-10-29 12:00:00.000000';
  const jobs = new DurableJobStore(database, () => 0);
  const inbox = new InboxService(database, jobs);
  const outbox = new OutboxService(database, jobs);

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, created_at, updated_at)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
      [tenantA, timestamp, timestamp, tenantB, timestamp, timestamp, tenantReplay, timestamp, timestamp, tenantWorker, timestamp, timestamp, tenantCap, timestamp, timestamp, tenantConcurrent, timestamp, timestamp, tenantFairA, timestamp, timestamp, tenantFairB, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
       (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES (?, ?, 'META', ?, 'test', ?, ?), (?, ?, 'META', ?, 'test', ?, ?)`,
      [appConfig, tenantA, `app-${uuid()}`, timestamp, timestamp,
        replayAppConfig, tenantReplay, `app-${uuid()}`, timestamp, timestamp],
    );

    // Stable idempotency returns the existing job; semantic payload changes under the same key are rejected.
    const projectionPayload = { kind: 'PROJECTION_RECONCILE' as const, projectionRef: 'projection-idem-01', sourceVersion: 1 };
    const projectionInput = {
      tenantId: tenantA, type: 'PROJECTION_RECONCILE' as const, idempotencyKey: 'projection-idempotency-01',
      correlationId: 'corr-projection-idem', resourceScopeRef: 'projection-scope-01', payload: projectionPayload,
    };
    const projectionFirst = await jobs.enqueue(projectionInput);
    const projectionDuplicate = await jobs.enqueue(projectionInput);
    assert.equal(projectionDuplicate.id, projectionFirst.id);
    assert.equal(projectionDuplicate.duplicate, true);
    await assert.rejects(jobs.enqueue({
      ...projectionInput,
      payload: { ...projectionPayload, sourceVersion: 2 },
    }), /Idempotency key conflicts/);
    const initialProjectionClaim = await jobs.claimNext('projection-cleanup', 300_000, ['PROJECTION_RECONCILE']);
    assert.equal(initialProjectionClaim?.id, projectionFirst.id);
    assert.equal(await jobs.finish(initialProjectionClaim!, { kind: 'SUCCEEDED' }), true);

    // Inbox commits the event and its processing job together; changed transport metadata is duplicate-safe.
    const incoming = inboxEvent(appConfig);
    const persistedInbox = await inbox.persist(incoming);
    assert.equal(persistedInbox.routingState, 'ROUTED');
    assert.ok(persistedInbox.jobId);
    const redelivery = {
      ...incoming,
      receivedAt: new Date(Date.now() + 1_000).toISOString(),
      correlationId: `new-correlation-${uuid()}`,
      protectedPayloadRef: `new-protected-handle-${uuid()}`,
    };
    const duplicateInbox = await inbox.persist(redelivery);
    assert.equal(duplicateInbox.duplicate, true);
    assert.equal(duplicateInbox.id, persistedInbox.id);
    await assert.rejects(inbox.persist({
      ...redelivery,
      safeMetadata: { ...incoming.safeMetadata, messageRef: `changed-${uuid()}` },
    }), /conflicts with different normalized content/);
    const inboxRows = await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_inbox_events WHERE app_config_ref = ? AND provider_event_id = ?',
      [appConfig, incoming.eventId],
    ) as Array<{ count: string | number }>;
    assert.equal(Number(inboxRows[0]?.count), 1);
    const firstInboxJob = await jobs.claimNext('inbox-cleanup', 300_000, ['INBOX_PROCESS']);
    assert.equal(firstInboxJob?.id, persistedInbox.jobId);
    assert.equal(await jobs.finish(firstInboxJob!, { kind: 'SUCCEEDED' }, undefined,
      (manager, finalization) => inbox.finalizeProcessingWithin(manager, firstInboxJob!, finalization)), true);

    // Retry exhaustion finalizes the inbox projection as terminal in the same transaction as the job/DLQ.
    const retryExhaustionInbox = await inbox.persist(inboxEvent(appConfig, `provider-retry-exhaustion-${uuid()}`));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await jobs.claimNext(`worker-inbox-retry-${attempt}`, 300_000, ['INBOX_PROCESS']);
      assert.equal(claim?.id, retryExhaustionInbox.jobId);
      assert.equal(claim?.attempt, attempt);
      assert.equal(await jobs.finish(claim!, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' }, () => 0,
        (manager, finalization) => inbox.finalizeProcessingWithin(manager, claim!, finalization)), true);
    }
    const exhaustedInboxRows = await dataSource.query(
      `SELECT i.processing_state, j.status AS job_status
       FROM ca_meta_inbox_events i JOIN ca_meta_jobs j
         ON j.tenant_id = i.tenant_id AND j.id = ? WHERE i.id = ?`,
      [retryExhaustionInbox.jobId, retryExhaustionInbox.id],
    ) as Array<{ processing_state: string; job_status: string }>;
    assert.equal(exhaustedInboxRows[0]?.processing_state, 'DEAD_LETTER');
    assert.equal(exhaustedInboxRows[0]?.job_status, 'DEAD_LETTER');

    const unknownInbox = await inbox.persist(inboxEvent(appConfig, `provider-unknown-${uuid()}`));
    const unknownInboxClaim = await jobs.claimNext('worker-inbox-unknown', 300_000, ['INBOX_PROCESS']);
    assert.equal(unknownInboxClaim?.id, unknownInbox.jobId);
    assert.equal(await jobs.finish(unknownInboxClaim!, { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }, undefined,
      (manager, finalization) => inbox.finalizeProcessingWithin(manager, unknownInboxClaim!, finalization)), true);
    const unknownInboxRows = await dataSource.query(
      'SELECT processing_state FROM ca_meta_inbox_events WHERE id = ? AND tenant_id = ?',
      [unknownInbox.id, tenantA],
    ) as Array<{ processing_state: string }>;
    assert.equal(unknownInboxRows[0]?.processing_state, 'UNKNOWN');

    // Outbox intent, its delivery job and a local write are one InnoDB transaction.
    const rolledBackEvent = outboxEvent(tenantA, `rollback-${uuid()}`);
    await assert.rejects(dataSource.transaction(async (manager) => {
      await manager.query('UPDATE ca_meta_tenants SET version = version + 1 WHERE id = ?', [tenantA]);
      await outbox.appendWithin(manager, rolledBackEvent);
      throw new Error('synthetic rollback after enqueue');
    }), /synthetic rollback/);
    const rolledBackJobKey = `outbox:${createHash('sha256').update(rolledBackEvent.eventId).digest('hex')}`;
    const rollbackRows = await dataSource.query(
      `SELECT (SELECT COUNT(*) FROM ca_meta_outbox_events WHERE tenant_id = ? AND event_id = ?) AS outbox_count,
              (SELECT COUNT(*) FROM ca_meta_jobs WHERE tenant_id = ? AND idempotency_key = ?) AS job_count,
              (SELECT version FROM ca_meta_tenants WHERE id = ?) AS tenant_version`,
      [tenantA, rolledBackEvent.eventId, tenantA, rolledBackJobKey, tenantA],
    ) as Array<{ outbox_count: string | number; job_count: string | number; tenant_version: string | number }>;
    assert.equal(Number(rollbackRows[0]?.outbox_count), 0);
    assert.equal(Number(rollbackRows[0]?.job_count), 0);
    assert.equal(Number(rollbackRows[0]?.tenant_version), 1);

    const queuedOutboxEvent = outboxEvent(tenantB);
    const appendedOutbox = await outbox.append(queuedOutboxEvent);
    assert.ok(appendedOutbox.jobId);
    const duplicateOutbox = await outbox.append(queuedOutboxEvent);
    assert.equal(duplicateOutbox.duplicate, true);
    assert.equal(duplicateOutbox.id, appendedOutbox.id);
    await assert.rejects(outbox.append({ ...queuedOutboxEvent, data: { ...queuedOutboxEvent.data, messageRef: 'different-message' } }), /conflicts with different normalized content/);

    // An uncertain provider result for OUTBOX_DELIVER becomes UNKNOWN and is never blindly retried.
    const outboxClaim = await jobs.claimNext('outbox-worker-1', 300_000, ['OUTBOX_DELIVER']);
    assert.equal(outboxClaim?.id, appendedOutbox.jobId);
    const uncertainOutcome: JobOutcome = { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_TIMEOUT' };
    assert.equal(await jobs.finish(outboxClaim!, uncertainOutcome, undefined,
      (manager, finalization) => outbox.finalizeDeliveryWithin(manager, outboxClaim!, finalization)), true);
    const uncertainRows = await dataSource.query(
      `SELECT j.status AS job_status, o.delivery_state
       FROM ca_meta_jobs j JOIN ca_meta_outbox_events o ON o.id = ?
       WHERE j.id = ?`,
      [appendedOutbox.id, appendedOutbox.jobId],
    ) as Array<{ job_status: string; delivery_state: string }>;
    assert.equal(uncertainRows[0]?.job_status, 'UNKNOWN');
    assert.equal(uncertainRows[0]?.delivery_state, 'UNKNOWN');

    // An ambiguous worker crash must mark the outbox intent UNKNOWN before any relay can see PENDING again.
    const abandonedOutboxEvent = outboxEvent(tenantB, `abandoned-${uuid()}`);
    const abandonedOutbox = await outbox.append(abandonedOutboxEvent);
    const abandonedOutboxClaim = await jobs.claimNext('outbox-worker-crashed', 300_000, ['OUTBOX_DELIVER']);
    assert.equal(abandonedOutboxClaim?.id, abandonedOutbox.jobId);
    await dataSource.query(
      `UPDATE ca_meta_jobs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE id = ? AND tenant_id = ? AND claim_token = ?`,
      [abandonedOutboxClaim!.id, tenantB, abandonedOutboxClaim!.claimToken],
    );
    assert.equal(await jobs.claimNext('outbox-expiry-sweep', 300_000, ['PROJECTION_RECONCILE']), null);
    const abandonedOutboxRows = await dataSource.query(
      `SELECT j.status AS job_status, o.delivery_state
       FROM ca_meta_jobs j JOIN ca_meta_outbox_events o ON o.id = ? AND o.tenant_id = j.tenant_id
       WHERE j.id = ? AND j.tenant_id = ?`,
      [abandonedOutbox.id, abandonedOutboxClaim!.id, tenantB],
    ) as Array<{ job_status: string; delivery_state: string }>;
    assert.equal(abandonedOutboxRows[0]?.job_status, 'UNKNOWN');
    assert.equal(abandonedOutboxRows[0]?.delivery_state, 'UNKNOWN');

    // Two concurrent claimers atomically take different resources from one tenant.
    const concurrentJobs = await Promise.all(['race-resource-a', 'race-resource-b'].map((scope, index) => jobs.enqueue({
      tenantId: tenantConcurrent, type: 'INBOX_PROCESS', idempotencyKey: `concurrent-${index}`,
      correlationId: `corr-concurrent-${index}`, resourceScopeRef: scope, payload: inboxPayload(),
    })));
    const sameResourceConcurrent = await jobs.enqueue({
      tenantId: tenantConcurrent, type: 'INBOX_PROCESS', idempotencyKey: 'concurrent-same-resource',
      correlationId: 'corr-concurrent-same', resourceScopeRef: 'race-resource-a', payload: inboxPayload(),
    });
    const simultaneousClaims = await Promise.all([
      jobs.claimNext('race-worker-1', 300_000, ['INBOX_PROCESS']),
      jobs.claimNext('race-worker-2', 300_000, ['INBOX_PROCESS']),
    ]);
    assert.deepEqual(new Set(simultaneousClaims.map((job) => job?.id)), new Set(concurrentJobs.map((job) => job.id)));
    assert.notEqual(simultaneousClaims[0]?.id, sameResourceConcurrent.id);
    assert.notEqual(simultaneousClaims[1]?.id, sameResourceConcurrent.id);
    assert.equal(await jobs.claimNext('race-worker-3', 300_000, ['INBOX_PROCESS']), null);
    for (const job of simultaneousClaims) assert.equal(await jobs.finish(job!, { kind: 'SUCCEEDED' }), true);
    const afterRaceSameResource = await jobs.claimNext('race-worker-3', 300_000, ['INBOX_PROCESS']);
    assert.equal(afterRaceSameResource?.id, sameResourceConcurrent.id);
    assert.equal(await jobs.finish(afterRaceSameResource!, { kind: 'SUCCEEDED' }), true);

    // Two independent claimers: the second tenant's urgent lane wins over the noisy tenant's active lease.
    const busyActive = await jobs.enqueue({
      tenantId: tenantA, type: 'INBOX_PROCESS', idempotencyKey: 'fair-active-a', correlationId: 'corr-fair-a',
      resourceScopeRef: 'asset-scope-a', payload: inboxPayload(),
    });
    const busySameResource = await jobs.enqueue({
      tenantId: tenantA, type: 'INBOX_PROCESS', idempotencyKey: 'fair-wait-same', correlationId: 'corr-fair-a2',
      resourceScopeRef: 'asset-scope-a', payload: inboxPayload(),
    });
    const busyOtherResource = await jobs.enqueue({
      tenantId: tenantA, type: 'INBOX_PROCESS', idempotencyKey: 'fair-wait-other', correlationId: 'corr-fair-a3',
      resourceScopeRef: 'asset-scope-b', payload: inboxPayload(),
    });
    const activeBusyClaim = await jobs.claimNext('worker-noisy-tenant', 300_000, ['INBOX_PROCESS']);
    assert.equal(activeBusyClaim?.id, busyActive.id);

    const urgentTenantJob = await jobs.enqueue({
      tenantId: tenantB, type: 'INBOX_PROCESS', idempotencyKey: 'fair-urgent-b', correlationId: 'corr-fair-b',
      resourceScopeRef: 'asset-scope-urgent', payload: inboxPayload(),
    });
    const urgentClaim = await jobs.claimNext('worker-second-tenant', 300_000, ['INBOX_PROCESS']);
    assert.equal(urgentClaim?.id, urgentTenantJob.id, 'a tenant with no active leases gets service before the noisy tenant');
    assert.equal(await jobs.finish(urgentClaim!, { kind: 'SUCCEEDED' }), true);

    const secondAssetClaim = await jobs.claimNext('worker-other-asset', 300_000, ['INBOX_PROCESS']);
    assert.equal(secondAssetClaim?.id, busyOtherResource.id, 'asset B is claimable while asset A is leased');
    assert.equal(await jobs.finish(secondAssetClaim!, { kind: 'SUCCEEDED' }), true);
    assert.equal(await jobs.claimNext('worker-same-asset', 300_000, ['INBOX_PROCESS']), null, 'asset A remains fenced while its first job is running');
    assert.equal(await jobs.finish(activeBusyClaim!, { kind: 'SUCCEEDED' }), true);
    const sameResourceClaim = await jobs.claimNext('worker-same-asset-after-release', 300_000, ['INBOX_PROCESS']);
    assert.equal(sameResourceClaim?.id, busySameResource.id);
    assert.equal(await jobs.finish(sameResourceClaim!, { kind: 'SUCCEEDED' }), true);

    // Four leases per tenant are allowed; the fifth stays queued even on a distinct resource.
    const cappedJobs = await Promise.all(Array.from({ length: 5 }, (_, index) => jobs.enqueue({
      tenantId: tenantCap, type: 'OUTBOX_DELIVER', idempotencyKey: `tenant-cap-${index}`,
      correlationId: `corr-tenant-cap-${index}`, resourceScopeRef: `tenant-cap-resource-${index}`,
      payload: { kind: 'OUTBOX_DELIVER' as const, outboxEventRef: uuid() },
    })));
    const cappedClaims = [];
    for (let index = 0; index < 4; index += 1) {
      cappedClaims.push(await jobs.claimNext(`tenant-cap-worker-${index}`, 300_000, ['OUTBOX_DELIVER']));
    }
    const cappedClaimIds = cappedClaims.map((job) => job?.id);
    assert.equal(new Set(cappedClaimIds).size, 4, 'the tenant cap allows four distinct claims');
    assert.ok(cappedClaimIds.every((id) => id !== undefined && cappedJobs.some((job) => job.id === id)));
    assert.equal(await jobs.claimNext('tenant-cap-worker-5', 300_000, ['OUTBOX_DELIVER']), null);
    for (const job of cappedClaims) assert.equal(await jobs.finish(job!, { kind: 'SUCCEEDED' }), true);

    // A real child claims and exits without ACK; a replacement reclaims only after lease expiry and retry delay.
    const crashJob = await jobs.enqueue({
      tenantId: tenantA, type: 'INBOX_PROCESS', idempotencyKey: 'crash-after-claim-01', correlationId: 'corr-crash-claim',
      resourceScopeRef: 'crash-resource-01', payload: inboxPayload(),
    });
    const child = fork(join(__dirname, 'fixtures', 'durable-job-crash-child.js'), [], {
      execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env,
    });
    const childMessage = await new Promise<{ type: string; jobId?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash fixture did not claim within 10 seconds.')); }, 10_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('message', (message) => { clearTimeout(timeout); resolve(message as { type: string; jobId?: string }); });
    });
    assert.deepEqual(childMessage, { type: 'claimed', jobId: crashJob.id });
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGKILL');
    const killed = await childExit;
    assert.ok(killed.signal !== null || killed.code !== null, 'the original process exited without finishing its claim');
    await wait(150);
    assert.equal(await jobs.claimNext('replacement-requeues-expired', 120, ['INBOX_PROCESS']), null);
    const recovered = await jobs.claimNext('replacement-after-backoff', 120, ['INBOX_PROCESS']);
    assert.equal(recovered?.id, crashJob.id);
    assert.equal(await jobs.finish(recovered!, { kind: 'SUCCEEDED' }), true);

    // A local idempotent inbox write may commit just before process death and the job ACK.
    // The replacement repeats the persist under the provider event key without creating a second row.
    const crashEffectEvent = unclassifiedInboxEvent(appConfig, `provider-crash-effect-${uuid()}`);
    const effectCrashJob = await jobs.enqueue({
      tenantId: tenantWorker, type: 'PROJECTION_RECONCILE', idempotencyKey: 'crash-after-local-effect',
      correlationId: 'corr-crash-local-effect', resourceScopeRef: 'crash-local-effect',
      payload: { kind: 'PROJECTION_RECONCILE', projectionRef: 'crash-local-effect', sourceVersion: 1 },
    });
    const effectChild = fork(join(__dirname, 'fixtures', 'durable-job-crash-child.js'), [], {
      execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        M2_CRASH_FIXTURE_JOB_TYPE: 'PROJECTION_RECONCILE',
        M2_CRASH_FIXTURE_EFFECT_EVENT_ID: crashEffectEvent.eventId,
        M2_CRASH_FIXTURE_APP_CONFIG_REF: crashEffectEvent.appConfigRef,
      },
    });
    const effectMessage = await new Promise<{ type: string; jobId?: string; inboxId?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { effectChild.kill('SIGKILL'); reject(new Error('Effect crash fixture did not commit within 10 seconds.')); }, 10_000);
      effectChild.once('error', (error) => { clearTimeout(timeout); reject(error); });
      effectChild.on('message', (message) => { clearTimeout(timeout); resolve(message as { type: string; jobId?: string; inboxId?: string }); });
    });
    assert.equal(effectMessage.type, 'effect-committed');
    assert.equal(effectMessage.jobId, effectCrashJob.id);
    assert.ok(effectMessage.inboxId);
    const effectChildExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      effectChild.once('exit', (code, signal) => resolve({ code, signal }));
    });
    effectChild.kill('SIGKILL');
    const effectKilled = await effectChildExit;
    assert.ok(effectKilled.signal !== null || effectKilled.code !== null);
    const firstEffect = await dataSource.query(
      'SELECT id FROM ca_meta_inbox_events WHERE app_config_ref = ? AND provider_event_id = ?',
      [crashEffectEvent.appConfigRef, crashEffectEvent.eventId],
    ) as Array<{ id: string }>;
    assert.equal(firstEffect.length, 1, 'the local inbox effect committed before the worker was killed');
    assert.equal(firstEffect[0]?.id, effectMessage.inboxId);
    await wait(150);
    assert.equal(await jobs.claimNext('effect-replacement-requeues-expired', 120, ['PROJECTION_RECONCILE']), null);
    const effectRecovered = await jobs.claimNext('effect-replacement-after-backoff', 120, ['PROJECTION_RECONCILE']);
    assert.equal(effectRecovered?.id, effectCrashJob.id);
    const repeatedEffect = await inbox.persist(crashEffectEvent);
    assert.equal(repeatedEffect.duplicate, true, 'the event key makes the repeated local effect idempotent');
    assert.equal(repeatedEffect.id, effectMessage.inboxId);
    const uniqueEffects = await dataSource.query(
      'SELECT COUNT(*) AS count FROM ca_meta_inbox_events WHERE app_config_ref = ? AND provider_event_id = ?',
      [crashEffectEvent.appConfigRef, crashEffectEvent.eventId],
    ) as Array<{ count: string | number }>;
    assert.equal(Number(uniqueEffects[0]?.count), 1, 'recovery does not duplicate the committed inbox effect');
    assert.equal(await jobs.finish(effectRecovered!, { kind: 'SUCCEEDED' }), true);

    // Expired SAFE_RETRY claims are delayed through the bounded jitter policy and stale tokens cannot ACK.
    const staleInput = await jobs.enqueue({
      tenantId: tenantA, type: 'PROJECTION_RECONCILE', idempotencyKey: 'stale-fence-01', correlationId: 'corr-stale-01',
      resourceScopeRef: 'projection-stale-01', payload: { kind: 'PROJECTION_RECONCILE', projectionRef: 'projection-stale-01', sourceVersion: 1 },
    });
    const staleClaim = await jobs.claimNext('worker-stale-old', 120, ['PROJECTION_RECONCILE']);
    assert.equal(staleClaim?.id, staleInput.id);
    await wait(150);
    assert.equal(await jobs.claimNext('worker-stale-new', 120, ['PROJECTION_RECONCILE']), null, 'expired SAFE_RETRY lease is requeued before reclaim');
    const replacementClaim = await jobs.claimNext('worker-stale-new', 120, ['PROJECTION_RECONCILE']);
    assert.equal(replacementClaim?.id, staleInput.id);
    assert.notEqual(replacementClaim?.claimToken, staleClaim?.claimToken);
    assert.equal(await jobs.finish(staleClaim!, { kind: 'SUCCEEDED' }), false);
    assert.equal(await jobs.finish(replacementClaim!, { kind: 'SUCCEEDED' }), true);

    // Deterministic jitter walks every configured attempt without wall-clock sleeps, then records a redacted DLQ reason.
    const retryJob = await jobs.enqueue({
      tenantId: tenantA, type: 'PROJECTION_RECONCILE', idempotencyKey: 'retry-max-attempts-01', correlationId: 'corr-retry-max',
      resourceScopeRef: 'projection-retry-max', payload: { kind: 'PROJECTION_RECONCILE', projectionRef: 'projection-retry-max', sourceVersion: 1 },
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const retryClaim = await jobs.claimNext(`retry-worker-${attempt}`, 300_000, ['PROJECTION_RECONCILE']);
      assert.equal(retryClaim?.id, retryJob.id);
      assert.equal(retryClaim?.attempt, attempt);
      assert.equal(await jobs.finish(retryClaim!, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' }), true);
    }
    const retryRows = await dataSource.query(
      `SELECT j.status, j.last_safe_error_code, j.last_safe_error_action, COUNT(a.id) AS attempt_count
       FROM ca_meta_jobs j JOIN ca_meta_job_attempts a ON a.tenant_id = j.tenant_id AND a.job_id = j.id
       WHERE j.id = ? GROUP BY j.id`,
      [retryJob.id],
    ) as Array<{ status: string; last_safe_error_code: string; last_safe_error_action: string; attempt_count: number | string }>;
    assert.equal(retryRows[0]?.status, 'DEAD_LETTER');
    assert.equal(retryRows[0]?.last_safe_error_code, 'ATTEMPTS_EXHAUSTED');
    assert.equal(retryRows[0]?.last_safe_error_action, 'CONTACT_SUPPORT');
    assert.equal(Number(retryRows[0]?.attempt_count), 5);

    const budgetJob = await jobs.enqueue({
      tenantId: tenantA, type: 'PROJECTION_RECONCILE', idempotencyKey: 'retry-time-budget-01', correlationId: 'corr-retry-budget',
      resourceScopeRef: 'projection-retry-budget', payload: { kind: 'PROJECTION_RECONCILE', projectionRef: 'projection-retry-budget', sourceVersion: 1 },
    });
    const budgetClaim = await jobs.claimNext('retry-budget-worker', 300_000, ['PROJECTION_RECONCILE']);
    assert.equal(budgetClaim?.id, budgetJob.id);
    await dataSource.query('UPDATE ca_meta_jobs SET budget_started_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 2 HOUR) WHERE id = ?', [budgetJob.id]);
    assert.equal(await jobs.finish(budgetClaim!, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_TIMEOUT' }), true);
    const budgetRows = await dataSource.query(
      'SELECT status, last_safe_error_code, last_safe_error_action FROM ca_meta_jobs WHERE id = ?', [budgetJob.id],
    ) as Array<{ status: string; last_safe_error_code: string; last_safe_error_action: string }>;
    assert.equal(budgetRows[0]?.status, 'DEAD_LETTER');
    assert.equal(budgetRows[0]?.last_safe_error_code, 'ATTEMPT_BUDGET_EXHAUSTED');
    assert.equal(budgetRows[0]?.last_safe_error_action, 'CONTACT_SUPPORT');

    // Authorized replay queues only safe/idempotent work, is exact tenant/resource scoped, and is idempotent.
    const replayJob = await jobs.enqueue({
      tenantId: tenantReplay, type: 'PROJECTION_RECONCILE', idempotencyKey: 'replay-source-01', correlationId: 'corr-replay-01',
      resourceScopeRef: 'projection-replay-scope', payload: { kind: 'PROJECTION_RECONCILE', projectionRef: 'projection-replay-scope', sourceVersion: 4 },
    });
    const replayClaim = await jobs.claimNext('worker-replay-source', 300_000, ['PROJECTION_RECONCILE']);
    assert.equal(replayClaim?.id, replayJob.id);
    assert.equal(await jobs.finish(replayClaim!, { kind: 'PERMANENT_FAILURE', safeErrorCode: 'HANDLER_FAILED' }), true);
    const deadLetterRows = await dataSource.query(
      `SELECT dl.id, j.resource_scope_ref FROM ca_meta_job_dead_letters dl
       JOIN ca_meta_jobs j ON j.tenant_id = dl.tenant_id AND j.id = dl.job_id
       WHERE dl.tenant_id = ? AND dl.job_id = ?`,
      [tenantReplay, replayJob.id],
    ) as Array<{ id: string; resource_scope_ref: string }>;
    const deadLetter = deadLetterRows[0];
    assert.ok(deadLetter);

    const deniedReplay = new ReplayDryRunService(database, new FailClosedReplayAuthorizationPort(), jobs);
    const failClosed = await deniedReplay.requeue({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: deadLetter.resource_scope_ref, operatorRef: 'operator-synthetic-01',
    });
    assert.equal(failClosed.requeued, false);
    assert.equal(failClosed.reasonCode, 'AUTHORIZATION_DENIED');
    const dryRunDenied = await deniedReplay.preview({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: deadLetter.resource_scope_ref, operatorRef: 'operator-synthetic-01',
    });
    assert.equal(dryRunDenied.dryRun, true);
    assert.equal(dryRunDenied.requeued, false);

    const replayAuthorization: ReplayAuthorizationPort = {
      async authorize(request: ReplayAuthorizationRequest): Promise<ReplayAuthorizationGrant> {
        return {
          ...request,
          authorizationRef: 'support-grant-synthetic-01',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const replayService = new ReplayDryRunService(database, replayAuthorization, jobs);
    const authorizedPreview = await replayService.preview({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: deadLetter.resource_scope_ref, operatorRef: 'operator-synthetic-01',
    });
    assert.equal(authorizedPreview.authorized, true);
    assert.equal(authorizedPreview.dryRun, true);
    assert.equal(authorizedPreview.requeued, false);
    assert.equal(authorizedPreview.jobId, null);
    const replayed = await replayService.requeue({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: deadLetter.resource_scope_ref, operatorRef: 'operator-synthetic-01',
    });
    assert.equal(replayed.requeued, true);
    assert.ok(replayed.jobId);
    const replayDuplicate = await replayService.requeue({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: deadLetter.resource_scope_ref, operatorRef: 'operator-synthetic-01',
    });
    assert.equal(replayDuplicate.reasonCode, 'REPLAY_DUPLICATE');
    assert.equal(replayDuplicate.jobId, replayed.jobId);

    // Inbox replay resets only the exact tenant-scoped terminal projection in the enqueue transaction.
    const inboxReplaySource = await inbox.persist(inboxEvent(replayAppConfig, `provider-inbox-replay-${uuid()}`));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await jobs.claimNext(`worker-inbox-replay-source-${attempt}`, 300_000, ['INBOX_PROCESS']);
      assert.equal(claim?.id, inboxReplaySource.jobId);
      assert.equal(await jobs.finish(claim!, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' }, () => 0,
        (manager, finalization) => inbox.finalizeProcessingWithin(manager, claim!, finalization)), true);
    }
    const inboxReplayDlqRows = await dataSource.query(
      `SELECT dl.id, j.resource_scope_ref FROM ca_meta_job_dead_letters dl
       JOIN ca_meta_jobs j ON j.tenant_id = dl.tenant_id AND j.id = dl.job_id
       WHERE dl.tenant_id = ? AND dl.job_id = ?`,
      [tenantReplay, inboxReplaySource.jobId],
    ) as Array<{ id: string; resource_scope_ref: string }>;
    const inboxReplayDlq = inboxReplayDlqRows[0];
    assert.ok(inboxReplayDlq);
    const acceptedInboxReplay = await replayService.requeue({
      tenantId: tenantReplay, deadLetterId: inboxReplayDlq.id, scopeRef: inboxReplayDlq.resource_scope_ref,
      operatorRef: 'operator-synthetic-01',
    });
    assert.equal(acceptedInboxReplay.requeued, true);
    const resetInboxRows = await dataSource.query(
      'SELECT processing_state FROM ca_meta_inbox_events WHERE id = ? AND tenant_id = ?',
      [inboxReplaySource.id, tenantReplay],
    ) as Array<{ processing_state: string }>;
    assert.equal(resetInboxRows[0]?.processing_state, 'PENDING');
    const inboxReplayClaim = await jobs.claimNext('worker-inbox-replay-success', 300_000, ['INBOX_PROCESS']);
    assert.equal(inboxReplayClaim?.id, acceptedInboxReplay.jobId);
    assert.equal(await jobs.finish(inboxReplayClaim!, { kind: 'SUCCEEDED' }, undefined,
      (manager, finalization) => inbox.finalizeProcessingWithin(manager, inboxReplayClaim!, finalization)), true);
    const processedInboxRows = await dataSource.query(
      'SELECT processing_state FROM ca_meta_inbox_events WHERE id = ? AND tenant_id = ?',
      [inboxReplaySource.id, tenantReplay],
    ) as Array<{ processing_state: string }>;
    assert.equal(processedInboxRows[0]?.processing_state, 'PROCESSED');
    const inboxReplayDuplicate = await replayService.requeue({
      tenantId: tenantReplay, deadLetterId: inboxReplayDlq.id, scopeRef: inboxReplayDlq.resource_scope_ref,
      operatorRef: 'operator-synthetic-01',
    });
    assert.equal(inboxReplayDuplicate.reasonCode, 'REPLAY_DUPLICATE');
    const unchangedProcessedInboxRows = await dataSource.query(
      'SELECT processing_state FROM ca_meta_inbox_events WHERE id = ? AND tenant_id = ?',
      [inboxReplaySource.id, tenantReplay],
    ) as Array<{ processing_state: string }>;
    assert.equal(unchangedProcessedInboxRows[0]?.processing_state, 'PROCESSED');

    const wrongScope = await replayService.requeue({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: 'different-resource-scope', operatorRef: 'operator-synthetic-01',
    });
    assert.equal(wrongScope.requeued, false);
    assert.equal(wrongScope.reasonCode, 'SCOPE_MISMATCH');
    const expiredAuthorization: ReplayAuthorizationPort = {
      async authorize(request: ReplayAuthorizationRequest): Promise<ReplayAuthorizationGrant> {
        return { ...request, authorizationRef: 'support-grant-expired', expiresAt: new Date(Date.now() - 1_000).toISOString() };
      },
    };
    const expiredReplay = await new ReplayDryRunService(database, expiredAuthorization, jobs).requeue({
      tenantId: tenantReplay, deadLetterId: deadLetter.id, scopeRef: deadLetter.resource_scope_ref, operatorRef: 'operator-synthetic-01',
    });
    assert.equal(expiredReplay.requeued, false);
    assert.equal(expiredReplay.reasonCode, 'AUTHORIZATION_EXPIRED');

    const ambiguousSource = await jobs.enqueue({
      tenantId: tenantReplay, type: 'HISTORY_SYNC', idempotencyKey: 'replay-ambiguous-source', correlationId: 'corr-replay-ambiguous',
      resourceScopeRef: 'checkpoint-ambiguous-replay', payload: { kind: 'HISTORY_SYNC', checkpointRef: 'checkpoint-ambiguous-replay' },
    });
    const ambiguousSourceClaim = await jobs.claimNext('worker-ambiguous-source', 300_000, ['HISTORY_SYNC']);
    assert.equal(ambiguousSourceClaim?.id, ambiguousSource.id);
    assert.equal(await jobs.finish(ambiguousSourceClaim!, { kind: 'PERMANENT_FAILURE', safeErrorCode: 'HANDLER_FAILED' }), true);
    const ambiguousDlqRows = await dataSource.query(
      `SELECT dl.id, j.resource_scope_ref FROM ca_meta_job_dead_letters dl
       JOIN ca_meta_jobs j ON j.tenant_id = dl.tenant_id AND j.id = dl.job_id
       WHERE dl.tenant_id = ? AND dl.job_id = ?`,
      [tenantReplay, ambiguousSource.id],
    ) as Array<{ id: string; resource_scope_ref: string }>;
    const ambiguousDlq = ambiguousDlqRows[0];
    assert.ok(ambiguousDlq);
    const ambiguousReplay = await replayService.requeue({
      tenantId: tenantReplay, deadLetterId: ambiguousDlq.id, scopeRef: ambiguousDlq.resource_scope_ref,
      operatorRef: 'operator-synthetic-01',
    });
    assert.equal(ambiguousReplay.requeued, false);
    assert.equal(ambiguousReplay.reasonCode, 'AMBIGUOUS_EFFECT_NOT_REPLAYABLE');
    const auditRows = await dataSource.query(
      `SELECT action, safe_reason_code, dry_run FROM ca_meta_replay_audit
       WHERE tenant_id = ? AND dead_letter_id = ? ORDER BY created_at, id`,
      [tenantReplay, deadLetter.id],
    ) as Array<{ action: string; safe_reason_code: string; dry_run: number | string }>;
    assert.equal(auditRows.filter((row) => row.action === 'REQUEUE_DENIED').length, 3);
    assert.equal(auditRows.filter((row) => row.action === 'REQUEUE_ALLOWED').length, 2);
    assert.equal(auditRows.filter((row) => row.action === 'DRY_RUN_ALLOWED').length, 1);
    assert.equal(auditRows.filter((row) => row.action === 'DRY_RUN_DENIED').length, 1);
    assert.equal(auditRows.filter((row) => Number(row.dry_run) === 0).length, 5);
    assert.equal(auditRows.filter((row) => Number(row.dry_run) === 1).length, 2);
    const ambiguousAuditRows = await dataSource.query(
      `SELECT action, safe_reason_code, dry_run FROM ca_meta_replay_audit
       WHERE tenant_id = ? AND dead_letter_id = ?`,
      [tenantReplay, ambiguousDlq.id],
    ) as Array<{ action: string; safe_reason_code: string; dry_run: number | string }>;
    assert.equal(ambiguousAuditRows[0]?.action, 'REQUEUE_DENIED');
    assert.equal(ambiguousAuditRows[0]?.safe_reason_code, 'AMBIGUOUS_EFFECT_NOT_REPLAYABLE');
    assert.equal(Number(ambiguousAuditRows[0]?.dry_run), 0);
    await assert.rejects(dataSource.query('UPDATE ca_meta_replay_audit SET safe_reason_code = ? WHERE dead_letter_id = ?', ['changed', deadLetter.id]));

    // A long handler outlives the original TTL; heartbeats keep the lease active and SIGTERM drains it.
    const longJob = await jobs.enqueue({
      tenantId: tenantWorker, type: 'HISTORY_SYNC', idempotencyKey: 'worker-long-01', correlationId: 'corr-worker-long',
      resourceScopeRef: 'checkpoint-worker-long', payload: { kind: 'HISTORY_SYNC', checkpointRef: 'checkpoint-worker-long' },
    });
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = new DurableWorker(jobs, { workerRef: 'worker-long-running', leaseMs: 150, heartbeatMs: 35, idlePollMs: 5 }, new Map([
      ['HISTORY_SYNC', async () => {
        started();
        await wait(420);
        return { kind: 'SUCCEEDED' };
      }],
    ]));
    const stopping = new AbortController();
    const workerRun = worker.run(stopping.signal);
    await handlerStarted;
    await wait(260);
    const liveRows = await dataSource.query(
      'SELECT status, lease_expires_at > UTC_TIMESTAMP(6) AS lease_live, heartbeat_at FROM ca_meta_jobs WHERE id = ?',
      [longJob.id],
    ) as Array<{ status: string; lease_live: number | string; heartbeat_at: string | Date }>;
    assert.equal(liveRows[0]?.status, 'RUNNING');
    assert.equal(Number(liveRows[0]?.lease_live), 1, 'lease remains active after its initial TTL');
    stopping.abort();
    await workerRun;
    const drainedRows = await dataSource.query('SELECT status FROM ca_meta_jobs WHERE id = ?', [longJob.id]) as Array<{ status: string }>;
    assert.equal(drainedRows[0]?.status, 'SUCCEEDED', 'SIGTERM stops claims and drains the active handler');

    // A historical backlog must not delay urgent webhook claims; each lane uses its own indexed candidate pass.
    const highHistoryCount = 5_000;
    const historyReadyAt = mysqlTime(-3_600_000);
    const urgentClaims = await Promise.all([
      jobs.enqueue({
        tenantId: tenantWorker, type: 'INBOX_PROCESS', idempotencyKey: 'urgent-latency-a',
        correlationId: 'urgent-latency-correlation-a', resourceScopeRef: 'urgent-latency-resource-a', payload: inboxPayload(),
      }),
      jobs.enqueue({
        tenantId: tenantWorker, type: 'INBOX_PROCESS', idempotencyKey: 'urgent-latency-b',
        correlationId: 'urgent-latency-correlation-b', resourceScopeRef: 'urgent-latency-resource-b', payload: inboxPayload(),
      }),
    ]);
    const highHistory: unknown[][] = [];
    for (let index = 0; index < highHistoryCount; index += 1) {
      highHistory.push([
        uuid(), tenantWorker, 'PROJECTION_RECONCILE', 1, 'HISTORICAL_PROJECTION', 'SAFE_RETRY', `history-scope-${index}`,
        `history-key-${index}`, `history-correlation-${index}`, null, Buffer.alloc(32),
        JSON.stringify({ kind: 'PROJECTION_RECONCILE', projectionRef: `history-projection-${index}`, sourceVersion: 1 }),
        'QUEUED', 0, 5, historyReadyAt, null, null, null, null, null, null, null, timestamp, timestamp, null,
      ]);
    }
    for (let offset = 0; offset < highHistory.length; offset += 100) {
      const batch = highHistory.slice(offset, offset + 100);
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      await dataSource.query(
        `INSERT INTO ca_meta_jobs
         (id, tenant_id, job_type, schema_version, lane, effect_mode, resource_scope_ref, idempotency_key,
          correlation_id, causation_id, payload_hash, payload_json, status, attempt, max_attempts,
          next_run_at, budget_started_at, lease_owner, claim_token, lease_expires_at, heartbeat_at,
          last_safe_error_code, last_safe_error_action, created_at, updated_at, completed_at)
         VALUES ${values}`,
        batch.flatMap((row) => row),
      );
    }
    await dataSource.query('ANALYZE TABLE ca_meta_jobs');
    const urgentCandidatePlan = await dataSource.query(
      `EXPLAIN SELECT tenant_id, MIN(COALESCE(lease_expires_at, next_run_at)) AS ready_at
       FROM ca_meta_jobs
       WHERE lane = 'WEBHOOK_URGENT' AND job_type = 'INBOX_PROCESS' AND NOT EXISTS (
         SELECT 1 FROM ca_meta_jobs active
         WHERE active.tenant_id = ca_meta_jobs.tenant_id
           AND active.resource_scope_ref = ca_meta_jobs.resource_scope_ref
           AND active.status = 'RUNNING' AND active.lease_expires_at > UTC_TIMESTAMP(6)
       ) AND (
         (status IN ('QUEUED', 'RETRY_PENDING') AND next_run_at <= UTC_TIMESTAMP(6)) OR
         (status = 'RUNNING' AND effect_mode <> 'AMBIGUOUS' AND lease_expires_at <= UTC_TIMESTAMP(6))
       ) GROUP BY tenant_id`,
    ) as Array<{ table: string | null; key: string | null; type: string; rows: number | string }>;
    const urgentCandidateScan = urgentCandidatePlan.find((row) => row.table === 'ca_meta_jobs');
    assert.ok(urgentCandidateScan?.key?.includes('ix_ca_meta_job_claim_'), 'global urgent candidate selection uses the lane/status indexes');
    assert.notEqual(urgentCandidateScan?.type, 'ALL', 'global candidate scan is bounded by an index');
    assert.ok(Number(urgentCandidateScan?.rows ?? Number.MAX_SAFE_INTEGER) < highHistoryCount / 10,
      'urgent candidate estimate excludes the historical projection backlog');

    const tenantClaimPlan = await dataSource.query(
      `EXPLAIN SELECT id FROM ca_meta_jobs
       WHERE tenant_id = ? AND lane = 'WEBHOOK_URGENT' AND job_type = 'INBOX_PROCESS' AND NOT EXISTS (
         SELECT 1 FROM ca_meta_jobs active
         WHERE active.tenant_id = ca_meta_jobs.tenant_id
           AND active.resource_scope_ref = ca_meta_jobs.resource_scope_ref
           AND active.status = 'RUNNING' AND active.lease_expires_at > UTC_TIMESTAMP(6)
       ) AND status IN ('QUEUED', 'RETRY_PENDING') AND next_run_at <= UTC_TIMESTAMP(6)
       ORDER BY next_run_at, created_at, id LIMIT 1`,
      [tenantWorker],
    ) as Array<{ table: string | null; key: string | null; type: string; rows: number | string }>;
    const tenantClaimScan = tenantClaimPlan.find((row) => row.table === 'ca_meta_jobs');
    assert.ok(tenantClaimScan?.key?.includes('ix_ca_meta_job_tenant_claim_ready'), 'ready tenant claims use the tenant/lane ready index');
    assert.notEqual(tenantClaimScan?.type, 'ALL', 'tenant candidate scan is bounded by an index');

    const tenantExpiredPlan = await dataSource.query(
      `EXPLAIN SELECT id FROM ca_meta_jobs
       WHERE tenant_id = ? AND lane = 'HISTORICAL_PROJECTION' AND job_type = 'PROJECTION_RECONCILE'
         AND status = 'RUNNING' AND effect_mode <> 'AMBIGUOUS' AND lease_expires_at <= UTC_TIMESTAMP(6)
       ORDER BY lease_expires_at, created_at, id LIMIT 1`,
      [tenantWorker],
    ) as Array<{ table: string | null; key: string | null; type: string; rows: number | string }>;
    const tenantExpiredScan = tenantExpiredPlan.find((row) => row.table === 'ca_meta_jobs');
    assert.ok(tenantExpiredScan?.key?.includes('ix_ca_meta_job_tenant_claim_expired'), 'expired tenant claims use the tenant/lane lease index');
    assert.notEqual(tenantExpiredScan?.type, 'ALL', 'expired tenant claim scan is bounded by an index');

    const claimStartedAt = performance.now();
    const urgentJobs = await Promise.all([
      jobs.claimNext('urgent-latency-worker-a', 300_000, ['INBOX_PROCESS', 'PROJECTION_RECONCILE']),
      jobs.claimNext('urgent-latency-worker-b', 300_000, ['INBOX_PROCESS', 'PROJECTION_RECONCILE']),
    ]);
    const urgentClaimLatencyMs = performance.now() - claimStartedAt;
    assert.deepEqual(new Set(urgentJobs.map((job) => job?.id)), new Set(urgentClaims.map((job) => job.id)));
    assert.ok(urgentClaimLatencyMs < 2_000, `two urgent claims over ${highHistoryCount} queued historical jobs took ${urgentClaimLatencyMs.toFixed(1)}ms`);
    for (const claim of urgentJobs) assert.equal(await jobs.finish(claim!, { kind: 'SUCCEEDED' }), true);

    // A tenant with an older ready backlog gets one turn; the next tenant in the lane is re-read
    // after finish, and concurrent workers serialize against the same fresh cursor.
    await dataSource.query(
      `INSERT IGNORE INTO ca_meta_job_lane_dispatch (lane, last_tenant_id, updated_at)
       VALUES ('WEBHOOK_URGENT', ?, UTC_TIMESTAMP(6))`,
      [tenantFairB],
    );
    await dataSource.query(
      `UPDATE ca_meta_job_lane_dispatch SET last_tenant_id = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE lane = 'WEBHOOK_URGENT'`,
      [tenantFairB],
    );
    const fairnessAFirst = await jobs.enqueue({
      tenantId: tenantFairA, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-a-first',
      correlationId: 'fairness-a-first', resourceScopeRef: `fairness-a-first-${uuid()}`, payload: inboxPayload(),
    });
    const fairnessABacklog = await jobs.enqueue({
      tenantId: tenantFairA, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-a-backlog',
      correlationId: 'fairness-a-backlog', resourceScopeRef: `fairness-a-backlog-${uuid()}`, payload: inboxPayload(),
    });
    const fairnessBFirst = await jobs.enqueue({
      tenantId: tenantFairB, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-b-first',
      correlationId: 'fairness-b-first', resourceScopeRef: `fairness-b-first-${uuid()}`, payload: inboxPayload(),
    });
    await dataSource.query(
      `UPDATE ca_meta_jobs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 30 SECOND) WHERE id = ?`,
      [fairnessAFirst.id],
    );
    await dataSource.query(
      `UPDATE ca_meta_jobs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 20 SECOND) WHERE id = ?`,
      [fairnessABacklog.id],
    );
    await dataSource.query(
      `UPDATE ca_meta_jobs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 10 SECOND) WHERE id = ?`,
      [fairnessBFirst.id],
    );
    const firstFairnessClaim = await jobs.claimNext('fairness-sequential-a', 300_000, ['INBOX_PROCESS']);
    assert.equal(firstFairnessClaim?.id, fairnessAFirst.id);
    assert.equal(await jobs.finish(firstFairnessClaim!, { kind: 'SUCCEEDED' }), true);
    const remainingFairnessABacklog = await dataSource.query(
      `SELECT COUNT(*) AS count FROM ca_meta_jobs WHERE tenant_id = ? AND status = 'QUEUED'`,
      [tenantFairA],
    ) as Array<{ count: string | number }>;
    assert.equal(Number(remainingFairnessABacklog[0]?.count), 1);
    const secondFairnessClaim = await jobs.claimNext('fairness-sequential-b', 300_000, ['INBOX_PROCESS']);
    assert.equal(secondFairnessClaim?.id, fairnessBFirst.id, 'B gets the next lane turn while A still has ready backlog');
    assert.equal(await jobs.finish(secondFairnessClaim!, { kind: 'SUCCEEDED' }), true);

    const fairnessARaceBacklog = await jobs.enqueue({
      tenantId: tenantFairA, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-a-race-backlog',
      correlationId: 'fairness-a-race-backlog', resourceScopeRef: `fairness-a-race-backlog-${uuid()}`, payload: inboxPayload(),
    });
    const fairnessBRace = await jobs.enqueue({
      tenantId: tenantFairB, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-b-race',
      correlationId: 'fairness-b-race', resourceScopeRef: `fairness-b-race-${uuid()}`, payload: inboxPayload(),
    });
    const concurrentFairnessClaims = await Promise.all([
      jobs.claimNext('fairness-race-worker-a', 300_000, ['INBOX_PROCESS']),
      jobs.claimNext('fairness-race-worker-b', 300_000, ['INBOX_PROCESS']),
    ]);
    assert.deepEqual(
      new Set(concurrentFairnessClaims.map((claim) => claim?.tenantId)),
      new Set([tenantFairA, tenantFairB]),
      'serialized concurrent workers re-read and advance the cursor instead of reusing A as the next turn',
    );
    assert.deepEqual(
      new Set(concurrentFairnessClaims.map((claim) => claim?.id)),
      new Set([fairnessBRace.id, fairnessABacklog.id]),
    );
    for (const claim of concurrentFairnessClaims) assert.equal(await jobs.finish(claim!, { kind: 'SUCCEEDED' }), true);
    const remainingFairnessClaim = await jobs.claimNext('fairness-race-drain', 300_000, ['INBOX_PROCESS']);
    assert.equal(remainingFairnessClaim?.id, fairnessARaceBacklog.id);
    assert.equal(await jobs.finish(remainingFairnessClaim!, { kind: 'SUCCEEDED' }), true);

    // A locked tenant is skipped while the lane cursor remains held; B must claim before A unlocks.
    await dataSource.query(
      `UPDATE ca_meta_job_lane_dispatch SET last_tenant_id = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE lane = 'WEBHOOK_URGENT'`,
      [tenantFairB],
    );
    const fairnessABlocked = await jobs.enqueue({
      tenantId: tenantFairA, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-a-locked',
      correlationId: 'fairness-a-locked', resourceScopeRef: `fairness-a-locked-${uuid()}`, payload: inboxPayload(),
    });
    const fairnessBAvailable = await jobs.enqueue({
      tenantId: tenantFairB, type: 'INBOX_PROCESS', idempotencyKey: 'fairness-b-unblocked',
      correlationId: 'fairness-b-unblocked', resourceScopeRef: `fairness-b-unblocked-${uuid()}`, payload: inboxPayload(),
    });
    await dataSource.query(
      `UPDATE ca_meta_jobs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 5 SECOND) WHERE id = ?`,
      [fairnessABlocked.id],
    );
    const tenantBlocker = dataSource.createQueryRunner();
    let blockedTenantClaim: Promise<ClaimedJob | null> | undefined;
    let blockedClaimFinished = false;
    let tenantBlockerConnected = false;
    try {
      await tenantBlocker.connect();
      tenantBlockerConnected = true;
      await tenantBlocker.startTransaction();
      const lockedTenantRows = await tenantBlocker.query(
        'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE',
        [tenantFairA],
      ) as Array<{ id: string }>;
      assert.equal(lockedTenantRows[0]?.id, tenantFairA);

      blockedTenantClaim = jobs.claimNext('fairness-skip-locked-worker', 300_000, ['INBOX_PROCESS']);
      let watchdog: NodeJS.Timeout | undefined;
      let settlement: { kind: 'settled'; claim: ClaimedJob | null } | { kind: 'timeout' };
      try {
        settlement = await Promise.race([
          blockedTenantClaim.then((claim) => ({ kind: 'settled' as const, claim })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            watchdog = setTimeout(() => resolve({ kind: 'timeout' }), 2_000);
          }),
        ]);
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
      if (settlement.kind === 'timeout') assert.fail('claim waited on tenant A instead of skipping to B');
      assert.equal(settlement.claim?.id, fairnessBAvailable.id);
      assert.equal(tenantBlocker.isTransactionActive, true, 'tenant A remains locked until after B is claimed');
      assert.equal(await jobs.finish(settlement.claim!, { kind: 'SUCCEEDED' }), true);
      blockedClaimFinished = true;
    } finally {
      try {
        if (tenantBlockerConnected && tenantBlocker.isTransactionActive) await tenantBlocker.rollbackTransaction();
      } finally {
        if (tenantBlockerConnected && !tenantBlocker.isReleased) await tenantBlocker.release();
      }
      if (blockedTenantClaim) {
        const eventualClaim = await blockedTenantClaim;
        if (eventualClaim && !blockedClaimFinished) {
          await jobs.finish(eventualClaim, { kind: 'SUCCEEDED' });
        }
      }
    }
    const fairnessAAfterUnlock = await jobs.claimNext('fairness-after-unlock-worker', 300_000, ['INBOX_PROCESS']);
    assert.equal(fairnessAAfterUnlock?.id, fairnessABlocked.id);
    assert.equal(await jobs.finish(fairnessAAfterUnlock!, { kind: 'SUCCEEDED' }), true);

    // The pre-dispatch ambiguous sweeper must skip a locked tenant so urgent work in B can proceed.
    const lockedExpiredEvent = outboxEvent(tenantFairA, `locked-expired-${uuid()}`);
    const lockedExpiredOutbox = await outbox.append(lockedExpiredEvent);
    const lockedExpiredClaim = await jobs.claimNext('ambiguous-locked-expired-worker', 300_000, ['OUTBOX_DELIVER']);
    assert.equal(lockedExpiredClaim?.id, lockedExpiredOutbox.jobId);
    await dataSource.query(
      `UPDATE ca_meta_jobs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE id = ? AND tenant_id = ? AND claim_token = ?`,
      [lockedExpiredClaim!.id, tenantFairA, lockedExpiredClaim!.claimToken],
    );
    const urgentAfterAmbiguousB = await jobs.enqueue({
      tenantId: tenantFairB, type: 'INBOX_PROCESS', idempotencyKey: 'urgent-after-ambiguous-lock-b',
      correlationId: 'urgent-after-ambiguous-lock-b', resourceScopeRef: `urgent-after-ambiguous-lock-${uuid()}`,
      payload: inboxPayload(),
    });
    const ambiguousTenantBlocker = dataSource.createQueryRunner();
    let ambiguousClaimPromise: Promise<ClaimedJob | null> | undefined;
    let ambiguousClaimFinished = false;
    let ambiguousBlockerConnected = false;
    try {
      await ambiguousTenantBlocker.connect();
      ambiguousBlockerConnected = true;
      await ambiguousTenantBlocker.startTransaction();
      const lockedRows = await ambiguousTenantBlocker.query(
        'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE',
        [tenantFairA],
      ) as Array<{ id: string }>;
      assert.equal(lockedRows[0]?.id, tenantFairA);

      ambiguousClaimPromise = jobs.claimNext('urgent-after-ambiguous-lock-worker', 300_000, ['OUTBOX_DELIVER', 'INBOX_PROCESS']);
      let ambiguousWatchdog: NodeJS.Timeout | undefined;
      let ambiguousSettlement: { kind: 'settled'; claim: ClaimedJob | null } | { kind: 'timeout' };
      try {
        ambiguousSettlement = await Promise.race([
          ambiguousClaimPromise.then((claim) => ({ kind: 'settled' as const, claim })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            ambiguousWatchdog = setTimeout(() => resolve({ kind: 'timeout' }), 2_000);
          }),
        ]);
      } finally {
        if (ambiguousWatchdog) clearTimeout(ambiguousWatchdog);
      }
      if (ambiguousSettlement.kind === 'timeout') assert.fail('ambiguous expiry sweep waited on tenant A instead of dispatching B');
      assert.equal(ambiguousSettlement.claim?.id, urgentAfterAmbiguousB.id);
      assert.equal(ambiguousTenantBlocker.isTransactionActive, true, 'tenant A remains locked while B is claimed');
      const skippedExpiredOutboxRows = await dataSource.query(
        `SELECT j.status AS job_status, o.delivery_state
         FROM ca_meta_jobs j JOIN ca_meta_outbox_events o ON o.id = ? AND o.tenant_id = j.tenant_id
         WHERE j.id = ? AND j.tenant_id = ?`,
        [lockedExpiredOutbox.id, lockedExpiredClaim!.id, tenantFairA],
      ) as Array<{ job_status: string; delivery_state: string }>;
      assert.equal(skippedExpiredOutboxRows[0]?.job_status, 'RUNNING', 'the blocked tenant cleanup was deferred');
      assert.equal(skippedExpiredOutboxRows[0]?.delivery_state, 'PENDING', 'the blocked outbox projection remains unchanged');
      assert.equal(await jobs.finish(ambiguousSettlement.claim!, { kind: 'SUCCEEDED' }), true);
      ambiguousClaimFinished = true;
    } finally {
      try {
        if (ambiguousBlockerConnected && ambiguousTenantBlocker.isTransactionActive) await ambiguousTenantBlocker.rollbackTransaction();
      } finally {
        if (ambiguousBlockerConnected && !ambiguousTenantBlocker.isReleased) await ambiguousTenantBlocker.release();
      }
      if (ambiguousClaimPromise) {
        const eventualClaim = await ambiguousClaimPromise;
        if (eventualClaim && !ambiguousClaimFinished) await jobs.finish(eventualClaim, { kind: 'SUCCEEDED' });
      }
    }
    const claimAfterAmbiguousUnlock = await jobs.claimNext('ambiguous-after-unlock-sweep', 300_000, ['OUTBOX_DELIVER']);
    assert.equal(claimAfterAmbiguousUnlock, null, 'the expired ambiguous outbox is finalized rather than claimed again');
    const resolvedExpiredOutboxRows = await dataSource.query(
      `SELECT j.status AS job_status, o.delivery_state
       FROM ca_meta_jobs j JOIN ca_meta_outbox_events o ON o.id = ? AND o.tenant_id = j.tenant_id
       WHERE j.id = ? AND j.tenant_id = ?`,
      [lockedExpiredOutbox.id, lockedExpiredClaim!.id, tenantFairA],
    ) as Array<{ job_status: string; delivery_state: string }>;
    assert.equal(resolvedExpiredOutboxRows[0]?.job_status, 'UNKNOWN');
    assert.equal(resolvedExpiredOutboxRows[0]?.delivery_state, 'UNKNOWN');

    // No FORCE INDEX: the ambiguous-expiry sweep uses its dedicated index on a synthetic mixed state set.
    const bulkRows: unknown[][] = [];
    for (let index = 0; index < 800; index += 1) {
      const id = uuid();
      const isExpiredAmbiguous = index < 8;
      const isActiveAmbiguous = index >= 8 && index < 108;
      const running = isExpiredAmbiguous || isActiveAmbiguous;
      bulkRows.push([
        id, tenantWorker, 'OUTBOX_DELIVER', 1, 'ONBOARDING', 'AMBIGUOUS', `explain-scope-${index}`,
        `explain:${index}`, 'corr-explain', null, Buffer.alloc(32), JSON.stringify({ kind: 'OUTBOX_DELIVER', outboxEventRef: uuid() }),
        running ? 'RUNNING' : 'QUEUED', running ? 1 : 0, 5,
        timestamp, null, running ? 'explain-worker' : null, running ? uuid() : null,
        running ? mysqlTime(isExpiredAmbiguous ? -3_600_000 : 3_600_000) : null,
        running ? timestamp : null, null, null, timestamp, timestamp, null,
      ]);
    }
    for (let offset = 0; offset < bulkRows.length; offset += 100) {
      const batch = bulkRows.slice(offset, offset + 100);
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      await dataSource.query(
        `INSERT INTO ca_meta_jobs
         (id, tenant_id, job_type, schema_version, lane, effect_mode, resource_scope_ref, idempotency_key,
          correlation_id, causation_id, payload_hash, payload_json, status, attempt, max_attempts,
          next_run_at, budget_started_at, lease_owner, claim_token, lease_expires_at, heartbeat_at,
          last_safe_error_code, last_safe_error_action, created_at, updated_at, completed_at)
         VALUES ${values}`,
        batch.flatMap((row) => row),
      );
    }
    await dataSource.query('ANALYZE TABLE ca_meta_jobs');
    const explain = await dataSource.query(
      `EXPLAIN SELECT id FROM ca_meta_jobs
       WHERE status = 'RUNNING' AND effect_mode = 'AMBIGUOUS' AND lease_expires_at <= UTC_TIMESTAMP(6)
       ORDER BY lease_expires_at, id LIMIT 64`,
    ) as Array<{ key: string | null; type: string }>;
    assert.equal(explain[0]?.key, 'ix_ca_meta_job_ambiguous_expired');
    assert.notEqual(explain[0]?.type, 'ALL');
  } finally {
    await database.close();
  }
});
