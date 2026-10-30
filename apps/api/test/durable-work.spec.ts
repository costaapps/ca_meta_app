import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from '../src/app.module.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DURABLE_WORK_DATABASE } from '../src/jobs/jobs.module.js';
import type { ApiEnvironment } from '../src/config/environment.js';
import type { EntityManager } from 'typeorm';
import { canonicalJson, JOB_POLICIES, MAX_ACTIVE_JOBS_PER_TENANT, MAX_WAITING_JOBS_PER_TENANT, parseInboxEvent, parseOutboxEvent, retryDelayMs } from '../src/jobs/event-validation.js';
import type { ClaimedJob, JobFinalization, JobOutcome, JobStore } from '../src/jobs/job-store.js';
import { DurableWorker, type JobHandler } from '../src/worker/durable-worker.js';
import type { JobType } from '../src/jobs/event-validation.js';

const inboxExample = {
  eventId: 'inbox_synthetic_01',
  schemaVersion: 1,
  eventType: 'provider.message.received',
  appConfigRef: '00000000-0000-4000-8000-000000000011',
  tenantRef: null,
  actor: { kind: 'PROVIDER', ref: 'provider_synthetic' },
  correlationId: 'correlation_synthetic_01',
  causationId: null,
  aggregateRef: null,
  aggregateVersion: 0,
  occurredAt: '2026-10-29T12:00:00.000Z',
  receivedAt: '2026-10-29T12:00:01.000Z',
  protectedPayloadRef: 'payloadref_synthetic_01',
  routingState: 'PENDING',
  safeMetadata: { kind: 'MESSAGE_RECEIVED', assetRef: 'asset_synthetic_01', messageRef: 'message_synthetic_01', channel: 'WHATSAPP' },
};

const outboxExample = {
  eventId: 'outbox_synthetic_01',
  tenantRef: '00000000-0000-4000-8000-000000000001',
  schemaVersion: 1,
  eventType: 'reply.requested',
  aggregateRef: 'operation_synthetic_01',
  aggregateVersion: 1,
  actor: { kind: 'USER', ref: 'operator_synthetic' },
  correlationId: 'correlation_synthetic_02',
  causationId: 'request_synthetic_01',
  createdAt: '2026-10-29T12:00:00.000Z',
  enqueuedAt: '2026-10-29T12:00:00.000Z',
  data: { kind: 'REPLY_REQUESTED', assetRef: 'asset_synthetic_01', messageRef: 'message_synthetic_01', operationRef: 'operation_synthetic_01' },
};

