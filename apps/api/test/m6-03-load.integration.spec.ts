import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore, type ClaimedJob } from '../src/jobs/job-store.js';
import { InboxService } from '../src/inbox/inbox-service.js';
import { MAX_ACTIVE_JOBS_PER_TENANT, MAX_WAITING_JOBS_PER_TENANT } from '../src/jobs/event-validation.js';
import type { InboxEventEnvelope, JobType } from '../src/jobs/event-validation.js';

const enabled = process.env.M6_03_TEST === '1';
const scenario = JSON.parse(readFileSync(resolve(process.cwd(), 'tools/m6-03/scenarios.json'), 'utf8')) as {
  readonly seed: string;
  readonly tenants: readonly { readonly name: string; readonly historicalProjectionJobs: number; readonly webhookEvents: number; readonly concurrentOnboards: number }[];
  readonly workers: number;
  readonly assetsPerTenant: number;
  readonly syntheticHandlerDelayMs: number;
};

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, index)] * 100) / 100;
}

function summary(values: readonly number[]) {
  return { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99) };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inboxEvent(appConfigRef: string, eventId: string, assetRef: string): InboxEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: 'provider.message.received',
    appConfigRef,
    tenantRef: null,
    actor: { kind: 'PROVIDER', ref: 'synthetic-provider' },
    correlationId: `corr-${randomUUID()}`,
    causationId: null,
    aggregateRef: `aggregate-${assetRef}`,
    aggregateVersion: 1,
    occurredAt: '2026-11-18T12:00:00.000Z',
    receivedAt: new Date().toISOString(),
    protectedPayloadRef: `protected-${randomUUID()}`,
    routingState: 'PENDING',
    safeMetadata: {
      kind: 'MESSAGE_RECEIVED',
      assetRef,
      messageRef: `message-${randomUUID()}`,
      channel: 'WHATSAPP',
    },
  };
}

async function enqueueConcurrent<T>(values: readonly T[], concurrency: number, action: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) await action(value);
    }
  }));
}

test('M6.03 clamps attempt duration when the database clock moves backwards', {
  skip: enabled ? false : 'Run with tools/m6-03/run-mariadb.ps1 and its UUID-scoped MariaDB project.',
}, async () => {
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const tenantId = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23) + '000';

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      'INSERT INTO ca_meta_tenants (id, created_at, updated_at) VALUES (?, ?, ?)',
      [tenantId, now, now],
    );
    const jobs = new DurableJobStore(database, () => 0);
    const enqueued = await jobs.enqueue({
      tenantId,
      type: 'PROJECTION_RECONCILE',
      idempotencyKey: `m6-clock-step-${randomUUID()}`,
      correlationId: `corr-clock-step-${randomUUID()}`,
      resourceScopeRef: `m6-clock-step-${randomUUID()}`,
      payload: { kind: 'PROJECTION_RECONCILE', projectionRef: randomUUID(), sourceVersion: 1 },
    });
    const claimed = await jobs.claimNext('m6-clock-step-worker', 300_000, ['PROJECTION_RECONCILE']);
    assert.equal(claimed?.id, enqueued.id);
    await dataSource.query(
      `UPDATE ca_meta_job_attempts SET started_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE tenant_id = ? AND job_id = ? AND attempt = ?`,
      [tenantId, enqueued.id, claimed?.attempt],
    );
    const [clockSample] = await dataSource.query(
      `SELECT started_at, UTC_TIMESTAMP(6) AS now_utc,
              TIMESTAMPDIFF(MICROSECOND, started_at, UTC_TIMESTAMP(6)) DIV 1000 AS raw_duration_ms
       FROM ca_meta_job_attempts WHERE tenant_id = ? AND job_id = ? AND attempt = ?`,
      [tenantId, enqueued.id, claimed?.attempt],
    ) as Array<{ started_at: string; now_utc: string; raw_duration_ms: string | number }>;
    assert.ok(Number(clockSample?.raw_duration_ms) < 0, 'the injected database clock step must produce a negative raw duration');
    process.stdout.write(`${JSON.stringify({
      evidenceClass: 'DISPOSABLE_MARIADB_CLOCK_STEP_REGRESSION',
      startedAtUtc: clockSample?.started_at,
      databaseNowUtc: clockSample?.now_utc,
      rawDurationMs: Number(clockSample?.raw_duration_ms),
      clockStepSynthetic: true,
    }, null, 2)}\n`);

    const finished = await jobs.finish(claimed!, { kind: 'SUCCEEDED' });
    assert.equal(finished, true);
    const [attempt] = await dataSource.query(
      'SELECT duration_ms FROM ca_meta_job_attempts WHERE tenant_id = ? AND job_id = ? AND attempt = ?',
      [tenantId, enqueued.id, claimed?.attempt],
    ) as Array<{ duration_ms: string | number | null }>;
    assert.equal(Number(attempt?.duration_ms), 0);
  } finally {
    await database.close();
  }
});

