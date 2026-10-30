import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { test } from 'node:test';
import { portalRequestSecurityMiddleware } from '../src/common/security/portal-request-security.js';
import { SafeExceptionFilter } from '../src/common/http/safe-exception.filter.js';
import type { StructuredLogger } from '../src/common/http/request-context.js';
import type { ApiEnvironment } from '../src/config/environment.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { TenantContextService } from '../src/identity/identity.service.js';
import { IdentityAssertionVerifier, PortalSessionVerifier } from '../src/identity/identity.trust.js';
import type { StoredPortalSession, VerifiedPortalSession } from '../src/identity/identity.trust.js';
import type { MembershipRole, TenantMembership } from '../src/identity/identity.types.js';
import {
  MysqlPortalSessionService,
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
const recoveryKey = 'synthetic-test-key-that-is-at-least-32-bytes-long';

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

  async findActiveBySecretHash(secretHash: Uint8Array): Promise<StoredPortalSession | undefined> {
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
    };
  }

  async changeContext(input: {
    readonly session: VerifiedPortalSession; readonly requestedTenantId: string; readonly contextRef: string;
    readonly contextRefHash: string; readonly csrfTokenHash: string;
  }): Promise<{ readonly contextVersion: number; readonly roles: readonly MembershipRole[] }> {
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
    return { contextVersion: updated.contextVersion, roles: updated.roles };
  }

  async revokeSession(sessionId: string): Promise<boolean> { this.revoked.add(sessionId); return true; }
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
  const options = { ticketJtiSha256: jti, ticketExpiresAt: new Date(Date.now() + 30_000), ticketChallengeSha256: challengeHash, preAuth };
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
    allowedOrigins: ['https://portal.example'], trustedProxyCidrs: false,
    portalSessionRecoveryKey: recoveryKey,
    database: { host: '127.0.0.1', port: 3306, name: 'synthetic', user: 'synthetic', password: 'synthetic', connectTimeoutMs: 100 },
  } satisfies ApiEnvironment;
  const csrf = 'csrf-token-with-sufficient-entropy-123456';
  const sessionCookie = 'session-cookie-with-sufficient-entropy-123456';
  const verifier = { async verify(value: string | undefined) {
    assert.equal(value, sessionCookie);
    return {
      sessionId: 'session-1', principalId, tenantId: tenantA, contextVersion: 1,
      contextRefHash: 'a'.repeat(64), csrfTokenHash: hash(csrf),
    } as VerifiedPortalSession;
  } } as PortalSessionVerifier;
  const middleware = portalRequestSecurityMiddleware(env, verifier);
  const baseHeaders = {
    origin: 'https://portal.example', 'sec-fetch-site': 'same-origin',
    cookie: `${PORTAL_SESSION_COOKIE}=${sessionCookie}; ${PORTAL_CSRF_COOKIE}=${csrf}`,
  };
  const request = (headers: Record<string, string | string[] | undefined>) => ({
    headers, method: 'POST', protocol: 'https', get: (name: string) => name.toLowerCase() === 'host' ? 'portal.example' : undefined,
  });

  const badOrigin = await invokeMiddleware(middleware, request({ ...baseHeaders, origin: 'https://attacker.example' }));
  assert.equal(badOrigin.response.statusCodeValue(), 403);
  assert.equal((badOrigin.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(badOrigin.response.headerValue('access-control-allow-origin'), undefined);

  const badFetch = await invokeMiddleware(middleware, request({ ...baseHeaders, 'sec-fetch-site': 'same-site' }));
  assert.equal((badFetch.response.bodyValue() as { code: string }).code, 'ORIGIN_NOT_ALLOWED');

  const badCsrf = await invokeMiddleware(middleware, request({ ...baseHeaders, 'x-meta-csrf': 'wrong-token-with-sufficient-entropy-1234' }));
  assert.equal((badCsrf.response.bodyValue() as { code: string }).code, 'CSRF_INVALID');

  const good = await invokeMiddleware(middleware, request({ ...baseHeaders, 'x-meta-csrf': csrf }));
  assert.equal(good.continued, true);
  assert.equal(good.response.headerValue('access-control-allow-origin'), 'https://portal.example');
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
    publicContext: { principalRef: 'principal-ref', roles: ['operator'], tenantRef: tenantA, tenantContextRef: 'context', contextVersion: 1 },
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