const claimedJob: ClaimedJob = {
  id: '00000000-0000-4000-8000-000000000101',
  tenantId: '00000000-0000-4000-8000-000000000001',
  type: 'PROJECTION_RECONCILE',
  lane: 'HISTORICAL_PROJECTION',
  effectMode: 'SAFE_RETRY',
  payload: { kind: 'PROJECTION_RECONCILE', projectionRef: 'projection_synthetic_01', sourceVersion: 1 },
  idempotencyKey: 'projection_synthetic_01',
  correlationId: 'correlation_synthetic_03',
  causationId: null,
  attempt: 1,
  maxAttempts: 5,
  claimToken: '00000000-0000-4000-8000-000000000102',
  workerRef: 'worker-unit-1',
  budgetStartedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

class FakeJobStore implements JobStore {
  claimed = false;
  claimCalls = 0;
  renewCount = 0;
  finishes: JobOutcome[] = [];
  finishAt = 0;
  loseLease = false;

  async enqueue(): Promise<{ id: string; duplicate: boolean }> { throw new Error('not used'); }
  async enqueueWithin(): Promise<{ id: string; duplicate: boolean }> { throw new Error('not used'); }
  async claimNext(): Promise<ClaimedJob | null> {
    this.claimCalls += 1;
    if (this.claimed) return null;
    this.claimed = true;
    return claimedJob;
  }
  async renew(): Promise<boolean> { this.renewCount += 1; return !this.loseLease; }
  async finish(_job: ClaimedJob, outcome: JobOutcome): Promise<boolean> { this.finishAt = Date.now(); this.finishes.push(outcome); return true; }
}

test('runtime event validation uses the M1.07 schemas and rejects unallowlisted credential fields', () => {
  assert.equal(parseInboxEvent(inboxExample).eventId, inboxExample.eventId);
  assert.equal(parseOutboxEvent(outboxExample).eventId, outboxExample.eventId);
  assert.throws(() => parseInboxEvent({ ...inboxExample, access_token: 'synthetic-must-not-persist' }));
  assert.throws(() => parseOutboxEvent({ ...outboxExample, client_secret: 'synthetic-must-not-persist' }));
  assert.throws(() => parseInboxEvent({ ...inboxExample, safeMetadata: { ...inboxExample.safeMetadata, rawPayload: 'synthetic' } }));
});

test('Nest application context closes the lazy durable-work DB provider during shutdown', async () => {
  const environment: ApiEnvironment = {
    nodeEnv: 'test', port: 0, bindAddress: '127.0.0.1', allowedHosts: ['localhost'], allowedOrigins: ['http://localhost'], trustedProxyCidrs: false,
    portalSessionRecoveryKey: 'synthetic-test-session-recovery-key-32-bytes-minimum',
    database: { host: '127.0.0.1', port: 3306, name: 'api_lifecycle_test', user: 'api_test', password: 'synthetic-only', connectTimeoutMs: 500 },
  };
  const app = await NestFactory.createApplicationContext(ApiModule.register(environment), { logger: false });
  const database = app.get<DurableWorkDatabase>(DURABLE_WORK_DATABASE, { strict: false });
  let closed = false;
  database.close = async () => { closed = true; };
  await app.close();
  assert.equal(closed, true);
});

test('canonical JSON is deterministic and OUTBOX_DELIVER stays ambiguous without adapter evidence', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), canonicalJson({ a: { x: null, y: true }, z: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  assert.equal(JOB_POLICIES.OUTBOX_DELIVER.effectMode, 'AMBIGUOUS');
  assert.equal(MAX_ACTIVE_JOBS_PER_TENANT, 4);
  assert.equal(MAX_WAITING_JOBS_PER_TENANT, 1_000);
  assert.equal(retryDelayMs(JOB_POLICIES.PROJECTION_RECONCILE, 3, () => 0.5), 2_000);
});

test('worker heartbeats beyond lease TTL, drains the current handler on SIGTERM, and then ACKs', async () => {
  const store = new FakeJobStore();
  const handler: JobHandler = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { kind: 'SUCCEEDED' };
  };
  const worker = new DurableWorker(store, { workerRef: 'worker-unit-1', leaseMs: 120, heartbeatMs: 20, idlePollMs: 5 }, new Map<JobType, JobHandler>([['PROJECTION_RECONCILE', handler]]));
  const controller = new AbortController();
  const started = Date.now();
  const run = worker.run(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await run;
  assert.ok(Date.now() - started >= 220, 'SIGTERM stops claims but drains the active handler');
  assert.ok(store.renewCount >= 5, 'short lease is renewed while the handler is still active');
  assert.deepEqual(store.finishes, [{ kind: 'SUCCEEDED' }]);
});

test('worker requires heartbeat interval plus cancellation grace to fit inside the lease', () => {
  assert.throws(() => new DurableWorker(
    new FakeJobStore(),
    { workerRef: 'worker-invalid-timeout-margin', leaseMs: 100, heartbeatMs: 60, handlerCancellationGraceMs: 40 },
    new Map<JobType, JobHandler>([['PROJECTION_RECONCILE', async () => ({ kind: 'SUCCEEDED' })]]),
  ), /heartbeatMs plus handlerCancellationGraceMs must be shorter than the lease/);
});

test('worker does not ACK after losing its claim fence and maps uncertain provider outcomes safely', async () => {
  const staleStore = new FakeJobStore();
  staleStore.loseLease = true;
  const staleWorker = new DurableWorker(staleStore, { workerRef: 'worker-unit-2', leaseMs: 100, heartbeatMs: 20 }, new Map<JobType, JobHandler>([
    ['PROJECTION_RECONCILE', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { kind: 'SUCCEEDED' };
    }],
  ]));
  const staleController = new AbortController();
  const staleRun = staleWorker.run(staleController.signal);
  setTimeout(() => staleController.abort(), 40);
  await staleRun;
  assert.deepEqual(staleStore.finishes, []);

  const ambiguousJob: ClaimedJob = {
    ...claimedJob,
    id: '00000000-0000-4000-8000-000000000201',
    type: 'OUTBOX_DELIVER',
    lane: 'ONBOARDING',
    effectMode: 'AMBIGUOUS',
    payload: { kind: 'OUTBOX_DELIVER', outboxEventRef: '00000000-0000-4000-8000-000000000202' },
  };
  class AmbiguousStore extends FakeJobStore {
    override async claimNext(): Promise<ClaimedJob | null> {
      if (this.claimed) return null;
      this.claimed = true;
      return ambiguousJob;
    }
  }
  const ambiguousStore = new AmbiguousStore();
  const ambiguousWorker = new DurableWorker(ambiguousStore, { workerRef: 'worker-unit-3', leaseMs: 100, heartbeatMs: 20 }, new Map<JobType, JobHandler>([
    ['OUTBOX_DELIVER', async () => { throw new Error('synthetic uncertain provider result'); }],
  ]));
  const ambiguousController = new AbortController();
  const ambiguousRun = ambiguousWorker.run(ambiguousController.signal);
  setTimeout(() => ambiguousController.abort(), 50);
  await ambiguousRun;
  assert.deepEqual(ambiguousStore.finishes, [{ kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }]);
});

