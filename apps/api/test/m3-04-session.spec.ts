import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { test } from 'node:test';
import { portalRequestSecurityMiddleware } from '../src/common/security/portal-request-security.js';
import { SafeExceptionFilter } from '../src/common/http/safe-exception.filter.js';
import type { StructuredLogger } from '../src/common/http/request-context.js';
import { validateEnvironment, type ApiEnvironment } from '../src/config/environment.js';
import { AbuseLimitService, type AbuseLimitDimensions, type AbuseLimitPolicy } from '../src/common/security/abuse-limits.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { TenantContextService } from '../src/identity/identity.service.js';
import { PortalSessionController } from '../src/identity/portal-session.controller.js';
import { PortalSessionsController } from '../src/identity/portal-sessions.controller.js';
import { PortalSessionGuard, type PortalRequest } from '../src/identity/portal-session.guard.js';
import { IdentityAssertionVerifier, PortalSessionVerifier } from '../src/identity/identity.trust.js';
import type { StoredPortalSession, VerifiedPortalSession } from '../src/identity/identity.trust.js';
import type { MembershipRole, TenantMembership } from '../src/identity/identity.types.js';
import {
  MysqlPortalSessionService,
  PORTAL_CONTEXT_COOKIE,
  PORTAL_CSRF_COOKIE,
  PORTAL_SESSION_COOKIE,
  setPortalSessionCookies,
  type PortalPreAuthRecord,
  type PortalSessionIssueRecord,
  type PortalSessionRecord,
  type PortalSessionStore,
  type VerifiedPortalPreAuth,
} from '../src/identity/portal-session.service.js';

const tenantA = 'tenant-a';
const tenantB = 'tenant-b';
const principalId = 'principal-1';
const recoveryKey = randomBytes(32).toString('base64url');

function membership(tenantId: string, roles: readonly MembershipRole[] = ['operator']): TenantMembership {
  return {
    tenantId,
    principalId,
    principalKind: 'USER',
    principalStatus: 'ACTIVE',
    tenantStatus: 'ACTIVE',
    roles,
    status: 'ACTIVE',
    version: 1,
  };
}

class TestIdentityRepository implements IdentityRepository {
  findPrincipalByIssuerSubject(issuer: string, subject: string) {
    return Promise.resolve(issuer === 'https://issuer.example' && subject === 'person-1'
      ? { id: principalId, kind: 'USER' as const, issuer, subject, status: 'ACTIVE' as const, version: 1 }
      : undefined);
  }
  findMembership(_principal: string, tenantId: string) {
    return Promise.resolve(tenantId === tenantA ? membership(tenantA) : tenantId === tenantB ? membership(tenantB, ['viewer']) : undefined);
  }
  listActiveMemberships() { return Promise.resolve([membership(tenantA), membership(tenantB, ['viewer'])]); }
  findServiceTenantGrant() { return Promise.resolve(undefined); }
  findLegacyTenantMapping() { return Promise.resolve(undefined); }
}

class SharedSessionStore implements PortalSessionStore {
  readonly preAuth = new Map<string, PortalPreAuthRecord>();
  readonly issuedByJti = new Map<string, PortalSessionRecord & { readonly jti: string; readonly preAuthId: string }>();
  readonly activeById = new Map<string, PortalSessionRecord>();
  readonly revoked = new Set<string>();
  rawCookiePassedToVerifier: boolean | undefined;
  issueCount = 0;
  lastSeenRefreshes = 0;

  async createPreAuth(input: Omit<PortalPreAuthRecord, 'consumedAt' | 'expiresAt'>): Promise<Date> {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    this.preAuth.set(input.id, { ...input, expiresAt });
    return expiresAt;
  }

  async findPreAuth(challengeHash: string, browserCookieHash: string): Promise<PortalPreAuthRecord | undefined> {
    return [...this.preAuth.values()].find((record) => record.challengeHash === challengeHash &&
      record.browserCookieHash === browserCookieHash && record.expiresAt.getTime() > Date.now());
  }

