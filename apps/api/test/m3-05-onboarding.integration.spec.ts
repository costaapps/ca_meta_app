import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { ONBOARDING_SESSIONS_MIGRATION } from '../src/database/migrations/onboarding-sessions.js';
import { validateEnvironment } from '../src/config/environment.js';
import { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { MysqlOnboardingSessionStore } from '../src/onboarding/mysql-onboarding-session.store.js';
import { hashOnboardingValue, type OnboardingProviderOutcome } from '../src/onboarding/onboarding-session.types.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';

test('M3.05 MariaDB onboarding rows are session scoped, idempotent by tenant and consume provider state once', {
  skip: enabled ? false : 'Run in the disposable M2.05/M3 MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  await deployMigrations(readMigrationEnvironment(process.env));
  const environment = validateEnvironment(process.env);
  const database = new DurableWorkDatabase(environment);
  const dataSource = await database.getDataSource();
  const store = new MysqlOnboardingSessionStore(environment.database);
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + '.000000';
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const id = randomUUID();
  const idB = randomUUID();
  const idempotencyHash = hashOnboardingValue(`m3-05-idempotency-${randomUUID()}`);
  const requestHash = hashOnboardingValue('synthetic-onboarding-body');
  const stateRef = `synthetic-provider-state-${randomUUID()}`;
  const providerStateHash = hashOnboardingValue(stateRef);
  const expiresAt = new Date(Date.now() + 5 * 60_000);

  try {
    await dataSource.query("SET time_zone = '+00:00'");
    const applied = await dataSource.query(
      'SELECT state FROM ca_meta_schema_migrations WHERE migration_id = ?', [ONBOARDING_SESSIONS_MIGRATION.id],
    ) as Array<{ state: string }>;
    assert.equal(applied[0]?.state, 'APPLIED', 'the disposable profile must apply M3.05 schema v10');
    await dataSource.query(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?), (?, 'ACTIVE', 1, ?, ?)`,
      [tenantA, timestamp, timestamp, tenantB, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', 'm3-05-synthetic', ?, 'ACTIVE', 1, ?, ?),
              (?, 'USER', 'm3-05-synthetic', ?, 'ACTIVE', 1, ?, ?)`,
      [principalA, `subject-${principalA}`, timestamp, timestamp, principalB, `subject-${principalB}`, timestamp, timestamp],
    );
    await dataSource.query(
      `INSERT INTO ca_meta_portal_sessions
       (id, principal_id, tenant_id, secret_hash, csrf_token_hash, context_ref_hash, context_version,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at, entry_mode)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE),
               DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 60 MINUTE), 'SUITE4_EMBED'),
              (?, ?, ?, ?, ?, ?, 1, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE),
               DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 60 MINUTE), 'PORTAL_TOP_LEVEL')`,
      [sessionA, principalA, tenantA, hashOnboardingValue(`session-a-${randomUUID()}`), 'a'.repeat(64), 'b'.repeat(64), timestamp, timestamp,
        sessionB, principalB, tenantB, hashOnboardingValue(`session-b-${randomUUID()}`), 'c'.repeat(64), 'd'.repeat(64), timestamp, timestamp],
    );

    const command = {
      id,
      tenantId: tenantA,
      principalId: principalA,
      portalSessionId: sessionA,
      tenantContextHash: 'e'.repeat(64),
      createdAt: new Date(Date.now()),
      flowVariant: 'WHATSAPP_CLOUD_API' as const,
      configurationRef: 'synthetic-whatsapp-config-v1',
      authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' as const,
      capabilityManifestVersion: 'meta-capability-manifest-v1',
      graphApiVersion: 'v27.0',
      requestedCapabilities: ['READ_STATUS'],
      returnRoute: 'connections' as const,
      idempotencyHash,
      requestHash,
      providerStateHash,
      expiresAt,
    };
    const created = await store.createOrReplay(command);
    assert.equal(created.id, id);
    assert.equal(created.tenantId, tenantA);
    assert.equal(created.status, 'AWAITING_PROVIDER');
    assert.deepEqual(created.steps.map((step) => step.name), ['authorization', 'asset-verification', 'subscription', 'projection']);
    assert.equal(await store.findForSession(id, sessionA, principalA).then((row) => row?.tenantId), tenantA);
    assert.equal(await store.findForSession(id, sessionB, principalB), undefined, 'a different tenant session cannot read the onboarding');
    assert.equal(await store.findForSession(id, sessionA, principalB), undefined, 'a different principal cannot read the onboarding');

    const sameKeyInOtherTenant = await store.createOrReplay({
      ...command,
      id: idB,
      tenantId: tenantB,
      principalId: principalB,
      portalSessionId: sessionB,
      tenantContextHash: 'f'.repeat(64),
      providerStateHash: hashOnboardingValue(`tenant-b-state-${randomUUID()}`),
    });
    assert.equal(sameKeyInOtherTenant.id, idB, 'the same idempotency key is scoped to its tenant');

    const replay = await store.createOrReplay({ ...command, id: randomUUID(), providerStateHash: hashOnboardingValue(`other-${randomUUID()}`) });
    assert.equal(replay.id, id, 'the tenant idempotency key maps to the original server record');

    const outcome = {
      stateRef,
      status: 'PROVISIONING',
      readiness: 'UNKNOWN',
      steps: [{ name: 'authorization', status: 'SUCCEEDED' }, { name: 'asset-verification', status: 'PENDING' }],
      nextAction: 'CHECK_STATUS',
    } as unknown as OnboardingProviderOutcome;
    assert.equal(await store.completeByProviderState(providerStateHash, outcome), true);
    assert.equal(await store.completeByProviderState(providerStateHash, outcome), false, 'provider state can be consumed only once');
    const updated = await store.findForSession(id, sessionA, principalA);
    assert.equal(updated?.status, 'PROVISIONING');
    assert.equal(updated?.stateConsumed, true);
    const rawStored = await dataSource.query(
      'SELECT provider_state_hash, request_hash, idempotency_key_hash, steps_json FROM ca_meta_onboarding_sessions WHERE id = ?', [id],
    ) as Array<{ provider_state_hash: string; request_hash: string; idempotency_key_hash: string; steps_json: string }>;
    assert.equal(rawStored[0]?.provider_state_hash, providerStateHash);
    assert.equal(JSON.stringify(rawStored[0]).includes(stateRef), false, 'the provider state value is never stored');
  } finally {
    await store.onApplicationShutdown();
    await dataSource.query('DELETE FROM ca_meta_onboarding_sessions WHERE id IN (?, ?)', [id, idB]);
    await dataSource.query('DELETE FROM ca_meta_portal_sessions WHERE id IN (?, ?)', [sessionA, sessionB]);
    await dataSource.query('DELETE FROM ca_meta_principals WHERE id IN (?, ?)', [principalA, principalB]);
    await dataSource.query('DELETE FROM ca_meta_tenants WHERE id IN (?, ?)', [tenantA, tenantB]);
    await database.close();
  }
});