test('type timeout aborts cooperatively, waits for handler exit, and never retries an ambiguous effect', async () => {
  const runTimed = async (type: 'INBOX_PROCESS' | 'OUTBOX_DELIVER', effectMode: 'SAFE_RETRY' | 'AMBIGUOUS') => {
    const job: ClaimedJob = type === 'INBOX_PROCESS'
      ? { ...claimedJob, type, lane: 'WEBHOOK_URGENT', effectMode, payload: { kind: 'INBOX_PROCESS', inboxEventRef: '00000000-0000-4000-8000-000000000301' } }
      : { ...claimedJob, type, lane: 'ONBOARDING', effectMode, payload: { kind: 'OUTBOX_DELIVER', outboxEventRef: '00000000-0000-4000-8000-000000000302' } };
    class TimeoutStore extends FakeJobStore {
      override async claimNext(): Promise<ClaimedJob | null> {
        if (this.claimed) return null;
        this.claimed = true;
        return job;
      }
    }
    const store = new TimeoutStore();
    let handlerExitedAt = 0;
    const worker = new DurableWorker(store, {
      workerRef: `timeout-${type.toLowerCase()}`, leaseMs: 120, heartbeatMs: 15, idlePollMs: 5,
      handlerTimeoutOverrides: { [type]: 40 },
    }, new Map<JobType, JobHandler>([[type, async (_claimed, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true });
      });
      handlerExitedAt = Date.now();
      return { kind: 'SUCCEEDED' };
    }]]));
    const controller = new AbortController();
    const run = worker.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 110));
    controller.abort();
    await run;
    assert.ok(handlerExitedAt > 0);
    return { store, handlerExitedAt };
  };

  const safe = await runTimed('INBOX_PROCESS', 'SAFE_RETRY');
  assert.deepEqual(safe.store.finishes, [{ kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_TIMEOUT' }]);
  assert.ok(safe.store.finishAt >= safe.handlerExitedAt, 'job finalization waits until the timed-out handler cooperatively exits');
  const ambiguous = await runTimed('OUTBOX_DELIVER', 'AMBIGUOUS');
  assert.deepEqual(ambiguous.store.finishes, [{ kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }]);
  assert.ok(ambiguous.store.finishAt >= ambiguous.handlerExitedAt);
});

test('non-cooperative handler timeout stops heartbeats and fences off late success without retry', async () => {
  class FinalizingStore extends FakeJobStore {
    override async finish(
      job: ClaimedJob,
      outcome: JobOutcome,
      _random?: () => number,
      applyWithin?: (manager: EntityManager, finalization: JobFinalization) => Promise<void>,
    ): Promise<boolean> {
      const finished = await super.finish(job, outcome);
      if (!finished || !applyWithin) return finished;
      const finalization: JobFinalization = {
        status: outcome.kind === 'SUCCEEDED' ? 'SUCCEEDED' : outcome.kind === 'UNKNOWN' ? 'UNKNOWN' : 'RETRY_PENDING',
        safeErrorCode: outcome.kind === 'SUCCEEDED' ? null : outcome.safeErrorCode,
        safeErrorAction: outcome.kind === 'SUCCEEDED' ? null : 'CHECK_STATUS',
      };
      await applyWithin({} as EntityManager, finalization);
      return true;
    }
  }
  const store = new FinalizingStore();
  let resolveHandler!: (outcome: JobOutcome) => void;
  let observedAbort = false;
  let finalizerCalls = 0;
  const pendingHandler = new Promise<JobOutcome>((resolve) => { resolveHandler = resolve; });
  const worker = new DurableWorker(store, {
    workerRef: 'worker-timeout-stuck', leaseMs: 150, heartbeatMs: 10, idlePollMs: 5,
    handlerTimeoutOverrides: { PROJECTION_RECONCILE: 20 }, handlerCancellationGraceMs: 30,
  }, new Map<JobType, JobHandler>([['PROJECTION_RECONCILE', async (_job, signal) => {
    signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
    return pendingHandler;
  }]]), new Map([['PROJECTION_RECONCILE', async () => { finalizerCalls += 1; }]]));
  const controller = new AbortController();
  const started = Date.now();
  const run = worker.run(controller.signal);
  const stoppedWorker = assert.rejects(run, /non-cooperative handler timeout/);
  try {
    while (store.finishes.length === 0 && Date.now() - started < 750) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(store.finishes.length === 1, 'a handler that ignores cancellation is bounded by deadline plus grace');
    await stoppedWorker;

    assert.ok(observedAbort, 'the worker signals cancellation at its configured deadline');
    assert.ok(Date.now() - started < 1_000, 'the unresolved handler does not block worker settlement');
    assert.deepEqual(store.finishes, [{ kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }]);
    assert.equal(finalizerCalls, 1, 'the conservative UNKNOWN result finalizes the projection once');
    assert.equal(store.claimCalls, 1, 'worker stops claiming after an abandoned handler to avoid resource accumulation');
    const renewalsAfterSettlement = store.renewCount;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(store.renewCount, renewalsAfterSettlement, 'heartbeats do not resume after timeout settlement');

    resolveHandler({ kind: 'SUCCEEDED' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(store.finishes, [{ kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' }]);
    assert.equal(finalizerCalls, 1, 'late handler success cannot run a second projection finalizer');
  } finally {
    // If an assertion fails before bounded settlement, release the synthetic handler and stop the run loop
    // so the unit runner itself cannot hang on the deliberately unresolved Promise.
    resolveHandler({ kind: 'SUCCEEDED' });
    controller.abort();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stoppedWorker.then(() => undefined, () => undefined), new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(resolve, 250);
    })]);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
  }
});
