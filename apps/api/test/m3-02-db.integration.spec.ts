import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import type { Response } from 'express';
import { UnauthorizedException } from '@nestjs/common';
import { test } from 'node:test';
import { ConfiguredTicketKeySet } from '../src/auth-exchange/configured-ticket-key-set.js';
import { TicketExchangeService } from '../src/auth-exchange/ticket-exchange.service.js';
import type { ExchangeRequestContext } from '../src/auth-exchange/ticket-exchange.service.js';
import type {
  PortalExchangeAbuseLimitPort,
  PortalPreAuthServicePort,
  PortalSessionIssuerPort,
  TicketExchangeConfiguration,
} from '../src/auth-exchange/ticket-contract.js';
import { PORTAL_SESSION_COOKIE_NAME, PRE_AUTH_COOKIE_NAME } from '../src/auth-exchange/ticket-contract.js';
import { readMigrationEnvironment } from '../src/database/migrations/migration-environment.js';
import { MIGRATIONS } from '../src/database/migrations/migrations.js';
import { readMigrationStatus } from '../src/database/migrations/migration-runner.js';
import { MysqlIdentityRepository } from '../src/identity/mysql-identity.repository.js';
import { MysqlPortalSessionStore } from '../src/identity/mysql-portal-session.store.js';
import { PortalSessionVerifier } from '../src/identity/identity.trust.js';
import { TenantContextService } from '../src/identity/identity.service.js';
import { MysqlPortalSessionService, setPortalSessionCookies } from '../src/identity/portal-session.service.js';

const enabled = process.env.M3_02_DB_TEST === '1';
const issuer = 'https://suite4.synthetic.invalid/portal';
const audience = 'https://portal.synthetic.invalid';
const origin = audience;
const configuration: TicketExchangeConfiguration = {
  issuer,
  audience,
  clockSkewSeconds: 5,
  maximumLifetimeSeconds: 60,
};
const recoveryKey = 'synthetic-m3-02-db-recovery-key-with-more-than-32-bytes';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const trustedKeys = new ConfiguredTicketKeySet([{
  kid: 'm3-02-db-synthetic',
  publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
}]);

class SyntheticAbuseLimit implements PortalExchangeAbuseLimitPort {
  arrived = 0;
  private release!: () => void;
  private fail!: (error: Error) => void;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly bothArrived = new Promise<void>((resolve, reject) => {
    this.release = resolve;
    this.fail = reject;
  });

  consume(bucket: 'PORTAL_EXCHANGE_ATTEMPT', dimensions: { readonly ip: string }): Promise<void>;
  consume(bucket: 'PORTAL_EXCHANGE', dimensions: { readonly ip: string; readonly actor: string }): Promise<void>;
  async consume(
    bucket: 'PORTAL_EXCHANGE_ATTEMPT' | 'PORTAL_EXCHANGE',
    _dimensions: { readonly ip: string; readonly actor?: string },
  ): Promise<void> {
    if (bucket === 'PORTAL_EXCHANGE_ATTEMPT') return;
    this.arrived += 1;
    if (this.arrived === 1) {
      this.timeout = setTimeout(() => this.fail(new Error('M3.02 DB race barrier timed out.')), 5000);
      this.timeout.unref();
    } else if (this.arrived === 2) {
      if (this.timeout) clearTimeout(this.timeout);
      this.release();
    }
    await this.bothArrived;
  }
}

interface CapturedResponse {
  readonly response: Response;
  readonly cookies: string[];
}