  async createOrRecoverSession(input: PortalSessionIssueRecord): Promise<PortalSessionRecord> {
    const existing = this.issuedByJti.get(input.ticketJtiSha256);
    if (existing) {
      assert.equal(existing.preAuthId, input.preAuth.id);
      assert.equal(existing.sessionCookie, input.sessionCookie);
      return existing;
    }
    const currentPreAuth = this.preAuth.get(input.preAuth.id);
    assert.ok(currentPreAuth && currentPreAuth.consumedAt === undefined);
    this.preAuth.set(input.preAuth.id, Object.freeze({ ...currentPreAuth, consumedAt: new Date() }));
    const record: PortalSessionRecord = Object.freeze({
      sessionId: input.sessionId,
      principalId,
      tenantId: input.requestedTenantId,
      contextVersion: 1,
      contextRefHash: input.contextRefHash,
      csrfTokenHash: input.csrfTokenHash,
      entryMode: input.preAuth.entryMode,
      roles: input.requestedTenantId === tenantA ? ['operator'] as const : ['viewer'] as const,
      sessionCookie: input.sessionCookie,
      csrfToken: input.csrfToken,
      contextRef: input.contextRef,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    });
    this.issueCount += 1;
    this.activeById.set(record.sessionId, record);
    this.issuedByJti.set(input.ticketJtiSha256, Object.freeze({ ...record, jti: input.ticketJtiSha256, preAuthId: input.preAuth.id }));
    if (input.priorSession) this.revoked.add(input.priorSession.sessionId);
    return record;
  }

  async findActiveBySecretHash(secretHash: Uint8Array, options?: { readonly touchLastSeen?: boolean }): Promise<StoredPortalSession | undefined> {
    if (options?.touchLastSeen !== false) this.lastSeenRefreshes += 1;
    const digest = Buffer.from(secretHash).toString('hex');
    const stored = [...this.activeById.values()].find((record) => hash(record.sessionCookie) === digest && !this.revoked.has(record.sessionId));
    this.rawCookiePassedToVerifier = false;
    return stored && {
      sessionId: stored.sessionId,
      principalId: stored.principalId,
      tenantId: stored.tenantId,
      contextVersion: stored.contextVersion,
      contextRefHash: stored.contextRefHash,
      csrfTokenHash: stored.csrfTokenHash,
      entryMode: stored.entryMode,
    };
  }

  async refreshActivity(session: VerifiedPortalSession): Promise<void> {
    const stored = this.activeById.get(session.sessionId);
    if (!stored || this.revoked.has(session.sessionId) || stored.contextVersion !== session.contextVersion ||
      stored.contextRefHash !== session.contextRefHash) throw new IdentityDeniedError('CONTEXT_CHANGED');
    this.lastSeenRefreshes += 1;
  }

  async changeContext(input: {
    readonly session: VerifiedPortalSession; readonly requestedTenantId: string; readonly contextRef: string;
    readonly contextRefHash: string; readonly csrfTokenHash: string;
  }): Promise<{ readonly contextVersion: number; readonly roles: readonly MembershipRole[]; readonly expiresAt: string }> {
    const stored = this.activeById.get(input.session.sessionId);
    if (!stored || this.revoked.has(stored.sessionId) || stored.contextVersion !== input.session.contextVersion ||
      stored.contextRefHash !== input.session.contextRefHash) throw new IdentityDeniedError('CONTEXT_CHANGED');
    const updated = Object.freeze({
      ...stored,
      tenantId: input.requestedTenantId,
      contextVersion: stored.contextVersion + 1,
      contextRefHash: input.contextRefHash,
      csrfTokenHash: input.csrfTokenHash,
      contextRef: input.contextRef,
      roles: input.requestedTenantId === tenantA ? ['operator'] as const : ['viewer'] as const,
    });
    this.activeById.set(stored.sessionId, updated);
    return { contextVersion: updated.contextVersion, roles: updated.roles, expiresAt: updated.expiresAt };
  }

  async revokeSession(sessionId: string): Promise<boolean> { this.revoked.add(sessionId); return true; }

  async revokeAuthorizedSession(actor: VerifiedPortalSession, targetSessionId: string): Promise<void> {
    const actorRecord = this.activeById.get(actor.sessionId);
    const target = this.activeById.get(targetSessionId);
    if (!actorRecord || this.revoked.has(actor.sessionId) || actorRecord.principalId !== actor.principalId ||
      actorRecord.tenantId !== actor.tenantId || actorRecord.contextVersion !== actor.contextVersion ||
      actorRecord.contextRefHash !== actor.contextRefHash) throw new IdentityDeniedError('CONTEXT_CHANGED');
    if (!target || target.principalId !== actor.principalId || target.tenantId !== actor.tenantId) throw new IdentityDeniedError();
    this.revoked.add(targetSessionId);
  }

