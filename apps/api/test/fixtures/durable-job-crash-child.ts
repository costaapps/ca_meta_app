import { validateEnvironment } from '../../src/config/environment.js';
import { DurableWorkDatabase } from '../../src/jobs/durable-work-database.js';
import { DurableJobStore } from '../../src/jobs/job-store.js';
import { InboxService } from '../../src/inbox/inbox-service.js';

async function claimThenWaitForParentKill(): Promise<void> {
  const database = new DurableWorkDatabase(validateEnvironment(process.env));
  const jobs = new DurableJobStore(database, () => 0);
  const inbox = new InboxService(database, jobs);
  const effectEventId = process.env.M2_CRASH_FIXTURE_EFFECT_EVENT_ID;
  const effectAppConfigRef = process.env.M2_CRASH_FIXTURE_APP_CONFIG_REF;
  const effectJobType = process.env.M2_CRASH_FIXTURE_JOB_TYPE;
  if ((effectEventId && !/^provider-crash-effect-[a-f0-9-]{36}$/.test(effectEventId)) ||
    (effectAppConfigRef && !/^[0-9a-f-]{36}$/i.test(effectAppConfigRef))) process.exit(86);
  const supportedTypes = effectJobType === 'PROJECTION_RECONCILE' ? ['PROJECTION_RECONCILE'] as const : ['INBOX_PROCESS'] as const;
  const claim = await jobs.claimNext('crash-fixture-child', 120, supportedTypes);
  if (!claim) {
    process.send?.({ type: 'no-claim' });
    process.exit(87);
  }
  let inboxId: string | undefined;
  if (effectEventId && effectAppConfigRef) {
    const persisted = await inbox.persist({
      eventId: effectEventId,
      schemaVersion: 1,
      eventType: 'provider.unclassified',
      appConfigRef: effectAppConfigRef,
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
    });
    if (persisted.duplicate) process.exit(85);
    inboxId = persisted.id;
  }
  process.send?.({ type: inboxId ? 'effect-committed' : 'claimed', jobId: claim.id, inboxId }, () => {
    // Keep the process alive with an open pool and an unacknowledged lease until the parent kills it.
    setTimeout(() => process.exit(88), 30_000);
  });
}

void claimThenWaitForParentKill().catch(() => process.exit(89));
