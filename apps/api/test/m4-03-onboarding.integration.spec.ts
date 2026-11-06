import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { validateEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { DurableJobStore, type ClaimedJob } from '../src/jobs/job-store.js';
import { hashOnboardingValue } from '../src/onboarding/onboarding-session.types.js';
import { MysqlOnboardingSessionStore } from '../src/onboarding/mysql-onboarding-session.store.js';
import { OnboardingCodeProtector } from '../src/onboarding/onboarding-code-crypto.js';
import { MysqlOnboardingCodeConsumer, MysqlOnboardingCodeSubmissionStore,
  OnboardingCodeConflictError } from '../src/onboarding/onboarding-code-submission.store.js';
import { MysqlOnboardingSagaRecoveryStore, OnboardingRecoveryConflictError,
  OnboardingRecoveryNotFoundError } from '../src/onboarding/onboarding-saga-recovery.js';
import { createOnboardingSagaHandler, MysqlOnboardingSagaCheckpoints } from '../src/onboarding/onboarding-saga.worker.js';
import type { OnboardingSagaAdapter } from '../src/onboarding/onboarding-saga.types.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';
const rawCode = 'synthetic-provider-code-do-not-persist';

function decodeJson(value: string | Buffer | Record<string, unknown> | undefined): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as Record<string, unknown>;
  return value ?? {};
}