function captureResponse(): CapturedResponse {
  const cookies: string[] = [];
  const response = {
    append(name: string, value: string | readonly string[]) {
      if (name.toLowerCase() === 'set-cookie') cookies.push(...(Array.isArray(value) ? value : [value]));
      return this;
    },
    setHeader() { return this; },
  } as unknown as Response;
  return { response, cookies };
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeTicket(
  tenantId: string,
  subject: string,
  challengeRef: string,
  jti: string,
  extraClaims: Readonly<Record<string, unknown>> = {},
): string {
  const issuedAt = Math.floor(Date.now() / 1000) - 3;
  const header = encoded(JSON.stringify({ alg: 'RS256', kid: 'm3-02-db-synthetic', typ: 'JWT' }));
  const claims = encoded(JSON.stringify({
    iss: issuer,
    aud: audience,
    purpose: 'META_PORTAL_ENTRY',
    ver: 1,
    sub: subject,
    tenant: tenantId,
    session_iss: 'synthetic-session-authority-db-race',
    roles: ['owner'],
    jti,
    iat: issuedAt,
    exp: issuedAt + 45,
    preauth_challenge: challengeRef,
    ...extraClaims,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), pair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function exchangeContext(cookieValue: string, portalSessionCookie?: string): ExchangeRequestContext {
  return {
    headers: {
      origin,
      'sec-fetch-site': 'same-origin',
      cookie: `${PRE_AUTH_COOKIE_NAME}=${cookieValue}${portalSessionCookie ? `; ${PORTAL_SESSION_COOKIE_NAME}=${portalSessionCookie}` : ''}`,
    },
    requestId: randomUUID(),
    clientIp: '127.0.0.1',
  };
}

async function queryRows<T>(connection: Connection, sql: string, values: unknown[] = []): Promise<T[]> {
  const [result] = await connection.query(sql, values as never[]);
  return result as unknown as T[];
}

function sessionCookie(cookies: readonly string[]): string | undefined {
  return cookies.find((value) => value.startsWith(`${PORTAL_SESSION_COOKIE_NAME}=`))?.split(';', 1)[0];
}

function sessionCookieValue(cookies: readonly string[]): string | undefined {
  const cookie = sessionCookie(cookies);
  return cookie?.slice(`${PORTAL_SESSION_COOKIE_NAME}=`.length);
}

test('MariaDB persists one ticket session and recovers only for its original browser binding', {
  skip: enabled ? false : 'Set M3_02_DB_TEST=1 with a disposable loopback MariaDB to run the M3.02 race proof.',
}, async () => {
  const migrationEnvironment = readMigrationEnvironment(process.env);
  if (!['127.0.0.1', 'localhost', '::1'].includes(migrationEnvironment.database.host.toLowerCase())) {
    throw new Error('M3.02 database race test requires a loopback MariaDB host.');
  }
  const apiPassword = process.env.M2_API_DATABASE_PASSWORD;
  if (!apiPassword || !migrationEnvironment.apiDatabaseUser) {
    throw new Error('M3.02 database race test requires the isolated API database credentials.');
  }

  const migrationStatus = await readMigrationStatus(migrationEnvironment);
  assert.equal(migrationStatus.migrations.length, MIGRATIONS.length, 'all package migrations must already be deployed');
  assert.ok(migrationStatus.migrations.every((migration) => migration.state === 'APPLIED' && migration.checksumMatches));

  const admin = await createConnection({
    host: migrationEnvironment.database.host,
    port: migrationEnvironment.database.port,
    database: migrationEnvironment.database.name,
    user: migrationEnvironment.database.user,
    password: migrationEnvironment.database.password,
    connectTimeout: migrationEnvironment.database.connectTimeoutMs,
    multipleStatements: false,
    dateStrings: true,
    charset: 'utf8mb4',
    timezone: 'Z',
  });
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const subject = `m3-02-db-${randomUUID()}`;
  const runtimeDatabase = {
    host: migrationEnvironment.database.host,
    port: migrationEnvironment.database.port,
    name: migrationEnvironment.database.name,
    user: migrationEnvironment.apiDatabaseUser,
    password: apiPassword,
    connectTimeoutMs: migrationEnvironment.database.connectTimeoutMs,
  };
  const storeOptions = {
    database: runtimeDatabase,
    portalSessionIdleTimeoutSeconds: 1800,
    portalSessionAbsoluteTimeoutSeconds: 28800,
  };
  const storeA = new MysqlPortalSessionStore(storeOptions);
  const storeB = new MysqlPortalSessionStore(storeOptions);
  const identityA = new MysqlIdentityRepository(runtimeDatabase);
  const identityB = new MysqlIdentityRepository(runtimeDatabase);
  const sessionsA = new MysqlPortalSessionService(storeA, new TenantContextService(identityA), recoveryKey);
  const sessionsB = new MysqlPortalSessionService(storeB, new TenantContextService(identityB), recoveryKey);
  const challengeHashes: string[] = [];
  const jtiHashes: string[] = [];

  try {
    await admin.query(
      `INSERT INTO ca_meta_tenants (id, created_at, updated_at)
       VALUES (?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [tenantId],
    );
    await admin.query(
      `INSERT INTO ca_meta_principals (id, kind, issuer, subject, status, created_at, updated_at)
       VALUES (?, 'USER', ?, ?, 'ACTIVE', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [principalId, issuer, subject],
    );
    await admin.query(
      `INSERT INTO ca_meta_memberships
       (tenant_id, principal_id, principal_kind, roles, status, created_at, updated_at)
       VALUES (?, ?, 'USER', JSON_ARRAY('owner'), 'ACTIVE', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [tenantId, principalId],
    );

    const started = await sessionsA.begin();
    const challengeHash = createHash('sha256').update(started.challengeRef, 'utf8').digest('hex');
    challengeHashes.push(challengeHash);
    const jti = randomUUID();
    const jtiHash = createHash('sha256').update(issuer, 'utf8').update('\0').update(jti, 'utf8').digest('hex');
    jtiHashes.push(jtiHash);
    const ticket = makeTicket(tenantId, subject, started.challengeRef, jti);
    const abuseLimit = new SyntheticAbuseLimit();
    const exchangeA = new TicketExchangeService(
      configuration, trustedKeys, [origin], sessionsA as unknown as PortalPreAuthServicePort,
      sessionsA as unknown as PortalSessionIssuerPort, new PortalSessionVerifier(storeA), abuseLimit,
      { set: setPortalSessionCookies },
    );
    const exchangeB = new TicketExchangeService(
      configuration, trustedKeys, [origin], sessionsB as unknown as PortalPreAuthServicePort,
      sessionsB as unknown as PortalSessionIssuerPort, new PortalSessionVerifier(storeB), abuseLimit,
      { set: setPortalSessionCookies },
    );
    const value = { ticket, challengeRef: started.challengeRef };
    const responseA = captureResponse();
    const responseB = captureResponse();
    const [attemptA, attemptB] = await Promise.all([
      exchangeA.exchange(value, exchangeContext(started.cookieValue), responseA.response),
      exchangeB.exchange(value, exchangeContext(started.cookieValue), responseB.response),
    ]);

    assert.equal(abuseLimit.arrived, 2, 'both independent exchanges reached the barrier before session issuance');
    assert.equal(attemptA.sessionRef, attemptB.sessionRef);
    assert.equal(sessionCookie(responseA.cookies), sessionCookie(responseB.cookies));
    assert.ok(sessionCookie(responseA.cookies), 'the same browser receives its opaque portal cookie');

    const persistedSessions = await queryRows<{ id: string }>(admin,
      `SELECT id FROM ca_meta_portal_sessions WHERE id = ? AND principal_id = ? AND tenant_id = ? AND revoked_at IS NULL`,
      [attemptA.sessionRef, principalId, tenantId],
    );
    assert.deepEqual(persistedSessions, [{ id: attemptA.sessionRef }], 'concurrent exchanges persist exactly one session');
    const persistedTicket = await queryRows<{ session_id: string; pre_auth_id: string; ticket_sha256: string | null }>(admin,
      'SELECT session_id, pre_auth_id, ticket_sha256 FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?',
      [issuer, jtiHash],
    );
    assert.equal(persistedTicket.length, 1, 'one JTI row records the committed exchange');
    assert.equal(persistedTicket[0]?.session_id, attemptA.sessionRef);
    assert.equal(persistedTicket[0]?.ticket_sha256, createHash('sha256').update(ticket, 'utf8').digest('hex'));
    assert.notEqual(persistedTicket[0]?.ticket_sha256, ticket, 'the compact ticket itself is never stored');

    const sessionSecret = sessionCookieValue(responseA.cookies);
    assert.ok(sessionSecret);
    const idleBeforeRetry = await queryRows<{ idle_expires_at: string; last_seen_at: string }>(admin,
      'SELECT idle_expires_at, last_seen_at FROM ca_meta_portal_sessions WHERE id = ?', [attemptA.sessionRef],
    );
    const recoveredResponse = captureResponse();
    const recovered = await exchangeA.exchange(value, exchangeContext(started.cookieValue, sessionSecret), recoveredResponse.response);
    assert.equal(recovered.sessionRef, attemptA.sessionRef, 'an exact response-loss retry returns the same session');
    assert.equal(sessionCookie(recoveredResponse.cookies), sessionCookie(responseA.cookies));
    assert.deepEqual(await queryRows<{ idle_expires_at: string; last_seen_at: string }>(admin,
      'SELECT idle_expires_at, last_seen_at FROM ca_meta_portal_sessions WHERE id = ?', [attemptA.sessionRef],
    ), idleBeforeRetry, 'a recovery retry does not touch or extend the session idle expiry');
    assert.deepEqual(await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_sessions WHERE principal_id = ? AND tenant_id = ? AND revoked_at IS NULL',
      [principalId, tenantId],
    ), [{ id: attemptA.sessionRef }], 'an exact retry creates no additional session');

    const originalClaims = JSON.parse(Buffer.from(ticket.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const changedTicket = makeTicket(tenantId, subject, started.challengeRef, jti, {
      ...originalClaims,
      session_iss: 'different-session-issuer-still-within-profile',
    });
    assert.notEqual(changedTicket, ticket);
    const changedClaims = JSON.parse(Buffer.from(changedTicket.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const claim of ['iss', 'sub', 'tenant', 'jti', 'preauth_challenge', 'iat', 'exp']) {
      assert.equal(changedClaims[claim], originalClaims[claim], `${claim} remains the same on the different compact ticket`);
    }
    assert.notEqual(changedClaims.session_iss, originalClaims.session_iss);
    const changedTicketResponse = captureResponse();
    await assert.rejects(
      exchangeA.exchange({ ticket: changedTicket, challengeRef: started.challengeRef },
        exchangeContext(started.cookieValue, sessionSecret), changedTicketResponse.response),
      UnauthorizedException,
    );
    assert.equal(changedTicketResponse.cookies.length, 0, 'a different signed ticket reusing the same JTI and browser binding cannot recover');
    assert.deepEqual(await queryRows<{ ticket_sha256: string | null }>(admin,
      'SELECT ticket_sha256 FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?', [issuer, jtiHash],
    ), [{ ticket_sha256: createHash('sha256').update(ticket, 'utf8').digest('hex') }], 'the original ticket digest remains authoritative');
    assert.deepEqual(await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_sessions WHERE principal_id = ? AND tenant_id = ? AND revoked_at IS NULL',
      [principalId, tenantId],
    ), [{ id: attemptA.sessionRef }], 'the different compact ticket creates no session');

    await admin.query(
      'UPDATE ca_meta_portal_sessions SET idle_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE id = ?',
      [attemptA.sessionRef],
    );
    const expiredRetryResponse = captureResponse();
    await assert.rejects(
      exchangeA.exchange(value, exchangeContext(started.cookieValue), expiredRetryResponse.response),
      UnauthorizedException,
    );
    assert.equal(expiredRetryResponse.cookies.length, 0, 'an exact retry cannot recover an expired session');

    const wrongBrowserResponse = captureResponse();
    await assert.rejects(
      exchangeA.exchange(value, exchangeContext('w'.repeat(43)), wrongBrowserResponse.response),
      UnauthorizedException,
    );
    assert.equal(wrongBrowserResponse.cookies.length, 0, 'a different browser binding cannot recover the session');
    const unchangedSessions = await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_sessions WHERE principal_id = ? AND tenant_id = ? AND revoked_at IS NULL',
      [principalId, tenantId],
    );
    assert.deepEqual(unchangedSessions, [{ id: attemptA.sessionRef }]);

    const revokedStart = await sessionsA.begin();
    const revokedChallengeHash = createHash('sha256').update(revokedStart.challengeRef, 'utf8').digest('hex');
    challengeHashes.push(revokedChallengeHash);
    const revokedJti = randomUUID();
    const revokedJtiHash = createHash('sha256').update(issuer, 'utf8').update('\0').update(revokedJti, 'utf8').digest('hex');
    jtiHashes.push(revokedJtiHash);
    const revokedTicket = makeTicket(tenantId, subject, revokedStart.challengeRef, revokedJti);
    await admin.query(
      `UPDATE ca_meta_memberships SET status = 'REVOKED', revoked_at = UTC_TIMESTAMP(6)
       WHERE tenant_id = ? AND principal_id = ?`,
      [tenantId, principalId],
    );
    const revokedReplayResponse = captureResponse();
    await assert.rejects(
      exchangeA.exchange(value, exchangeContext(started.cookieValue), revokedReplayResponse.response),
      UnauthorizedException,
    );
    assert.equal(revokedReplayResponse.cookies.length, 0, 'an exact retry cannot recover after membership revocation');
    const revokedResponse = captureResponse();
    await assert.rejects(
      exchangeA.exchange(
        { ticket: revokedTicket, challengeRef: revokedStart.challengeRef },
        exchangeContext(revokedStart.cookieValue),
        revokedResponse.response,
      ),
      UnauthorizedException,
    );
    assert.equal(revokedResponse.cookies.length, 0, 'a still-live ticket cannot create a session after membership revocation');
    assert.deepEqual(await queryRows<{ session_id: string }>(admin,
      'SELECT session_id FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?',
      [issuer, revokedJtiHash],
    ), [], 'the rejected ticket does not consume a JTI');
    assert.deepEqual(await queryRows<{ consumed_at: string | null }>(admin,
      'SELECT consumed_at FROM ca_meta_portal_pre_auth WHERE challenge_hash = ?',
      [revokedChallengeHash],
    ), [{ consumed_at: null }], 'the rejected ticket does not consume its pre-auth challenge');
    assert.deepEqual(await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_sessions WHERE principal_id = ? AND tenant_id = ? AND revoked_at IS NULL',
      [principalId, tenantId],
    ), [{ id: attemptA.sessionRef }], 'revocation creates no additional session');

    const beforeCutoffJti = await queryRows<{ jti_hash: string }>(admin,
      'SELECT jti_hash FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?',
      [issuer, jtiHash],
    );
    const beforeCutoffPreAuth = await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_pre_auth WHERE challenge_hash = ?', [challengeHash],
    );
    assert.equal(beforeCutoffJti.length, 1, 'the active ticket tombstone exists before its cutoff');
    assert.equal(beforeCutoffPreAuth.length, 1);
    await storeA.purgeExpiredRecords();
    assert.equal((await queryRows<{ jti_hash: string }>(admin,
      'SELECT jti_hash FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?',
      [issuer, jtiHash],
    )).length, 1, 'cleanup keeps the active ticket tombstone');
    assert.equal((await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_pre_auth WHERE challenge_hash = ?', [challengeHash],
    )).length, 1, 'cleanup keeps its active pre-auth row');

    const originalPreAuth = await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_pre_auth WHERE challenge_hash = ?', [challengeHash],
    );
    assert.equal(originalPreAuth.length, 1);
    await admin.query(
      'UPDATE ca_meta_portal_ticket_jtis SET ticket_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE issuer = ? AND jti_hash = ?',
      [issuer, jtiHash],
    );
    await admin.query(
      `UPDATE ca_meta_portal_pre_auth
       SET created_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 10 SECOND),
           expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE id = ?`,
      [originalPreAuth[0]?.id],
    );
    const [purgeA, purgeB] = await Promise.all([storeA.purgeExpiredRecords(), storeA.purgeExpiredRecords()]);
    assert.deepEqual(purgeA, purgeB, 'concurrent maintenance calls share one bounded purge batch');
    assert.ok(purgeA.ticketJtisDeleted >= 1);
    assert.ok(purgeA.preAuthDeleted >= 1, 'expired pre-auth is removed after its JTI child');
    assert.equal((await queryRows<{ jti_hash: string }>(admin,
      'SELECT jti_hash FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?',
      [issuer, jtiHash],
    )).length, 0);
    assert.equal((await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_pre_auth WHERE challenge_hash = ?', [challengeHash],
    )).length, 0);
    assert.deepEqual(await queryRows<{ id: string }>(admin,
      'SELECT id FROM ca_meta_portal_sessions WHERE id = ?', [attemptA.sessionRef],
    ), [{ id: attemptA.sessionRef }], 'expiry cleanup leaves the portal session untouched');
  } finally {
    const poolShutdowns = await Promise.allSettled([
      storeA.onApplicationShutdown(), storeB.onApplicationShutdown(),
      identityA.onApplicationShutdown(), identityB.onApplicationShutdown(),
    ]);
    try {
      for (const jtiHash of jtiHashes) {
        await admin.query('DELETE FROM ca_meta_portal_ticket_jtis WHERE issuer = ? AND jti_hash = ?', [issuer, jtiHash]);
      }
      await admin.query('DELETE FROM ca_meta_portal_sessions WHERE principal_id = ? AND tenant_id = ?', [principalId, tenantId]);
      for (const challengeHash of challengeHashes) {
        await admin.query('DELETE FROM ca_meta_portal_pre_auth WHERE challenge_hash = ?', [challengeHash]);
      }
      await admin.query('DELETE FROM ca_meta_memberships WHERE tenant_id = ? AND principal_id = ?', [tenantId, principalId]);
      await admin.query('DELETE FROM ca_meta_principals WHERE id = ?', [principalId]);
      await admin.query('DELETE FROM ca_meta_tenants WHERE id = ?', [tenantId]);
    } finally {
      await admin.end();
    }
    const shutdownFailure = poolShutdowns.find((result) => result.status === 'rejected');
    if (shutdownFailure?.status === 'rejected') throw shutdownFailure.reason;
  }
});