  seedSession(record: PortalSessionRecord): void { this.activeById.set(record.sessionId, record); }
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function services(store: SharedSessionStore) {
  const contexts = new TenantContextService(new TestIdentityRepository());
  const sessions = new MysqlPortalSessionService(store, contexts, recoveryKey);
  const assertions = new class extends IdentityAssertionVerifier {
    verify() { return this.issueVerifiedAssertion('https://issuer.example', 'person-1'); }
  }();
  return { contexts, sessions, assertions };
}

test('pre-auth binding is browser-specific; exchange is recoverable only for the same binding and rotates the prior session across verifiers', async () => {
  const store = new SharedSessionStore();
  const { contexts, sessions, assertions } = services(store);
  const firstChallenge = await sessions.begin();
  assert.equal(await sessions.verifyBrowserBinding(firstChallenge.challengeRef, 'attacker-controlled-browser-cookie'), undefined);
  const preAuth = await sessions.verifyBrowserBinding(firstChallenge.challengeRef, firstChallenge.cookieValue);
  assert.ok(preAuth);
  const assertion = assertions.verify();
  const jti = hash('synthetic-ticket-jti-1');
  const challengeHash = hash(firstChallenge.challengeRef);
  const options = {
    ticketJtiSha256: jti,
    ticketSha256: hash('synthetic-compact-ticket-1'),
    ticketExpiresAt: new Date(Date.now() + 30_000),
    ticketChallengeSha256: challengeHash,
    preAuth,
  };
  const issued = await sessions.issueFromVerifiedAssertion(assertion, tenantA, options);
  const retry = await sessions.issueFromVerifiedAssertion(assertion, tenantA, options);
  assert.equal(retry.sessionId, issued.sessionId);
  assert.equal(retry.sessionCookie, issued.sessionCookie);
  assert.notEqual(issued.sessionCookie, firstChallenge.cookieValue);
  assert.equal(store.issueCount, 1);
  assert.deepEqual(issued.publicContext.roles, ['operator']);

  const verifierA = new PortalSessionVerifier(store);
  const verifierB = new PortalSessionVerifier(store);
  const existing = await verifierA.verify(issued.sessionCookie);
  assert.ok(existing);
  const nextChallenge = await sessions.begin();
  const nextPreAuth = await sessions.verifyBrowserBinding(nextChallenge.challengeRef, nextChallenge.cookieValue);
  assert.ok(nextPreAuth);
  const nextIssued = await sessions.issueFromVerifiedAssertion(assertion, tenantB, {
    ticketJtiSha256: hash('synthetic-ticket-jti-2'),
    ticketSha256: hash('synthetic-compact-ticket-2'),
    ticketExpiresAt: new Date(Date.now() + 30_000),
    ticketChallengeSha256: hash(nextChallenge.challengeRef),
    preAuth: nextPreAuth,
    priorSession: existing,
  });
  assert.equal(await verifierB.verify(issued.sessionCookie), undefined);
  assert.equal((await verifierA.verify(nextIssued.sessionCookie))?.tenantId, tenantB);
  assert.deepEqual(nextIssued.publicContext.roles, ['viewer']);

  const stale = await verifierB.verify(nextIssued.sessionCookie);
  assert.ok(stale);
  await sessions.rotateTenantContext(stale, nextIssued.contextRef, tenantA);
  const refreshed = await verifierA.verify(nextIssued.sessionCookie);
  assert.ok(refreshed);
  await assert.rejects(contexts.resolveCurrent(refreshed, nextIssued.contextRef), (error: unknown) =>
    error instanceof IdentityDeniedError && error.code === 'CONTEXT_CHANGED');
});

test('tenant-switch context cookies preserve the mode verified from the server-side session', async () => {
  for (const entryMode of ['PORTAL_TOP_LEVEL', 'SUITE4_EMBED'] as const) {
    const store = new SharedSessionStore();
    const { contexts, sessions, assertions } = services(store);
    const challenge = await sessions.begin(entryMode);
    const preAuth = await sessions.verifyBrowserBinding(challenge.challengeRef, challenge.cookieValue);
    assert.ok(preAuth);
    const issued = await sessions.issueFromVerifiedAssertion(assertions.verify(), tenantA, {
      ticketJtiSha256: hash(`tenant-switch-${entryMode}-jti`),
      ticketSha256: hash(`tenant-switch-${entryMode}-ticket`),
      ticketExpiresAt: new Date(Date.now() + 30_000),
      ticketChallengeSha256: hash(challenge.challengeRef),
      preAuth,
    });
    const verified = await new PortalSessionVerifier(store).verify(issued.sessionCookie);
    assert.ok(verified);
    assert.equal(verified.entryMode, entryMode);

    const controller = new PortalSessionController(
      contexts,
      sessions,
      new class extends AbuseLimitService { async consume() {} }(),
    );
    const cookies: string[] = [];
    const response = { append(_name: string, value: string) { cookies.push(value); } } as unknown as Response;
    await controller.switchTenant({
      portalSession: verified,
      headers: { 'x-entry-mode': 'PORTAL_TOP_LEVEL' },
    } as unknown as PortalRequest, { tenantRef: tenantB }, issued.contextRef, response);

    assert.equal(cookies.length, 2);
    assert.ok((cookies[0] ?? '').startsWith(`${PORTAL_CONTEXT_COOKIE}=`));
    assert.ok((cookies[1] ?? '').startsWith(`${PORTAL_CSRF_COOKIE}=`));
    if (entryMode === 'SUITE4_EMBED') {
      assert.match(cookies[0] ?? '', /; SameSite=None; Partitioned$/);
      assert.match(cookies[1] ?? '', /; SameSite=None; Partitioned$/);
    } else {
      assert.match(cookies[0] ?? '', /; SameSite=Lax$/);
      assert.match(cookies[1] ?? '', /; SameSite=Strict$/);
      assert.equal(cookies.some((value) => value.includes('Partitioned')), false);
    }
  }
});

test('portal-session verifier rejects an unknown persisted entry mode', async () => {
  const verifier = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return {
        sessionId: 'session-unknown-mode',
        principalId,
        tenantId: tenantA,
        contextVersion: 1,
        contextRefHash: 'a'.repeat(64),
        csrfTokenHash: 'b'.repeat(64),
        entryMode: 'REQUEST_HEADER_VALUE',
      } as unknown as StoredPortalSession;
    },
  });
  assert.equal(await verifier.verify('session-cookie-with-sufficient-entropy-123456'), undefined);
});

