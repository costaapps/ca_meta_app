import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ApiModule } from '../src/app.module.js';
import { AbuseLimitService, type AbuseLimitDimensions, type AbuseLimitPolicy } from '../src/common/security/abuse-limits.js';
import { STRUCTURED_LOGGER, type StructuredLogRecord, type StructuredLogger } from '../src/common/http/request-context.js';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../src/database/database-readiness.port.js';
import { PortalSessionVerifier } from '../src/identity/identity.trust.js';
import type { VerifiedIdentityAssertion } from '../src/identity/identity.trust.js';
import { PORTAL_CSRF_COOKIE, PORTAL_SESSION_COOKIE, PortalPreAuthService, PortalSessionIssuer, type IssuedPortalSession, type PortalSessionIssueOptions, type StartedPortalPreAuth, type VerifiedPortalPreAuth } from '../src/identity/portal-session.service.js';
import { CLOCK, type MonotonicClock } from '../src/common/time/clock.port.js';
import { GracefulExpressAdapter } from '../src/http/graceful-express-adapter.js';
import { configureHttpBoundaries } from '../src/http-boundaries.js';
import { validateEnvironment } from '../src/config/environment.js';

const ISSUER = 'https://suite4.synthetic.invalid/portal';
const AUDIENCE = 'https://portal.synthetic.invalid';
const markerCookie = 'synthetic-preauth-cookie-never-in-json';
const activeSessionCookie = 'synthetic-active-session-cookie-value-12345678901234567890';
const activeCsrfToken = 'synthetic-active-csrf-token-value-12345678901234567890';
const verifiedPreAuth = Object.freeze({}) as VerifiedPortalPreAuth;

class CapturingLogger implements StructuredLogger {
  readonly records: StructuredLogRecord[] = [];
  write(record: StructuredLogRecord): void { this.records.push(record); }
}

class FakeReadiness implements DatabaseReadinessPort {
  async check(): Promise<void> {}
}

class FixedClock implements MonotonicClock {
  now(): number { return 1; }
}

class FakeAbuseLimits extends AbuseLimitService {
  readonly calls: { policy: AbuseLimitPolicy; dimensions: AbuseLimitDimensions }[] = [];
  rateLimitPreAuth = false;
  rateLimitExchangeAttempt = false;
  rateLimitExchange = false;
  async consume(policy: AbuseLimitPolicy, dimensions: AbuseLimitDimensions): Promise<void> {
    this.calls.push({ policy, dimensions });
    if (policy === 'PORTAL_EXCHANGE_ATTEMPT' && this.rateLimitExchangeAttempt) throw Object.freeze({ code: 'RATE_LIMITED', detail: 'synthetic private limiter detail' });
    if (policy === 'PORTAL_EXCHANGE' && this.rateLimitExchange) throw Object.freeze({ code: 'RATE_LIMITED', detail: 'synthetic private limiter detail' });
    if (policy === 'PORTAL_PREAUTH' && this.rateLimitPreAuth) throw Object.freeze({ code: 'RATE_LIMITED' });
  }
}

class FakePreAuth extends PortalPreAuthService {
  beginCalls = 0;
  verifyCalls = 0;
  async begin(entryMode: 'PORTAL_TOP_LEVEL' | 'SUITE4_EMBED' = 'PORTAL_TOP_LEVEL'): Promise<StartedPortalPreAuth> {
    this.beginCalls += 1;
    return Object.freeze({
      challengeRef: 'synthetic-browser-challenge-1234',
      cookieValue: markerCookie,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      entryMode,
    });
  }
  async verifyBrowserBinding(): Promise<VerifiedPortalPreAuth | undefined> {
    this.verifyCalls += 1;
    return verifiedPreAuth;
  }
}

class FakeSessionIssuer extends PortalSessionIssuer {
  issueCalls = 0;
  readonly issueOptions: PortalSessionIssueOptions[] = [];
  issueResult: IssuedPortalSession | undefined;
  async issueFromVerifiedAssertion(
    _assertion: VerifiedIdentityAssertion,
    _requestedTenantId: string,
    options: PortalSessionIssueOptions,
  ): Promise<IssuedPortalSession> {
    this.issueCalls += 1;
    this.issueOptions.push(options);
    if (this.issueResult) return this.issueResult;
    throw new Error('Session issuance must not run in this test.');
  }
}

async function findLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function ticketFor(privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-active', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: AUDIENCE,
    purpose: 'META_PORTAL_ENTRY',
    ver: 1,
    sub: 'synthetic-subject',
    tenant: 'synthetic-tenant',
    session_iss: 'synthetic-session-authority-01',
    roles: ['viewer'],
    jti: 'synthetic-one-use-jti',
    iat: now,
    exp: now + 30,
    preauth_challenge: 'synthetic-browser-challenge-1234',
  })).toString('base64url');
  const signingInput = `${header}.${claims}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url')}`;
}