test('M4.03 stages authorization code ciphertext and atomically consumes it once with one durable job', {
  skip: enabled ? false : 'Run in the disposable MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const sessionStore = new MysqlOnboardingSessionStore(environment.database);
  const jobs = new DurableJobStore(database);
  const codes = new MysqlOnboardingCodeSubmissionStore(database, jobs);
  const signingKey = Buffer.alloc(32, 0x37).toString('base64url');
  const protector = new OnboardingCodeProtector(signingKey);
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const portalSessionId = randomUUID();
  const onboardingId = randomUUID();
  const codeRef = randomUUID();
  const assetRef = randomUUID();
  const idempotencyHash = hashOnboardingValue(`m4-03-idempotency-${randomUUID()}`);
  const stateRef = `synthetic-state-${randomUUID()}`;
  const requestHash = hashOnboardingValue('synthetic-m4-03-session-request');
  const providerStateHash = hashOnboardingValue(stateRef);
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + '.000000';
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const sessionSecretHash = hashOnboardingValue(`portal-session-secret-${randomUUID()}`);
  const idempotencyKey = `onboarding-code:${idempotencyHash}`;
  const recoveryJobIds: string[] = [];
  const requestCodeHash = hashOnboardingValue(JSON.stringify({
    onboardingId, flowVariant: 'WHATSAPP_CLOUD_API', configurationRef: 'synthetic-whatsapp-config-v1',
    stateHash: providerStateHash, codeHash: hashOnboardingValue(rawCode),
  }));
  const codeContext = { tenantId, onboardingId, flowVariant: 'WHATSAPP_CLOUD_API' as const,
    authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', configurationRef: 'synthetic-whatsapp-config-v1' };
  const sealedCode = protector.seal(codeContext, rawCode);
  let jobId: string | undefined;

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [tenantId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', 'm4-03-synthetic', ?, 'ACTIVE', 1, ?, ?)`,
      [principalId, `subject-${principalId}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_memberships
       (tenant_id, principal_id, principal_kind, roles, status, version, created_at, updated_at)
       VALUES (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', 1, ?, ?)`, [tenantId, principalId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_memberships
       (tenant_id, principal_id, principal_kind, roles, status, version, created_at, updated_at)
       VALUES (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', 1, ?, ?)`, [tenantId, principalId, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_portal_sessions
       (id, principal_id, tenant_id, secret_hash, csrf_token_hash, context_ref_hash, context_version,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at, entry_mode)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE),
               DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 60 MINUTE), 'SUITE4_EMBED')`,
      [portalSessionId, principalId, tenantId, sessionSecretHash, 'a'.repeat(64), 'b'.repeat(64), timestamp, timestamp],
    );
    const record = await sessionStore.createOrReplay({
      id: onboardingId, tenantId, principalId, portalSessionId, tenantContextHash: 'c'.repeat(64),
      createdAt: new Date(), flowVariant: 'WHATSAPP_CLOUD_API', configurationRef: codeContext.configurationRef,
      authVariant: codeContext.authVariant, capabilityManifestVersion: 'meta-capability-manifest-v1', graphApiVersion: 'v27.0',
      requestedCapabilities: ['READ_STATUS'], returnRoute: 'connections', idempotencyHash: hashOnboardingValue(`session-idem-${randomUUID()}`),
      requestHash, providerStateHash, expiresAt,
    });

    const input = { record, codeRef, idempotencyHash, requestHash: requestCodeHash, sealedCode, principalId, portalSessionId };
    const first = await codes.accept(input);
    jobId = first.jobId;
    assert.equal(first.duplicate, false);
    const duplicate = await codes.accept({ ...input, codeRef: randomUUID() });
    assert.deepEqual(duplicate, { jobId: first.jobId, duplicate: true });
    await assert.rejects(codes.accept({ ...input, codeRef: randomUUID(), idempotencyHash: hashOnboardingValue('different-idempotency-key') }),
      OnboardingCodeConflictError);

    const staged = await dataSource.query(
      `SELECT c.code_hash, c.ciphertext, c.consumed_at, j.payload_json
       FROM ca_meta_onboarding_codes c
       INNER JOIN ca_meta_jobs j ON j.tenant_id = c.tenant_id AND j.idempotency_key = ?
       WHERE c.tenant_id = ? AND c.onboarding_id = ? LIMIT 1`,
      [idempotencyKey, tenantId, onboardingId],
    ) as Array<{ code_hash: string; ciphertext: Buffer; consumed_at: string | Date | null; payload_json: string | Record<string, unknown> }>;
    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.consumed_at, null);
    assert.notEqual(staged[0]?.ciphertext.toString('utf8'), rawCode);
    assert.doesNotMatch(JSON.stringify(staged[0]), /synthetic-provider-code-do-not-persist/);
    const stagedPayload = decodeJson(staged[0]?.payload_json);
    assert.equal(stagedPayload.codeRef, codeRef);
    assert.doesNotMatch(JSON.stringify(stagedPayload), /synthetic-provider-code-do-not-persist/);

    await dataSource.query(
      `UPDATE ca_meta_onboarding_sessions SET status = 'EXCHANGING',
       steps_json = JSON_ARRAY(JSON_OBJECT('name','authorization','status','RUNNING'),
         JSON_OBJECT('name','asset-verification','status','PENDING'), JSON_OBJECT('name','subscription','status','PENDING'),
         JSON_OBJECT('name','projection','status','PENDING')) WHERE tenant_id = ? AND id = ?`, [tenantId, onboardingId],
    );
    const consumer = new MysqlOnboardingCodeConsumer(database, protector);
    const consumed = await consumer.consumeOnce({ tenantId, onboardingId, codeRef });
    assert.equal(consumed?.code, rawCode);
    assert.deepEqual(await consumer.consumeOnce({ tenantId, onboardingId, codeRef }), undefined);
    const erased = await dataSource.query(
      'SELECT nonce, ciphertext, authentication_tag, consumed_at FROM ca_meta_onboarding_codes WHERE code_ref = ?', [codeRef],
    ) as Array<{ nonce: Buffer | null; ciphertext: Buffer | null; authentication_tag: Buffer | null; consumed_at: string | Date | null }>;
    assert.ok(erased[0]?.consumed_at);
    assert.equal(erased[0]?.nonce, null);
    assert.equal(erased[0]?.ciphertext, null);
    assert.equal(erased[0]?.authentication_tag, null);

    await dataSource.query(
      `UPDATE ca_meta_jobs SET status = 'SUCCEEDED', completed_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND id = ?`, [tenantId, jobId],
    );
    await dataSource.query(
      `UPDATE ca_meta_onboarding_sessions SET status = 'PROVISIONING', readiness = 'UNKNOWN', next_action = 'RECONCILE',
       steps_json = JSON_ARRAY(JSON_OBJECT('name','authorization','status','SUCCEEDED'),
         JSON_OBJECT('name','asset-verification','status','SUCCEEDED'), JSON_OBJECT('name','subscription','status','UNKNOWN'),
         JSON_OBJECT('name','projection','status','PENDING')),
       saga_checkpoint_json = JSON_OBJECT('authorizationRef','synthetic-auth-ref',
         'verifiedAssetRefs', JSON_ARRAY(?)) WHERE tenant_id = ? AND id = ?`, [assetRef, tenantId, onboardingId],
    );
    const recoveryRecord = await sessionStore.findForSession(onboardingId, portalSessionId, principalId);
    assert.ok(recoveryRecord);
    const recovery = new MysqlOnboardingSagaRecoveryStore(database, jobs);
    const reconcileInput = { record: recoveryRecord!, principalId, portalSessionId, stage: 'subscription' as const,
      action: 'RECONCILE' as const, idempotencyKey: hashOnboardingValue(`reconcile-${randomUUID()}`) };
    const reconciliation = await recovery.queue(reconcileInput);
    recoveryJobIds.push(reconciliation.id);
    assert.equal(reconciliation.duplicate, false);
    assert.deepEqual(await recovery.queue(reconcileInput), { id: reconciliation.id, duplicate: true });
    await assert.rejects(recovery.queue({ ...reconcileInput, stage: 'projection' }), OnboardingRecoveryConflictError,
      'reusing a recovery key for a different onboarding stage conflicts');
    const reconcileJob = await dataSource.query(
      'SELECT payload_json FROM ca_meta_jobs WHERE tenant_id = ? AND id = ?', [tenantId, reconciliation.id],
    ) as Array<{ payload_json: string | Record<string, unknown> }>;
    const reconcilePayload = decodeJson(reconcileJob[0]?.payload_json);
    assert.equal(reconcilePayload.operation, 'RECONCILE');
    assert.equal(reconcilePayload.stepRef, 'subscription');
    assert.equal(JSON.stringify(reconcilePayload).includes(rawCode), false);

    await dataSource.query(
      `UPDATE ca_meta_jobs SET status = 'SUCCEEDED', completed_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND id = ?`, [tenantId, reconciliation.id],
    );
    await dataSource.query(
      `UPDATE ca_meta_onboarding_sessions SET readiness = 'PARTIAL', next_action = 'RESUME',
       steps_json = JSON_SET(steps_json, '$[2].status', 'RETRY_PENDING') WHERE tenant_id = ? AND id = ?`,
      [tenantId, onboardingId],
    );
    const resumeRecord = await sessionStore.findForSession(onboardingId, portalSessionId, principalId);
    assert.ok(resumeRecord);
    assert.equal(resumeRecord?.nextAction, 'RESUME');
    const resume = await recovery.queue({ ...reconcileInput, record: resumeRecord!, action: 'RESUME',
      idempotencyKey: hashOnboardingValue(`resume-${randomUUID()}`) });
    recoveryJobIds.push(resume.id);
    assert.equal(resume.duplicate, false);
    const resumedJob = await dataSource.query(
      'SELECT payload_json FROM ca_meta_jobs WHERE tenant_id = ? AND id = ?', [tenantId, resume.id],
    ) as Array<{ payload_json: string | Record<string, unknown> }>;
    const resumedPayload = decodeJson(resumedJob[0]?.payload_json);
    assert.equal(resumedPayload.stepRef, 'subscription');
    assert.equal('operation' in resumedPayload, false);

    await dataSource.query(
      `UPDATE ca_meta_memberships SET roles = JSON_ARRAY('viewer') WHERE tenant_id = ? AND principal_id = ?`, [tenantId, principalId],
    );
    let providerEffects = 0;
    let codeReads = 0;
    const adapter: OnboardingSagaAdapter = {
      async exchangeAuthorizationCode() { providerEffects += 1; return { authorizationRef: 'unexpected' }; },
      async discoverAndPersistAssets() { providerEffects += 1; return { assetRefs: [assetRef] }; },
      async ensureSubscriptions() { providerEffects += 1; return { subscriptionRef: 'unexpected' }; },
      async publishProjection() { providerEffects += 1; return { projectionRef: 'unexpected' }; },
    };
    const sagaHandler = createOnboardingSagaHandler(database, {
      async consumeOnce() { codeReads += 1; return undefined; },
    }, adapter, new MysqlOnboardingSagaCheckpoints(database));
    const workerOutcome = await sagaHandler({
      id: resume.id, tenantId, resourceScopeRef: onboardingId, type: 'ONBOARDING_STEP', lane: 'ONBOARDING',
      effectMode: 'AMBIGUOUS', payload: resumedPayload as ClaimedJob['payload'], idempotencyKey: 'synthetic-resume-job',
      correlationId: onboardingId, causationId: onboardingId, attempt: 1, maxAttempts: 2,
      claimToken: randomUUID(), workerRef: 'm4-03-integration-worker', budgetStartedAt: timestamp, createdAt: timestamp,
    }, new AbortController().signal, {} as never);
    assert.deepEqual(workerOutcome, { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' });
    assert.equal(providerEffects, 0, 'revoked CONNECT membership blocks provider effects after the recovery job is queued');
    assert.equal(codeReads, 0, 'the one-use code is not read during downstream recovery');
    await assert.rejects(recovery.queue({ ...reconcileInput, action: 'RECONCILE',
      idempotencyKey: hashOnboardingValue(`revoked-${randomUUID()}`) }), OnboardingRecoveryNotFoundError,
    'a revoked CONNECT membership cannot queue recovery work');
  } finally {
    if (recoveryJobIds.length > 0) {
      await dataSource.query(`DELETE FROM ca_meta_jobs WHERE tenant_id = ? AND id IN (${recoveryJobIds.map(() => '?').join(', ')})`,
        [tenantId, ...recoveryJobIds]);
    }
    if (jobId) await dataSource.query('DELETE FROM ca_meta_jobs WHERE tenant_id = ? AND id = ?', [tenantId, jobId]);
    await dataSource.query('DELETE FROM ca_meta_onboarding_codes WHERE tenant_id = ?', [tenantId]);
    await dataSource.query('DELETE FROM ca_meta_onboarding_sessions WHERE tenant_id = ?', [tenantId]);
    await dataSource.query('DELETE FROM ca_meta_memberships WHERE tenant_id = ?', [tenantId]);
    await dataSource.query('DELETE FROM ca_meta_portal_sessions WHERE id = ?', [portalSessionId]);
    await dataSource.query('DELETE FROM ca_meta_principals WHERE id = ?', [principalId]);
    await dataSource.query('DELETE FROM ca_meta_tenants WHERE id = ?', [tenantId]);
    await codes.onModuleDestroy();
    await sessionStore.onApplicationShutdown();
    await database.close();
  }
});
