import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import test from 'node:test';
import { validateEnvironment } from '../src/config/environment.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { deployMigrations } from '../src/database/migrations/migration-runner.js';
import { hashOnboardingValue, OnboardingCoexistenceActiveSessionConflictError,
  type OnboardingCreateCommand } from '../src/onboarding/onboarding-session.types.js';
import { MysqlOnboardingSessionStore } from '../src/onboarding/mysql-onboarding-session.store.js';

const enabled = process.env.M2_DURABLE_WORK_TEST === '1';

test('M5.03 serializes Coexistence starts per tenant and releases on terminal/expiry without blocking other flows', {
  skip: enabled ? false : 'Run against the M5.03 disposable MariaDB profile with M2_DURABLE_WORK_TEST=1.',
}, async () => {
  const migrationEnvironment = readMigrationEnvironment(process.env);
  await deployMigrations(migrationEnvironment);
  const environment = validateEnvironment(process.env);
  const connection = await createConnection({
    host: environment.database.host,
    port: environment.database.port,
    database: environment.database.name,
    user: environment.database.user,
    password: environment.database.password,
    connectTimeout: environment.database.connectTimeoutMs,
    multipleStatements: false,
    dateStrings: true,
    charset: 'utf8mb4',
  });
  const sessions = new MysqlOnboardingSessionStore(environment.database);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const principal = randomUUID();
  const portalSessionA = randomUUID();
  const portalSessionB = randomUUID();
  const now = new Date();
  const sqlDate = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ') + '.' + date.toISOString().slice(20, 23) + '000';

  async function seedTenant(tenantId: string, portalSessionId: string): Promise<void> {
    const timestamp = sqlDate(now);
    await connection.execute(
      `INSERT INTO ca_meta_tenants (id, status, version, created_at, updated_at)
       VALUES (?, 'ACTIVE', 1, ?, ?)`, [tenantId, timestamp, timestamp],
    );
    await connection.execute(
      `INSERT INTO ca_meta_portal_sessions
        (id, principal_id, tenant_id, secret_hash, csrf_token_hash, context_ref_hash, context_version, entry_mode,
         created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'PORTAL_TOP_LEVEL', ?, ?, ?, ?, NULL)`,
      [portalSessionId, principal, tenantId, hashOnboardingValue(`session-${portalSessionId}`),
        hashOnboardingValue(`csrf-${portalSessionId}`), hashOnboardingValue(`context-${portalSessionId}`),
        timestamp, timestamp, sqlDate(new Date(Date.now() + 30 * 60_000)), sqlDate(new Date(Date.now() + 8 * 60 * 60_000))],
    );
  }

  function command(input: {
    tenantId: string; portalSessionId: string; flowVariant?: OnboardingCreateCommand['flowVariant']; ttlMs?: number;
  }): OnboardingCreateCommand {
    const createdAt = new Date();
    const idempotencyHash = hashOnboardingValue(`m5-03-idempotency-${randomUUID()}`);
    return Object.freeze({
      id: randomUUID(), tenantId: input.tenantId, principalId: principal, portalSessionId: input.portalSessionId,
      tenantContextHash: hashOnboardingValue(`context-${input.tenantId}`), createdAt,
      flowVariant: input.flowVariant ?? 'WHATSAPP_COEXISTENCE',
      configurationRef: 'synthetic-coexistence-v1', providerAppId: 'synthetic-meta-app', providerEnvironment: 'test',
      authVariant: input.flowVariant === 'FACEBOOK_LOGIN' ? 'FACEBOOK_LOGIN_FOR_BUSINESS' : 'WHATSAPP_BUSINESS_APP_ONBOARDING',
      capabilityManifestVersion: 'm5-03-synthetic-v1', graphApiVersion: 'v99.0',
      requestedCapabilities: Object.freeze(['READ_STATUS']), returnRoute: 'connections', idempotencyHash,
      requestHash: hashOnboardingValue(`request-${idempotencyHash}`),
      providerStateHash: hashOnboardingValue(`state-${idempotencyHash}`),
      expiresAt: new Date(createdAt.getTime() + (input.ttlMs ?? 10 * 60_000)),
    });
  }

  try {
    const principalTimestamp = sqlDate(now);
    await connection.execute(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, version, created_at, updated_at)
       VALUES (?, 'USER', ?, ?, 'ACTIVE', 1, ?, ?)`,
      [principal, `synthetic-issuer-${principal}`, `synthetic-subject-${principal}`, principalTimestamp, principalTimestamp],
    );
    await seedTenant(tenantA, portalSessionA);
    await seedTenant(tenantB, portalSessionB);

    const [firstCommand, competingCommand] = [
      command({ tenantId: tenantA, portalSessionId: portalSessionA }),
      command({ tenantId: tenantA, portalSessionId: portalSessionA }),
    ];
    const race = await Promise.allSettled([
      sessions.createOrReplay(firstCommand), sessions.createOrReplay(competingCommand),
    ]);
    const accepted = race.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof sessions.createOrReplay>>> =>
      result.status === 'fulfilled');
    const rejected = race.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(accepted.length, 1, 'exactly one distinct Coexistence key may create an active session');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof OnboardingCoexistenceActiveSessionConflictError);
    const winningCommand = accepted[0]?.value.id === firstCommand.id ? firstCommand : competingCommand;
    const replay = await sessions.createOrReplay(winningCommand);
    assert.equal(replay.id, accepted[0]?.value.id, 'same key and payload replay the same active session');

    const [lockRows] = await connection.execute<Array<{ onboarding_session_id: string } & import('mysql2').RowDataPacket>>(
      'SELECT onboarding_session_id FROM ca_meta_onboarding_coexistence_locks WHERE tenant_id = ?', [tenantA],
    );
    assert.equal(lockRows.length, 1);
    assert.equal(lockRows[0]?.onboarding_session_id, accepted[0]?.value.id);

    const facebook = await sessions.createOrReplay(command({
      tenantId: tenantA, portalSessionId: portalSessionA, flowVariant: 'FACEBOOK_LOGIN',
    }));
    assert.equal(facebook.flowVariant, 'FACEBOOK_LOGIN', 'a Coexistence lock does not block a different flow variant');

    const tenantBCommand = command({ tenantId: tenantB, portalSessionId: portalSessionB });
    const tenantBRecord = await sessions.createOrReplay(tenantBCommand);
    assert.equal(tenantBRecord.flowVariant, 'WHATSAPP_COEXISTENCE', 'another tenant may start its own Coexistence session');

    await connection.execute(
      `UPDATE ca_meta_onboarding_sessions SET status = 'CANCELLED', readiness = 'UNKNOWN', next_action = 'NONE',
         last_updated_at = UTC_TIMESTAMP(6), version = version + 1 WHERE tenant_id = ? AND id = ?`,
      [tenantA, accepted[0]?.value.id],
    );
    const [releasedRows] = await connection.execute<Array<{ tenant_id: string } & import('mysql2').RowDataPacket>>(
      'SELECT tenant_id FROM ca_meta_onboarding_coexistence_locks WHERE tenant_id = ?', [tenantA],
    );
    assert.equal(releasedRows.length, 0, 'terminal status releases the durable per-tenant lock');
    const afterTerminal = await sessions.createOrReplay(command({ tenantId: tenantA, portalSessionId: portalSessionA }));
    assert.equal(afterTerminal.flowVariant, 'WHATSAPP_COEXISTENCE');

    await connection.execute(
      `UPDATE ca_meta_onboarding_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE tenant_id = ? AND id = ?`,
      [tenantB, tenantBRecord.id],
    );
    const afterExpiry = await sessions.createOrReplay(command({ tenantId: tenantB, portalSessionId: portalSessionB }));
    assert.equal(afterExpiry.flowVariant, 'WHATSAPP_COEXISTENCE', 'an expired active session no longer occupies the tenant slot');
    const [expiredRows] = await connection.execute<Array<{ status: string } & import('mysql2').RowDataPacket>>(
      'SELECT status FROM ca_meta_onboarding_sessions WHERE tenant_id = ? AND id = ?', [tenantB, tenantBRecord.id],
    );
    assert.equal(expiredRows[0]?.status, 'EXPIRED', 'the next create materializes an expired session as terminal');
    const [expiryLockRows] = await connection.execute<Array<{ onboarding_session_id: string } & import('mysql2').RowDataPacket>>(
      'SELECT onboarding_session_id FROM ca_meta_onboarding_coexistence_locks WHERE tenant_id = ?', [tenantB],
    );
    assert.equal(expiryLockRows.length, 1);
    assert.equal(expiryLockRows[0]?.onboarding_session_id, afterExpiry.id, 'the expired lock is replaced by the new session');
  } finally {
    try {
      await connection.execute('DELETE FROM ca_meta_onboarding_coexistence_locks WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
      await connection.execute('DELETE FROM ca_meta_onboarding_sessions WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
      await connection.execute('DELETE FROM ca_meta_portal_sessions WHERE id IN (?, ?)', [portalSessionA, portalSessionB]);
      await connection.execute('DELETE FROM ca_meta_principals WHERE id = ?', [principal]);
      await connection.execute('DELETE FROM ca_meta_tenants WHERE id IN (?, ?)', [tenantA, tenantB]);
    } finally {
      await sessions.onApplicationShutdown();
      await connection.end();
    }
  }
});