async function startApp(portalTicketEnabled: boolean, embedAllowed = false): Promise<{
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly origin: string;
  readonly privateKey: KeyObject;
  readonly abuseLimits: FakeAbuseLimits;
  readonly preAuth: FakePreAuth;
  readonly sessionIssuer: FakeSessionIssuer;
  readonly sessionVerifierCalls: { readonly cookieValue: string | undefined; readonly touchLastSeen: boolean | undefined }[];
  readonly sessionActivity: { idleExpiresAt: string; lastSeenAt: string };
  readonly logger: CapturingLogger;
}> {
  const port = await findLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    API_PORT: String(port),
    API_BIND_ADDRESS: '127.0.0.1',
    API_ALLOWED_HOSTS: '127.0.0.1,localhost',
    API_ALLOWED_ORIGINS: origin,
    API_TRUSTED_PROXIES: 'none',
    API_DATABASE_HOST: '127.0.0.1',
    API_DATABASE_PORT: '3306',
    API_DATABASE_NAME: 'synthetic_test',
    API_DATABASE_USER: 'synthetic_user',
    API_DATABASE_PASSWORD: 'synthetic-password-value',
    API_DATABASE_CONNECT_TIMEOUT_MS: '250',
    API_PORTAL_SESSION_RECOVERY_KEY: 'synthetic-test-session-recovery-key-32-bytes-minimum',
    ...(embedAllowed ? { API_SUITE4_EMBED_ORIGINS: 'https://suite4.synthetic.invalid' } : {}),
    ...(portalTicketEnabled ? {
      API_PORTAL_ENTRY_TICKET_ISSUER: ISSUER,
      API_PORTAL_ENTRY_TICKET_AUDIENCE: AUDIENCE,
      API_PORTAL_ENTRY_TICKET_PUBLIC_KEYS_JSON: JSON.stringify([{
        kid: 'test-active',
        publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }]),
    } : {}),
  });

  const abuseLimits = new FakeAbuseLimits();
  const preAuth = new FakePreAuth();
  const sessionIssuer = new FakeSessionIssuer();
  const sessionVerifierCalls: { cookieValue: string | undefined; touchLastSeen: boolean | undefined }[] = [];
  const sessionActivity = {
    idleExpiresAt: '2028-05-01T12:30:00.000Z',
    lastSeenAt: '2028-05-01T12:00:00.000Z',
  };
  const sessionVerifier = {
    async verify(cookieValue: string | undefined, options?: { readonly touchLastSeen?: boolean }) {
      sessionVerifierCalls.push({ cookieValue, touchLastSeen: options?.touchLastSeen });
      if (cookieValue !== activeSessionCookie) return undefined;
      if (options?.touchLastSeen !== false) {
        sessionActivity.lastSeenAt = new Date().toISOString();
        sessionActivity.idleExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      }
      return {
        sessionId: 'a406aaf4-837a-45d7-9f93-4db17920668d',
        principalId: 'synthetic-principal-id',
        tenantId: 'synthetic-tenant',
        contextVersion: 1,
        contextRefHash: 'd'.repeat(64),
        csrfTokenHash: createHash('sha256').update(activeCsrfToken, 'utf8').digest('hex'),
      };
    },
  };
  const logger = new CapturingLogger();
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule.register(environment)] })
    .overrideProvider(DATABASE_READINESS_PORT).useValue(new FakeReadiness())
    .overrideProvider(STRUCTURED_LOGGER).useValue(logger)
    .overrideProvider(CLOCK).useValue(new FixedClock())
    .overrideProvider(PortalPreAuthService).useValue(preAuth)
    .overrideProvider(AbuseLimitService).useValue(abuseLimits)
    .overrideProvider(PortalSessionIssuer).useValue(sessionIssuer)
    .overrideProvider(PortalSessionVerifier).useValue(sessionVerifier)
    .compile();

  const app = moduleRef.createNestApplication(new GracefulExpressAdapter(), { bodyParser: false });
  configureHttpBoundaries(app, environment);
  await app.init();
  await app.listen(port, '127.0.0.1');
  return {
    app, baseUrl: `http://127.0.0.1:${port}`, origin, privateKey: keyPair.privateKey,
    abuseLimits, preAuth, sessionIssuer, sessionVerifierCalls, sessionActivity, logger,
  };
}