test('M6.03 measured synthetic durable-work load, tenant fairness, retry and lease recovery', {
  skip: enabled ? false : 'Run with tools/m6-03/run-mariadb.ps1 and its UUID-scoped MariaDB project.',
}, async () => {
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const jobs = new DurableJobStore(database, () => 0);
  const inbox = new InboxService(database, jobs);
  const tenantIds = scenario.tenants.map(() => randomUUID());
  const appConfigIds = scenario.tenants.map(() => randomUUID());
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23) + '000';

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, created_at, updated_at) VALUES ${tenantIds.map(() => '(?, ?, ?)').join(', ')}`,
      tenantIds.flatMap((tenantId) => [tenantId, now, now]),
    );
    await dataSource.query(
      `INSERT INTO ca_meta_app_configurations
        (id, tenant_id, provider, app_external_id, environment, created_at, updated_at)
       VALUES ${scenario.tenants.map(() => "(?, ?, 'META', ?, 'test', ?, ?)").join(', ')}`,
      tenantIds.flatMap((tenantId, index) => [appConfigIds[index], tenantId, `m6-synthetic-${index}`, now, now]),
    );

    const enqueueDurations: number[] = [];
    const inboxPersistDurations: number[] = [];
    const workload: Array<{ tenantIndex: number; type: JobType; idempotencyKey: string; resourceRef: string; payload: unknown; event?: InboxEventEnvelope }> = [];
    for (let tenantIndex = 0; tenantIndex < scenario.tenants.length; tenantIndex += 1) {
      const tenant = scenario.tenants[tenantIndex];
      const tenantId = tenantIds[tenantIndex];
      const appConfigId = appConfigIds[tenantIndex];
      if (!tenant || !tenantId || !appConfigId) throw new Error('Synthetic tenant fixture is incomplete.');
      for (let index = 0; index < tenant.webhookEvents; index += 1) {
        const assetRef = `m6-${tenant.name}-asset-${index % scenario.assetsPerTenant}`;
        const event = inboxEvent(appConfigId, `m6-${tenant.name}-event-${index}`, assetRef);
        workload.push({ tenantIndex, type: 'INBOX_PROCESS', idempotencyKey: `m6-inbox-${tenant.name}-${index}`, resourceRef: assetRef, payload: null, event });
      }
      for (let index = 0; index < tenant.concurrentOnboards; index += 1) {
        workload.push({
          tenantIndex,
          type: 'ONBOARDING_STEP',
          idempotencyKey: `m6-onboard-${tenant.name}-${index}`,
          resourceRef: `m6-onboarding-${tenant.name}-${index}`,
          payload: { kind: 'ONBOARDING_STEP', onboardingRef: `m6-onboarding-${tenant.name}-${index}`, stepRef: `m6-step-${index}` },
        });
      }
      for (let index = 0; index < tenant.historicalProjectionJobs; index += 1) {
        workload.push({
          tenantIndex,
          type: 'PROJECTION_RECONCILE',
          idempotencyKey: `m6-history-${tenant.name}-${index}`,
          resourceRef: `m6-${tenant.name}-asset-${index % scenario.assetsPerTenant}`,
          payload: { kind: 'PROJECTION_RECONCILE', projectionRef: `m6-projection-${tenant.name}-${index}`, sourceVersion: 1 },
        });
      }
    }
    const waitingByTenant = new Map<number, number>();
    for (const item of workload) waitingByTenant.set(item.tenantIndex, (waitingByTenant.get(item.tenantIndex) ?? 0) + 1);
    assert.ok([...waitingByTenant.values()].every((count) => count <= MAX_WAITING_JOBS_PER_TENANT));

    await enqueueConcurrent(workload, 12, async (item) => {
      const tenantId = tenantIds[item.tenantIndex];
      if (!tenantId) throw new Error('Tenant fixture is missing.');
      const started = performance.now();
      if (item.event) {
        const persisted = await inbox.persist(item.event);
        assert.equal(persisted.routingState, 'ROUTED');
        assert.ok(persisted.jobId);
        item.payload = { kind: 'INBOX_PROCESS', inboxEventRef: persisted.id };
        inboxPersistDurations.push(performance.now() - started);
      } else {
        const result = await jobs.enqueue({
          tenantId,
          type: item.type,
          idempotencyKey: item.idempotencyKey,
          correlationId: `corr-${item.idempotencyKey}`,
          resourceScopeRef: item.resourceRef,
          payload: item.payload,
        });
        assert.equal(result.duplicate, false);
      }
      enqueueDurations.push(performance.now() - started);
    });

    const duplicateSource = workload.find((item) => item.event)?.event;
    assert.ok(duplicateSource);
    const duplicate = await inbox.persist({
      ...duplicateSource,
      receivedAt: new Date(Date.now() + 1_000).toISOString(),
      correlationId: `corr-redelivery-${randomUUID()}`,
      protectedPayloadRef: `protected-redelivery-${randomUUID()}`,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.jobId, null);

    const claimDurations: number[] = [];
    const finishDurations: number[] = [];
    const queueWaitMs: number[] = [];
    const webhookQueueWaitMs: number[] = [];
    const countsByTenant = new Map<string, number>(tenantIds.map((tenantId) => [tenantId, 0]));
    const countsByLane = new Map<string, number>();
    const countsByTenantAndLane = new Map<string, number>();
    const activeByTenant = new Map<string, number>();
    const maxActiveByTenant = new Map<string, number>();
    const processingStart = performance.now();
    const supportedTypes: readonly JobType[] = ['INBOX_PROCESS', 'ONBOARDING_STEP', 'PROJECTION_RECONCILE'];

    await Promise.all(Array.from({ length: scenario.workers }, async (_, workerIndex) => {
      while (true) {
        const claimStarted = performance.now();
        const job = await jobs.claimNext(`m6-load-worker-${workerIndex}`, 300_000, supportedTypes);
        claimDurations.push(performance.now() - claimStarted);
        if (!job) return;
        const queueWait = Math.max(0, Date.now() - Date.parse(job.createdAt));
        queueWaitMs.push(queueWait);
        if (job.type === 'INBOX_PROCESS') webhookQueueWaitMs.push(queueWait);
        countsByTenant.set(job.tenantId, (countsByTenant.get(job.tenantId) ?? 0) + 1);
        countsByLane.set(job.lane, (countsByLane.get(job.lane) ?? 0) + 1);
        const tenantLaneKey = `${job.tenantId}:${job.lane}`;
        countsByTenantAndLane.set(tenantLaneKey, (countsByTenantAndLane.get(tenantLaneKey) ?? 0) + 1);
        const active = (activeByTenant.get(job.tenantId) ?? 0) + 1;
        activeByTenant.set(job.tenantId, active);
        maxActiveByTenant.set(job.tenantId, Math.max(maxActiveByTenant.get(job.tenantId) ?? 0, active));
        await wait(scenario.syntheticHandlerDelayMs);
        const finishStarted = performance.now();
        const result = await jobs.finish(job, { kind: 'SUCCEEDED' }, undefined,
          job.type === 'INBOX_PROCESS'
            ? (manager, finalization) => inbox.finalizeProcessingWithin(manager, job, finalization)
            : undefined);
        finishDurations.push(performance.now() - finishStarted);
        assert.equal(result, true);
        activeByTenant.set(job.tenantId, Math.max(0, (activeByTenant.get(job.tenantId) ?? 1) - 1));
      }
    }));
    const processingDurationMs = performance.now() - processingStart;

    assert.equal([...countsByTenant.values()].reduce((sum, count) => sum + count, 0), workload.length);
    assert.ok([...countsByTenant.values()].every((count) => count > 0), 'every tenant must receive worker service');
    assert.ok(
      [...maxActiveByTenant.values()].every((count) => count <= MAX_ACTIVE_JOBS_PER_TENANT),
      `active claim counts exceeded tenant limit: ${JSON.stringify(Object.fromEntries(maxActiveByTenant))}`,
    );
    assert.ok([...maxActiveByTenant.values()].some((count) => count > 1), 'the run must exercise concurrent claims');
    assert.equal(countsByLane.get('WEBHOOK_URGENT'), scenario.tenants.reduce((sum, tenant) => sum + tenant.webhookEvents, 0));
    assert.equal(countsByLane.get('ONBOARDING'), scenario.tenants.reduce((sum, tenant) => sum + tenant.concurrentOnboards, 0));

    const workloadTenantIds = [...tenantIds];
    const placeholders = workloadTenantIds.map(() => '?').join(', ');
    const inboxStateRows = await dataSource.query(
      `SELECT processing_state, COUNT(*) AS count FROM ca_meta_inbox_events
       WHERE tenant_id IN (${placeholders}) GROUP BY processing_state`, workloadTenantIds,
    ) as Array<{ processing_state: string; count: string | number }>;
    assert.deepEqual(inboxStateRows.map((row) => [row.processing_state, Number(row.count)]), [['PROCESSED', scenario.tenants.reduce((sum, tenant) => sum + tenant.webhookEvents, 0)]]);
    const durableStateRows = await dataSource.query(
      `SELECT status, COUNT(*) AS count FROM ca_meta_jobs
       WHERE tenant_id IN (${placeholders}) GROUP BY status`, workloadTenantIds,
    ) as Array<{ status: string; count: string | number }>;
    assert.deepEqual(durableStateRows.map((row) => [row.status, Number(row.count)]), [['SUCCEEDED', workload.length]]);

    const recovery = await exerciseRecovery(database, jobs, inbox, tenantIds[0]!, appConfigIds[0]!);
    const throughputPerSecond = Number((workload.length / (processingDurationMs / 1000)).toFixed(2));
    const completedByTenant = [...countsByTenant.keys()].map((tenantId) => {
      const tenantIndex = tenantIds.findIndex((id) => id === tenantId);
      return {
        tenant: scenario.tenants[tenantIndex]?.name,
        completed: countsByTenant.get(tenantId),
        maxConcurrentClaims: maxActiveByTenant.get(tenantId) ?? 0,
        completedByLane: Object.fromEntries([...countsByLane.keys()].map((lane) => [lane,
          countsByTenantAndLane.get(`${tenantId}:${lane}`) ?? 0,
        ])),
      };
    });

    process.stdout.write(`${JSON.stringify({
      evidenceClass: 'DISPOSABLE_MARIADB_API_INTEGRATION',
      runtime: { node: process.version, mariadb: '11.8.8', poolLimit: 8 },
      workload: {
        seed: scenario.seed,
        tenants: scenario.tenants.length,
        noisyTenantHistoryJobs: scenario.tenants[0]?.historicalProjectionJobs,
        assetsPerTenant: scenario.assetsPerTenant,
        workers: scenario.workers,
        totalJobs: workload.length,
        maxActiveJobsPerTenant: MAX_ACTIVE_JOBS_PER_TENANT,
        maxWaitingJobsPerTenant: MAX_WAITING_JOBS_PER_TENANT,
      },
      measured: {
        enqueueMs: summary(enqueueDurations),
        inboxPersistAndEnqueueMs: summary(inboxPersistDurations),
        claimNextMs: summary(claimDurations),
        finalizeMs: summary(finishDurations),
        queueWaitMs: summary(queueWaitMs),
        webhookQueueWaitMs: summary(webhookQueueWaitMs),
        workerPoolThroughputJobsPerSecond: throughputPerSecond,
        backlogDrainMs: Number(processingDurationMs.toFixed(2)),
        completedByLane: Object.fromEntries(countsByLane),
        completedByTenant,
        recovery,
      },
      notMeasured: ['HTTP ingress ACK', 'Meta API quota/429/5xx/timeout behavior', 'host CPU/memory',
        'external enterprise database isolation', 'production/staging RPO/RTO', 'business peak volumes'],
    }, null, 2)}\n`);
  } finally {
    await database.close();
  }
});

async function exerciseRecovery(
  database: DurableWorkDatabase,
  jobs: DurableJobStore,
  inbox: InboxService,
  tenantId: string,
  appConfigId: string,
) {
  const event = inboxEvent(appConfigId, `m6-retry-${randomUUID()}`, 'm6-recovery-asset');
  const persisted = await inbox.persist(event);
  const first = await jobs.claimNext('m6-retry-first', 300_000, ['INBOX_PROCESS']);
  assert.equal(first?.id, persisted.jobId);
  await jobs.finish(first!, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' }, () => 0,
    (manager, finalization) => inbox.finalizeProcessingWithin(manager, first!, finalization));
  await wait(10);
  const retried = await jobs.claimNext('m6-retry-second', 300_000, ['INBOX_PROCESS']);
  assert.equal(retried?.id, persisted.jobId);
  assert.equal(retried?.attempt, 2);
  await jobs.finish(retried!, { kind: 'SUCCEEDED' }, undefined,
    (manager, finalization) => inbox.finalizeProcessingWithin(manager, retried!, finalization));

  const crashEvent = inboxEvent(appConfigId, `m6-crash-${randomUUID()}`, 'm6-recovery-crash-asset');
  const crashPersisted = await inbox.persist(crashEvent);
  const abandoned = await jobs.claimNext('m6-crash-before-finalize', 120, ['INBOX_PROCESS']);
  assert.equal(abandoned?.id, crashPersisted.jobId);
  await wait(150);
  let replacement: ClaimedJob | null = null;
  for (let poll = 0; poll < 10 && !replacement; poll += 1) {
    replacement = await jobs.claimNext('m6-recovery-replacement', 120, ['INBOX_PROCESS']);
    if (!replacement) await wait(100);
  }
  assert.equal(replacement?.id, crashPersisted.jobId);
  assert.equal(replacement?.attempt, 2);
  await jobs.finish(replacement!, { kind: 'SUCCEEDED' }, undefined,
    (manager, finalization) => inbox.finalizeProcessingWithin(manager, replacement!, finalization));

  const projection = await jobs.enqueue({
    tenantId,
    type: 'PROJECTION_RECONCILE',
    idempotencyKey: `m6-enterprise-offline-${randomUUID()}`,
    correlationId: `corr-enterprise-${randomUUID()}`,
    resourceScopeRef: `m6-enterprise-recovery-${randomUUID()}`,
    payload: { kind: 'PROJECTION_RECONCILE', projectionRef: `m6-enterprise-${randomUUID()}`, sourceVersion: 1 },
  });
  const projectionFirst = await jobs.claimNext('m6-enterprise-offline-first', 300_000, ['PROJECTION_RECONCILE']);
  assert.equal(projectionFirst?.id, projection.id);
  await jobs.finish(projectionFirst!, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' }, () => 0);
  await wait(10);
  const projectionRecovered = await jobs.claimNext('m6-enterprise-recovered', 300_000, ['PROJECTION_RECONCILE']);
  assert.equal(projectionRecovered?.id, projection.id);
  assert.equal(projectionRecovered?.attempt, 2);
  await jobs.finish(projectionRecovered!, { kind: 'SUCCEEDED' });

  const ambiguous = await jobs.enqueue({
    tenantId,
    type: 'OUTBOX_DELIVER',
    idempotencyKey: `m6-ambiguous-${randomUUID()}`,
    correlationId: `corr-ambiguous-${randomUUID()}`,
    resourceScopeRef: `m6-ambiguous-resource-${randomUUID()}`,
    payload: { kind: 'OUTBOX_DELIVER', outboxEventRef: randomUUID() },
  });
  const ambiguousClaim = await jobs.claimNext('m6-ambiguous-outcome', 300_000, ['OUTBOX_DELIVER']);
  assert.equal(ambiguousClaim?.id, ambiguous.id);
  await jobs.finish(ambiguousClaim!, { kind: 'UNKNOWN', safeErrorCode: 'PROVIDER_RESULT_UNKNOWN' });
  assert.equal(await jobs.claimNext('m6-ambiguous-no-retry', 300_000, ['OUTBOX_DELIVER']), null);
  const dataSource = await database.getDataSource();
  const [ambiguousRow] = await dataSource.query('SELECT status, attempt FROM ca_meta_jobs WHERE id = ?', [ambiguous.id]) as Array<{ status: string; attempt: number }>;
  assert.equal(ambiguousRow?.status, 'UNKNOWN');
  assert.equal(Number(ambiguousRow?.attempt), 1);

  return {
    safeInboxDependencyRetryAttempt: retried?.attempt,
    persistedInboxLeaseReclaimAttempt: replacement?.attempt,
    projectionRetryAttempt: projectionRecovered?.attempt,
    ambiguousDeliveryState: ambiguousRow?.status,
    ambiguousDeliveryAttempts: Number(ambiguousRow?.attempt),
    metaAndEnterpriseFailuresAreSyntheticOutcomes: true,
  };
}