function fakeResponse(): Response & { readonly statusCodeValue: () => number; readonly bodyValue: () => unknown; readonly headerValue: (name: string) => unknown } {
  let status = 200;
  let body: unknown;
  const headers = new Map<string, unknown>();
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
    end() { return this; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    vary(_field: string) { return this; },
    statusCodeValue: () => status,
    bodyValue: () => body,
    headerValue: (name: string) => headers.get(name.toLowerCase()),
  };
  return response as unknown as Response & { readonly statusCodeValue: () => number; readonly bodyValue: () => unknown; readonly headerValue: (name: string) => unknown };
}

async function invokeMiddleware(
  middleware: ReturnType<typeof portalRequestSecurityMiddleware>,
  request: { readonly headers: Record<string, string | string[] | undefined>; readonly method: string; readonly protocol: string; get(name: string): string | undefined },
) {
  const response = fakeResponse();
  let continued = false;
  const next = ((_error?: unknown) => { continued = true; }) as NextFunction;
  await middleware(request as unknown as Request, response, next);
  return { response, continued };
}

test('mutations reject untrusted origins, Fetch Metadata and session CSRF mismatches', async () => {
  const env = {
    nodeEnv: 'test', port: 3000, bindAddress: '127.0.0.1', allowedHosts: ['portal.example'],
    allowedOrigins: ['https://portal.example'], suite4EmbedOrigins: [], trustedProxyCidrs: false,
    portalSessionRecoveryKey: recoveryKey,
    portalSessionIdleTimeoutSeconds: 1800,
    portalSessionAbsoluteTimeoutSeconds: 28800,
    database: { host: '127.0.0.1', port: 3306, name: 'synthetic', user: 'synthetic', password: 'synthetic', connectTimeoutMs: 100 },
  } satisfies ApiEnvironment;
  const csrf = 'csrf-token-with-sufficient-entropy-123456';
  const sessionCookie = 'session-cookie-with-sufficient-entropy-123456';
  const verifier = { async verify(value: string | undefined) {
    assert.equal(value, sessionCookie);
    return {
      sessionId: 'session-1', principalId, tenantId: tenantA, contextVersion: 1,
      contextRefHash: 'a'.repeat(64), csrfTokenHash: hash(csrf), entryMode: 'PORTAL_TOP_LEVEL',
    } as VerifiedPortalSession;
  } } as PortalSessionVerifier;
  const middleware = portalRequestSecurityMiddleware(env, verifier);
  const baseHeaders = {
    origin: 'https://portal.example', 'sec-fetch-site': 'same-origin',
    cookie: `${PORTAL_SESSION_COOKIE}=${sessionCookie}; ${PORTAL_CSRF_COOKIE}=${csrf}`,
  };
  const request = (headers: Record<string, string | string[] | undefined>, method = 'POST', path = '/api/v1/auth/exchanges') => ({
    headers, method, path, protocol: 'https', get: (name: string) => name.toLowerCase() === 'host' ? 'portal.example' : undefined,
  });

  const originlessExchange = await invokeMiddleware(middleware, request({}, 'POST', '/api/v1/auth/exchanges'));
  assert.equal(originlessExchange.response.statusCodeValue(), 403);
  assert.equal((originlessExchange.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');
  const originlessSessionWrite = await invokeMiddleware(middleware, request({}, 'POST', '/api/v1/session/tenant-switch'));
  assert.equal(originlessSessionWrite.response.statusCodeValue(), 403);
  assert.equal((originlessSessionWrite.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');
  const originlessWebhook = await invokeMiddleware(middleware, request({}, 'POST', '/api/v1/webhooks/meta/config_ref-123'));
  assert.equal(originlessWebhook.continued, true);
  const malformedWebhook = await invokeMiddleware(middleware, request({}, 'POST', '/api/v1/webhooks/meta/config/ref'));
  assert.equal(malformedWebhook.response.statusCodeValue(), 403);

  const badOrigin = await invokeMiddleware(middleware, request({ ...baseHeaders, origin: 'https://attacker.example' }));
  assert.equal(badOrigin.response.statusCodeValue(), 403);
  assert.equal((badOrigin.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(badOrigin.response.headerValue('access-control-allow-origin'), undefined);

  const badFetch = await invokeMiddleware(middleware, request({ ...baseHeaders, 'sec-fetch-site': 'same-site' }));
  assert.equal((badFetch.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');

  const badCsrf = await invokeMiddleware(middleware, request({ ...baseHeaders, 'x-csrf-token': 'wrong-token-with-sufficient-entropy-1234' }));
  assert.equal((badCsrf.response.bodyValue() as { code: string }).code, 'CSRF_INVALID');

  const legacyHeader = await invokeMiddleware(middleware, request({ ...baseHeaders, 'x-meta-csrf': csrf }));
  assert.equal((legacyHeader.response.bodyValue() as { code: string }).code, 'CSRF_INVALID');

  const good = await invokeMiddleware(middleware, request({ ...baseHeaders, 'x-csrf-token': csrf }));
  assert.equal(good.continued, true);
  assert.equal(good.response.headerValue('access-control-allow-origin'), 'https://portal.example');

  const missingCsrf = await invokeMiddleware(middleware, request(baseHeaders, 'POST', '/api/v1/session/logout'));
  assert.equal((missingCsrf.response.bodyValue() as { code: string }).code, 'CSRF_INVALID');

  const validDelete = await invokeMiddleware(middleware, request({ ...baseHeaders, 'x-csrf-token': csrf }, 'DELETE'));
  assert.equal(validDelete.continued, true);

  const preflight = await invokeMiddleware(middleware, request({
    origin: 'https://portal.example',
    'access-control-request-method': 'DELETE',
    'access-control-request-headers': 'content-type,x-csrf-token',
  }, 'OPTIONS'));
  assert.equal(preflight.response.statusCodeValue(), 204);
  assert.match(String(preflight.response.headerValue('access-control-allow-headers')), /X-CSRF-Token/);
  const legacyPreflight = await invokeMiddleware(middleware, request({
    origin: 'https://portal.example',
    'access-control-request-method': 'DELETE',
    'access-control-request-headers': 'x-meta-csrf',
  }, 'OPTIONS'));
  assert.equal(legacyPreflight.response.statusCodeValue(), 403);
});

test('public magic-link initiation tolerates stale portal cookies but retains browser origin checks', async () => {
  const env = {
    nodeEnv: 'test', port: 3000, bindAddress: '127.0.0.1', allowedHosts: ['portal.example'],
    allowedOrigins: ['https://portal.example'], suite4EmbedOrigins: [], trustedProxyCidrs: false,
    portalSessionRecoveryKey: recoveryKey,
    portalSessionIdleTimeoutSeconds: 1800,
    portalSessionAbsoluteTimeoutSeconds: 28800,
    database: { host: '127.0.0.1', port: 3306, name: 'synthetic', user: 'synthetic', password: 'synthetic', connectTimeoutMs: 100 },
  } satisfies ApiEnvironment;
  let verifyCalls = 0;
  const staleVerifier = { async verify() { verifyCalls += 1; return undefined; } } as unknown as PortalSessionVerifier;
  const middleware = portalRequestSecurityMiddleware(env, staleVerifier);
  const request = (headers: Record<string, string | string[] | undefined>, method = 'POST', path = '/api/v1/auth/magic-links') => ({
    headers, method, path, protocol: 'https', get: (name: string) => name.toLowerCase() === 'host' ? 'portal.example' : undefined,
  });
  const staleCookie = `${PORTAL_SESSION_COOKIE}=expired-session-cookie-with-sufficient-entropy-123456`;
  const sameOrigin = { origin: 'https://portal.example', 'sec-fetch-site': 'same-origin', cookie: staleCookie };

  const publicEntry = await invokeMiddleware(middleware, request(sameOrigin));
  assert.equal(publicEntry.continued, true);
  assert.equal(publicEntry.response.statusCodeValue(), 200);
  assert.equal(verifyCalls, 0);

  const deniedOrigin = await invokeMiddleware(middleware, request({ ...sameOrigin, origin: 'https://attacker.example' }));
  assert.equal(deniedOrigin.response.statusCodeValue(), 403);
  assert.equal((deniedOrigin.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');

  const deniedFetchMetadata = await invokeMiddleware(middleware, request({ ...sameOrigin, 'sec-fetch-site': 'same-site' }));
  assert.equal(deniedFetchMetadata.response.statusCodeValue(), 403);
  assert.equal((deniedFetchMetadata.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');

  const authenticatedWrite = await invokeMiddleware(middleware, request(sameOrigin, 'POST', '/api/v1/session/logout'));
  assert.equal(authenticatedWrite.response.statusCodeValue(), 401);
  assert.equal((authenticatedWrite.response.bodyValue() as { code: string }).code, 'AUTH_REQUIRED');
  assert.equal(verifyCalls, 1);

  const wrongMethod = await invokeMiddleware(middleware, request(sameOrigin, 'PUT', '/api/v1/auth/magic-links'));
  assert.equal(wrongMethod.response.statusCodeValue(), 401);
  assert.equal((wrongMethod.response.bodyValue() as { code: string }).code, 'AUTH_REQUIRED');

  const wrongPath = await invokeMiddleware(middleware, request(sameOrigin, 'POST', '/api/v1/auth/magic-links/extra'));
  assert.equal(wrongPath.response.statusCodeValue(), 401);
  assert.equal((wrongPath.response.bodyValue() as { code: string }).code, 'AUTH_REQUIRED');
  assert.equal(verifyCalls, 3);
});

test('portal cookies are host-only, Secure, HttpOnly where required, and denial codes map to safe 403/409 envelopes', () => {
  const response = fakeResponse() as Response & { append(name: string, value: string): void; headerValue(name: string): unknown };
  const appended: string[] = [];
  response.append = (_name: string, value: string) => { appended.push(value); return response; };
  setPortalSessionCookies(response, {
    sessionId: 'session-1',
    sessionCookie: 'session-cookie-with-sufficient-entropy-123456',
    csrfToken: 'csrf-token-with-sufficient-entropy-123456',
    contextRef: 'context-reference-with-sufficient-entropy-1234',
    tenantId: tenantA,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    publicContext: { sessionRef: 'session-1', principalRef: 'principal-ref', roles: ['operator'], tenantRef: tenantA, tenantContextRef: 'context', contextVersion: 1 },
  });
  assert.equal(appended.length, 3);
  assert.ok((appended[0] ?? '').startsWith(`${PORTAL_SESSION_COOKIE}=`));
  assert.match(appended[0] ?? '', /; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly$/);
  assert.ok((appended[1] ?? '').startsWith(`${PORTAL_CSRF_COOKIE}=`));
  assert.match(appended[1] ?? '', /; Path=\/; Max-Age=\d+; Secure; SameSite=Strict$/);
  assert.ok(appended.every((value) => !value.includes('Domain=')));
  assert.equal(appended.some((value) => value.includes('localStorage')), false);

  const mapped: Array<{ status: number; body: unknown }> = [];
  const logger: StructuredLogger = { write() {} };
  const filter = new SafeExceptionFilter(logger);
  const host = (capture: { status: number; body: unknown }) => ({
    switchToHttp: () => ({
      getRequest: () => ({ requestId: 'request-1' }),
      getResponse: () => ({ status: (status: number) => ({ json: (body: unknown) => { capture.status = status; capture.body = body; } }) }),
    }),
  });
  const invoke = (error: unknown) => {
    const capture = { status: 0, body: undefined as unknown };
    filter.catch(error, host(capture) as never);
    mapped.push(capture);
  };
  invoke(new IdentityDeniedError('ACCESS_DENIED'));
  invoke(new IdentityDeniedError('CONTEXT_CHANGED'));
  assert.equal(mapped[0]?.status, 403);
  assert.equal((mapped[0]?.body as { code: string }).code, 'ACCESS_DENIED');
  assert.equal(mapped[1]?.status, 409);
  assert.equal((mapped[1]?.body as { code: string }).code, 'CONTEXT_CHANGED');
});

test('DELETE session revokes only an owned same-tenant session; logout still revokes with stale context', async () => {
  const store = new SharedSessionStore();
  const { contexts, sessions, assertions } = services(store);
  const started = await sessions.begin();
  const preAuth = await sessions.verifyBrowserBinding(started.challengeRef, started.cookieValue);
  assert.ok(preAuth);
  const issued = await sessions.issueFromVerifiedAssertion(assertions.verify(), tenantA, {
    ticketJtiSha256: hash('delete-session-jti'),
    ticketSha256: hash('synthetic-delete-ticket'),
    ticketExpiresAt: new Date(Date.now() + 30_000),
    ticketChallengeSha256: hash(started.challengeRef),
    preAuth,
  });
  const actor = await new PortalSessionVerifier(store).verify(issued.sessionCookie);
  assert.ok(actor);

  const ownRecord = store.activeById.get(issued.sessionId);
  assert.ok(ownRecord);
  const foreign: PortalSessionRecord = Object.freeze({
    ...ownRecord,
    sessionId: randomUUID(),
    principalId: 'another-principal',
    sessionCookie: 'foreign-session-cookie-with-sufficient-entropy-123456',
    contextRefHash: 'b'.repeat(64),
    csrfTokenHash: 'c'.repeat(64),
  });
  store.seedSession(foreign);
  const deleteController = new PortalSessionsController(sessions);
  const deleteResponseHeaders: string[] = [];
  const deleteResponse = { append(_name: string, value: string) { deleteResponseHeaders.push(value); } } as unknown as Response;
  await assert.rejects(deleteController.revoke({ portalSession: actor } as PortalRequest, foreign.sessionId, deleteResponse), IdentityDeniedError);
  assert.equal(store.revoked.has(foreign.sessionId), false);

  const samePrincipalOtherTenant = Object.freeze({
    ...ownRecord,
    sessionId: randomUUID(),
    tenantId: tenantB,
    sessionCookie: 'other-tenant-session-cookie-with-sufficient-entropy-123456',
  });
  store.seedSession(samePrincipalOtherTenant);
  await assert.rejects(deleteController.revoke({ portalSession: actor } as PortalRequest, samePrincipalOtherTenant.sessionId, deleteResponse), IdentityDeniedError);
  assert.equal(store.revoked.has(samePrincipalOtherTenant.sessionId), false);

  await deleteController.revoke({ portalSession: actor } as PortalRequest, issued.sessionId, deleteResponse);
  assert.equal(deleteResponseHeaders.length, 8);
  assert.equal(await new PortalSessionVerifier(store).verify(issued.sessionCookie), undefined);

  const logoutChallenge = await sessions.begin();
  const logoutPreAuth = await sessions.verifyBrowserBinding(logoutChallenge.challengeRef, logoutChallenge.cookieValue);
  assert.ok(logoutPreAuth);
  const logoutIssued = await sessions.issueFromVerifiedAssertion(assertions.verify(), tenantA, {
    ticketJtiSha256: hash('logout-session-jti'),
    ticketSha256: hash('synthetic-logout-ticket'),
    ticketExpiresAt: new Date(Date.now() + 30_000),
    ticketChallengeSha256: hash(logoutChallenge.challengeRef),
    preAuth: logoutPreAuth,
  });
  const logoutSession = await new PortalSessionVerifier(store).verify(logoutIssued.sessionCookie);
  assert.ok(logoutSession);
  const logoutController = new PortalSessionController({
    async resolveCurrent() { throw new IdentityDeniedError('CONTEXT_CHANGED'); },
  } as unknown as TenantContextService, sessions, new class extends AbuseLimitService { async consume() {} }());
  const cleared: string[] = [];
  const response = { append(_name: string, value: string) { cleared.push(value); } } as unknown as Response;
  await logoutController.logout({
    headers: { 'x-tenant-context': 'stale-context-reference' },
    portalSession: logoutSession,
  } as unknown as PortalRequest, response);
  assert.equal(store.revoked.has(logoutSession.sessionId), true);
  assert.equal(cleared.length, 8);
  assert.equal(await new PortalSessionVerifier(store).verify(logoutIssued.sessionCookie), undefined);
});

test('GET session consumes SESSION_STATUS quota with verified principal, tenant, and trusted request IP', async () => {
  const store = new SharedSessionStore();
  const { contexts, sessions, assertions } = services(store);
  const challenge = await sessions.begin();
  const preAuth = await sessions.verifyBrowserBinding(challenge.challengeRef, challenge.cookieValue);
  assert.ok(preAuth);
  const issued = await sessions.issueFromVerifiedAssertion(assertions.verify(), tenantA, {
    ticketJtiSha256: hash('session-status-jti'),
    ticketSha256: hash('synthetic-session-status-ticket'),
    ticketExpiresAt: new Date(Date.now() + 30_000),
    ticketChallengeSha256: hash(challenge.challengeRef),
    preAuth,
  });
  const guardedRequest = {
    method: 'GET', path: '/api/v1/session', headers: { cookie: `${PORTAL_SESSION_COOKIE}=${issued.sessionCookie}` },
  } as PortalRequest;
  const guard = new PortalSessionGuard(new PortalSessionVerifier(store));
  await guard.canActivate({ switchToHttp: () => ({ getRequest: () => guardedRequest }) } as never);
  const verified = guardedRequest.portalSession;
  assert.equal(store.lastSeenRefreshes, 0);
  const consumed: Array<{ policy: AbuseLimitPolicy; dimensions: AbuseLimitDimensions }> = [];
  const abuseLimits = new class extends AbuseLimitService {
    async consume(policy: AbuseLimitPolicy, dimensions: AbuseLimitDimensions): Promise<void> {
      consumed.push({ policy, dimensions });
    }
  }();
  const controller = new PortalSessionController({
    resolveCurrent: contexts.resolveCurrent.bind(contexts),
    resolveTenantSwitch: contexts.resolveTenantSwitch.bind(contexts),
  } as unknown as TenantContextService, sessions, abuseLimits);
  const contextRef = issued.contextRef;
  const result = await controller.current({
    ip: '192.0.2.40',
    headers: guardedRequest.headers,
    portalSession: verified,
  } as PortalRequest, contextRef);
  assert.equal(result.sessionRef, issued.sessionId);
  assert.equal(result.tenantRef, tenantA);
  assert.equal(store.lastSeenRefreshes, 1);
  assert.deepEqual(consumed, [{
    policy: 'SESSION_STATUS',
    dimensions: { ip: '192.0.2.40', actor: principalId, tenant: tenantA },
  }]);

  const currentRecord = store.activeById.get(issued.sessionId);
  assert.ok(currentRecord);
  const nearExpiry = new Date(Date.now() + 90_000).toISOString();
  store.activeById.set(issued.sessionId, Object.freeze({ ...currentRecord, expiresAt: nearExpiry }));
  const cookieHeaders: string[] = [];
  const response = { append(_name: string, value: string) { cookieHeaders.push(value); } } as unknown as Response;
  await controller.switchTenant({
    portalSession: verified,
    headers: { 'x-tenant-context': issued.contextRef },
  } as unknown as PortalRequest, { tenantRef: tenantB }, issued.contextRef, response);
  assert.equal(cookieHeaders.length, 2);
  assert.ok(cookieHeaders.every((value) => /Max-Age=(?:[1-9]\d?|0);/.test(value)));
  assert.ok(cookieHeaders.every((value) => Number(value.match(/Max-Age=(\d+)/)?.[1]) <= 90));
});

test('portal-session timeout settings use documented proposal defaults, validate overrides, and reject absolute expiry below idle', () => {
  const environment = {
    NODE_ENV: 'test',
    API_PORT: '3000',
    API_BIND_ADDRESS: '127.0.0.1',
    API_ALLOWED_HOSTS: 'portal.example',
    API_ALLOWED_ORIGINS: 'http://localhost:8080',
    API_TRUSTED_PROXIES: 'none',
    API_DATABASE_HOST: '127.0.0.1',
    API_DATABASE_PORT: '3306',
    API_DATABASE_NAME: 'synthetic',
    API_DATABASE_USER: 'synthetic',
    API_DATABASE_PASSWORD: 'synthetic-only',
    API_DATABASE_CONNECT_TIMEOUT_MS: '250',
  };
  const defaults = validateEnvironment(environment);
  assert.equal(defaults.portalSessionIdleTimeoutSeconds, 1800);
  assert.equal(defaults.portalSessionAbsoluteTimeoutSeconds, 28800);
  const configured = validateEnvironment({
    ...environment,
    API_PORTAL_SESSION_IDLE_TIMEOUT_SECONDS: '600',
    API_PORTAL_SESSION_ABSOLUTE_TIMEOUT_SECONDS: '3600',
  });
  assert.equal(configured.portalSessionIdleTimeoutSeconds, 600);
  assert.equal(configured.portalSessionAbsoluteTimeoutSeconds, 3600);
  assert.throws(() => validateEnvironment({
    ...environment,
    API_PORTAL_SESSION_IDLE_TIMEOUT_SECONDS: '600',
    API_PORTAL_SESSION_ABSOLUTE_TIMEOUT_SECONDS: '300',
  }), /API_PORTAL_SESSION_ABSOLUTE_TIMEOUT_SECONDS/);
});
