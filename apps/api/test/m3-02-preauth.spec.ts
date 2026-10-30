import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
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
import { PortalPreAuthService, PortalSessionIssuer, type IssuedPortalSession, type PortalSessionIssueOptions, type StartedPortalPreAuth, type VerifiedPortalPreAuth } from '../src/identity/portal-session.service.js';
import { CLOCK, type MonotonicClock } from '../src/common/time/clock.port.js';
import { GracefulExpressAdapter } from '../src/http/graceful-express-adapter.js';
import { configureHttpBoundaries } from '../src/http-boundaries.js';
import { validateEnvironment } from '../src/config/environment.js';

const ISSUER = 'https://suite4.synthetic.invalid/portal';
const AUDIENCE = 'https://portal.synthetic.invalid';
const markerCookie = 'synthetic-preauth-cookie-never-in-json';

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
  async consume(policy: AbuseLimitPolicy, dimensions: AbuseLimitDimensions): Promise<void> {
    this.calls.push({ policy, dimensions });
    if (policy === 'PORTAL_EXCHANGE') throw Object.freeze({ code: 'RATE_LIMITED', detail: 'synthetic private limiter detail' });
    if (policy === 'PORTAL_PREAUTH' && this.rateLimitPreAuth) throw Object.freeze({ code: 'RATE_LIMITED' });
  }
}

class FakePreAuth extends PortalPreAuthService {
  beginCalls = 0;
  async begin(): Promise<StartedPortalPreAuth> {
    this.beginCalls += 1;
    return Object.freeze({
      challengeRef: 'synthetic-browser-challenge-123',
      cookieValue: markerCookie,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      entryMode: 'PORTAL_TOP_LEVEL',
    });
  }
  async verifyBrowserBinding(): Promise<VerifiedPortalPreAuth | undefined> { return undefined; }
}

class FakeSessionIssuer extends PortalSessionIssuer {
  issueCalls = 0;
  async issueFromVerifiedAssertion(
    _assertion: VerifiedIdentityAssertion,
    _requestedTenantId: string,
    _options: PortalSessionIssueOptions,
  ): Promise<IssuedPortalSession> {
    this.issueCalls += 1;
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
    sub: 'synthetic-subject',
    tenant: 'synthetic-tenant',
    roles: ['viewer'],
    jti: 'synthetic-one-use-jti',
    iat: now,
    exp: now + 30,
    preauth_challenge: 'synthetic-browser-challenge-123',
  })).toString('base64url');
  const signingInput = `${header}.${claims}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url')}`;
}

async function startApp(portalTicketEnabled: boolean): Promise<{
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly origin: string;
  readonly privateKey: KeyObject;
  readonly abuseLimits: FakeAbuseLimits;
  readonly preAuth: FakePreAuth;
  readonly sessionIssuer: FakeSessionIssuer;
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
  const logger = new CapturingLogger();
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule.register(environment)] })
    .overrideProvider(DATABASE_READINESS_PORT).useValue(new FakeReadiness())
    .overrideProvider(STRUCTURED_LOGGER).useValue(logger)
    .overrideProvider(CLOCK).useValue(new FixedClock())
    .overrideProvider(PortalPreAuthService).useValue(preAuth)
    .overrideProvider(AbuseLimitService).useValue(abuseLimits)
    .overrideProvider(PortalSessionIssuer).useValue(sessionIssuer)
    .overrideProvider(PortalSessionVerifier).useValue({ verify: async () => undefined })
    .compile();

  const app = moduleRef.createNestApplication(new GracefulExpressAdapter(), { bodyParser: false });
  configureHttpBoundaries(app, environment);
  await app.init();
  await app.listen(port, '127.0.0.1');
  return { app, baseUrl: `http://127.0.0.1:${port}`, origin, privateKey: keyPair.privateKey, abuseLimits, preAuth, sessionIssuer, logger };
}

function sameOriginHeaders(origin: string): Record<string, string> {
  return { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' };
}

test('runtime preauth is top-level only; exchange rate limit returns the safe HTTP envelope without issuing a session', async (t) => {
  const context = await startApp(true);
  t.after(() => context.app.close());

  const started = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'PORTAL_TOP_LEVEL', returnRoute: 'connections' }),
  });
  assert.equal(started.status, 201);
  const cookie = started.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^__Host-ca_meta_pre_auth=/);
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
  assert.equal(embed.status, 400);
  assert.equal(embed.headers.get('set-cookie'), null);
  assert.equal(context.preAuth.beginCalls, 1);

  context.abuseLimits.rateLimitPreAuth = true;
  const preauthLimited = await fetch(`${context.baseUrl}/api/v1/auth/preauth`, {
    method: 'POST',
    headers: sameOriginHeaders(context.origin),
    body: JSON.stringify({ entryMode: 'PORTAL_TOP_LEVEL', returnRoute: 'setup' }),
  });
  assert.equal(preauthLimited.status, 429);
  assert.equal(preauthLimited.headers.get('retry-after'), '60');
  assert.equal(preauthLimited.headers.get('set-cookie'), null);
  assert.equal(context.preAuth.beginCalls, 1);
  context.abuseLimits.rateLimitPreAuth = false;

  const signedTicket = ticketFor(context.privateKey);
  const exchange = await fetch(`${context.baseUrl}/api/v1/auth/exchanges`, {
    method: 'POST',
    headers: {
      ...sameOriginHeaders(context.origin),
      cookie: '__Host-ca_meta_pre_auth=synthetic-browser-cookie-value-12345678901234567890',
    },
    body: JSON.stringify({ ticket: signedTicket, challengeRef: 'synthetic-browser-challenge-123' }),
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
  assert.deepEqual(context.abuseLimits.calls.map(({ policy }) => policy), ['PORTAL_PREAUTH', 'PORTAL_PREAUTH', 'PORTAL_EXCHANGE']);
  assert.equal(JSON.stringify(context.logger.records).includes(signedTicket), false);
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