function sameOriginHeaders(origin: string): Record<string, string> {
  return { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' };
}

test('runtime preauth keeps top-level cookies and allows partitioned embed preauth only for configured Suite4 origins', async (t) => {
  const context = await startApp(true, true);
  t.after(() => context.app.close());

  const started = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'PORTAL_TOP_LEVEL', returnRoute: 'connections' }),
  });
  assert.equal(started.status, 201);
  const cookie = started.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^__Host-meta_preauth=/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  const startBody = await started.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(startBody).sort(), ['challengeRef', 'expiresAt', 'requestId']);
  assert.equal(JSON.stringify(startBody).includes(markerCookie), false);
  assert.equal(context.preAuth.beginCalls, 1);
  assert.equal(context.abuseLimits.calls[0]?.policy, 'PORTAL_PREAUTH');

  const embed = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'SUITE4_EMBED', returnRoute: 'connections' }),
  });
  assert.equal(embed.status, 201);
  assert.match(embed.headers.get('set-cookie') ?? '', /; SameSite=None; Partitioned/);
  assert.equal(context.preAuth.beginCalls, 2);

  const parentOriginAsRequestOrigin = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: { ...sameOriginHeaders(context.origin), origin: 'https://suite4.synthetic.invalid' },
    body: JSON.stringify({ entryMode: 'SUITE4_EMBED', returnRoute: 'connections' }),
  });
  assert.equal(parentOriginAsRequestOrigin.status, 403);
  assert.equal(parentOriginAsRequestOrigin.headers.get('set-cookie'), null);
  assert.equal(context.preAuth.beginCalls, 2);

  context.abuseLimits.rateLimitPreAuth = true;
  const preauthLimited = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'PORTAL_TOP_LEVEL', returnRoute: 'setup' }),
  });
  assert.equal(preauthLimited.status, 429);
  assert.equal(preauthLimited.headers.get('retry-after'), '60');
  assert.equal(preauthLimited.headers.get('set-cookie'), null);
  assert.equal(context.preAuth.beginCalls, 2);
  context.abuseLimits.rateLimitPreAuth = false;

  context.abuseLimits.rateLimitExchangeAttempt = true;
  const attemptLimited = await fetch(`${context.baseUrl}/api/v1/auth/exchanges`, {
    method: 'POST',
    headers: {
      ...sameOriginHeaders(context.origin),
      cookie: '__Host-meta_preauth=synthetic-browser-cookie-value-12345678901234567890',
    },
    body: JSON.stringify({ ticket: 'synthetic-not-a-valid-ticket', challengeRef: 'synthetic-browser-challenge-1234' }),
  });
  const attemptError = await attemptLimited.json();
  assert.equal(attemptLimited.status, 429, `unexpected exchange rate-limit response: ${JSON.stringify(attemptError)}`);
  assert.equal(attemptLimited.headers.get('retry-after'), '60');
  assert.equal(attemptLimited.headers.get('set-cookie'), null);
  assert.deepEqual(attemptError, {
    code: 'RATE_LIMITED',
    safeMessage: 'Too many requests. Try again later.',
    requestId: attemptLimited.headers.get('x-request-id'),
    retryable: true,
    action: 'WAIT',
  });
  assert.equal(context.preAuth.verifyCalls, 0);
  assert.equal(context.sessionIssuer.issueCalls, 0);
  context.abuseLimits.rateLimitExchangeAttempt = false;
  context.abuseLimits.rateLimitExchange = true;

  const signedTicket = ticketFor(context.privateKey);
  const exchange = await fetch(`${context.baseUrl}/api/v1/auth/exchanges`, {
    method: 'POST',
    headers: {
      ...sameOriginHeaders(context.origin),
      cookie: '__Host-meta_preauth=synthetic-browser-cookie-value-12345678901234567890',
    },
    body: JSON.stringify({ ticket: signedTicket, challengeRef: 'synthetic-browser-challenge-1234' }),
  });
  assert.equal(exchange.status, 429);
  assert.equal(exchange.headers.get('retry-after'), '60');
  assert.equal(exchange.headers.get('set-cookie'), null);
  const error = await exchange.json() as Record<string, unknown>;
  assert.deepEqual(error, {
    code: 'RATE_LIMITED',
    safeMessage: 'Too many requests. Try again later.',
    requestId: exchange.headers.get('x-request-id'),
    retryable: true,
    action: 'WAIT',
  });
  assert.equal(JSON.stringify(error).includes('synthetic private limiter detail'), false);
  assert.equal(context.sessionIssuer.issueCalls, 0);
  assert.equal(context.preAuth.verifyCalls, 0);
  assert.deepEqual(context.abuseLimits.calls.map(({ policy }) => policy), [
    'PORTAL_PREAUTH', 'PORTAL_PREAUTH', 'PORTAL_EXCHANGE_ATTEMPT', 'PORTAL_EXCHANGE_ATTEMPT', 'PORTAL_EXCHANGE',
  ]);
  assert.deepEqual(context.abuseLimits.calls[2]?.dimensions, { ip: '127.0.0.1' });
  assert.deepEqual(context.abuseLimits.calls[4]?.dimensions, { ip: '127.0.0.1', actor: `${ISSUER}\0synthetic-subject` });
  assert.equal(JSON.stringify(context.logger.records).includes(signedTicket), false);
});

test('embed preauth fails closed when no exact Suite4 parent origin is configured', async (t) => {
  const context = await startApp(true);
  t.after(async () => context.app.close());
  const response = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'SUITE4_EMBED', returnRoute: 'connections' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(context.preAuth.beginCalls, 0);
});

test('ticket exchange aliases and rejected query strings do not touch active session idle activity', async (t) => {
  const context = await startApp(true);
  t.after(async () => context.app.close());
  const sessionRef = 'a406aaf4-837a-45d7-9f93-4db17920668d';
  const contextRef = 'synthetic-next-context-reference';
  context.sessionIssuer.issueResult = {
    sessionId: sessionRef,
    sessionCookie: 'synthetic-rotated-session-cookie-value-12345678901234567890',
    csrfToken: 'synthetic-rotated-csrf-token-value-12345678901234567890',
    contextRef,
    tenantId: 'synthetic-tenant',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    publicContext: {
      sessionRef,
      principalRef: 'synthetic-principal-reference',
      roles: ['viewer'],
      tenantRef: 'synthetic-tenant',
      tenantContextRef: contextRef,
      contextVersion: 1,
    },
  };
  const before = { ...context.sessionActivity };
  const signedTicket = ticketFor(context.privateKey);
  const retryHeaders = {
    ...sameOriginHeaders(context.origin),
    cookie: `__Host-meta_preauth=${markerCookie}; ${PORTAL_SESSION_COOKIE}=${activeSessionCookie}; ${PORTAL_CSRF_COOKIE}=${activeCsrfToken}`,
    'x-csrf-token': activeCsrfToken,
  };
  const response = await fetch(`${context.baseUrl}/API/V1/Auth/Exchanges/`, {
    method: 'POST',
    headers: retryHeaders,
    body: JSON.stringify({ ticket: signedTicket, challengeRef: 'synthetic-browser-challenge-1234' }),
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json() as { sessionRef: string }).sessionRef, sessionRef);
  assert.ok(response.headers.get('set-cookie')?.includes(`${PORTAL_SESSION_COOKIE}=`));
  assert.equal(context.preAuth.verifyCalls, 1);
  assert.equal(context.sessionIssuer.issueCalls, 1);
  assert.equal(context.sessionIssuer.issueOptions[0]?.ticketSha256,
    createHash('sha256').update(signedTicket, 'utf8').digest('hex'), 'the retry reaches issuance with the exact compact ticket digest');

  const queryResponse = await fetch(`${context.baseUrl}/api/v1/auth/exchanges?unexpected=1`, {
    method: 'POST',
    headers: retryHeaders,
    body: JSON.stringify({ ticket: signedTicket, challengeRef: 'synthetic-browser-challenge-1234' }),
  });
  assert.equal(queryResponse.status, 400, 'the controller still rejects query strings');
  assert.equal(queryResponse.headers.get('set-cookie'), null);
  assert.deepEqual(context.sessionVerifierCalls, [
    { cookieValue: activeSessionCookie, touchLastSeen: false },
    { cookieValue: activeSessionCookie, touchLastSeen: false },
    { cookieValue: activeSessionCookie, touchLastSeen: false },
  ], 'the middleware and exchange service verify router-equivalent paths without touching activity');
  assert.deepEqual(context.sessionActivity, before, 'idle_expires_at and last_seen_at remain unchanged');
});

test('without issuer/key configuration, preauth remains available and ticket exchange fails closed', async (t) => {
  const context = await startApp(false);
  t.after(() => context.app.close());

  const exchange = await fetch(`${context.baseUrl}/api/v1/auth/exchanges`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ ticket: 'synthetic-ticket-value', challengeRef: 'synthetic-challenge-value' }),
  });
  assert.equal(exchange.status, 503);
  assert.equal(exchange.headers.get('set-cookie'), null);
  assert.deepEqual(await exchange.json(), {
    code: 'DEPENDENCY_UNAVAILABLE',
    safeMessage: 'The operation could not be confirmed yet.',
    requestId: exchange.headers.get('x-request-id'),
    retryable: true,
    action: 'CHECK_STATUS',
  });

  const preauth = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'PORTAL_TOP_LEVEL', returnRoute: 'setup' }),
  });
  assert.equal(preauth.status, 201);
  assert.equal(context.preAuth.beginCalls, 1);
});
