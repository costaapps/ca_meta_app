import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import type { components } from '@ca-meta/contracts';
import type { AbuseLimitService } from '../src/common/security/abuse-limits.js';
import { setPortalPreAuthCookie, setPortalSessionCookies, type IssuedPortalSession, type StartedPortalPreAuth } from '../src/identity/portal-session.service.js';
import type { VerifiedPortalSession } from '../src/identity/identity.trust.js';
import { OnboardingStatusController, type OnboardingStatusReader, type OnboardingStatusSnapshot } from '../src/onboarding/onboarding-status.controller.js';
import type { OnboardingSessionService } from '../src/onboarding/onboarding-session.service.js';

test('embed pre-auth and session cookies are partitioned while first-party issuance stays compatible', () => {
  const preAuthHeaders: string[] = [];
  const response = { append: (_name: string, value: string) => preAuthHeaders.push(value) } as unknown as Response;
  const started: StartedPortalPreAuth = {
    challengeRef: 'synthetic-challenge-reference-1234567890',
    cookieValue: 'synthetic-browser-cookie-value-1234567890',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    entryMode: 'SUITE4_EMBED',
  };
  setPortalPreAuthCookie(response, started);
  assert.match(preAuthHeaders[0] ?? '', /; SameSite=None; Partitioned; HttpOnly/);

  const sessionHeaders: string[] = [];
  const sessionResponse = { append: (_name: string, value: string) => sessionHeaders.push(value) } as unknown as Response;
  const sessionRef = 'a406aaf4-837a-45d7-9f93-4db17920668d';
  const contextRef = 'synthetic-tenant-context-reference';
  const issued: IssuedPortalSession = {
    sessionId: sessionRef,
    sessionCookie: 'synthetic-session-cookie-value-1234567890',
    csrfToken: 'synthetic-csrf-token-value-1234567890',
    contextRef,
    tenantId: 'tenant-from-server',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    cookiePartitioned: true,
    publicContext: {
      sessionRef,
      principalRef: 'synthetic-principal-ref',
      tenantRef: 'tenant-from-server',
      roles: ['viewer'],
      tenantContextRef: contextRef,
      contextVersion: 1,
    },
  };
  setPortalSessionCookies(sessionResponse, issued);
  assert.equal(sessionHeaders.length, 3);
  assert.ok(sessionHeaders.every((cookie) => cookie.includes('; SameSite=None; Partitioned')));
  assert.ok(sessionHeaders[0]?.includes('; HttpOnly'));
  assert.equal(sessionHeaders[1]?.includes('; HttpOnly'), false);
});

test('onboarding status reader is passed only server session, opaque ID and context; its returned status is authoritative', async () => {
  const session = Object.freeze({ sessionId: 'session-a', principalId: 'principal-a', tenantId: 'tenant-a' }) as VerifiedPortalSession;
  const snapshot: OnboardingStatusSnapshot = {
    id: 'onboarding-opaque-reference-123',
    flowVariant: 'WHATSAPP_CLOUD_API',
    status: 'PARTIAL',
    readiness: 'PARTIAL',
    steps: [{ name: 'authorization', status: 'SUCCEEDED' }],
    phoneReadiness: [{ assetRef: 'f1c90208-010c-48b0-90e3-ef28f825efdd', state: 'ACTION_REQUIRED',
      reasonCode: 'TOKEN_ELIGIBILITY_NOT_CONFIRMED', observedAt: '2026-11-10T12:00:00.000Z' }],
    nextAction: 'RESUME',
    lastUpdatedAt: '2026-10-30T12:00:00.000Z',
  };
  const observed: { session?: VerifiedPortalSession; id?: string; context?: string } = {};
  const reader: OnboardingStatusReader = {
    async read(currentSession, onboardingId, tenantContextRef) {
      observed.session = currentSession;
      observed.id = onboardingId;
      observed.context = tenantContextRef;
      return snapshot;
    },
  };
  const abuseLimits = { async consume() {} } as unknown as AbuseLimitService;
  const controller = new OnboardingStatusController(reader, {} as OnboardingSessionService, abuseLimits);
  const request = {
    portalSession: session,
    originalUrl: '/api/v1/onboarding-sessions/onboarding-opaque-reference-123',
    requestId: 'server-request-id',
    headers: {},
  } as never;
  const result: components['schemas']['OnboardingStatus'] = await controller.read(
    'onboarding-opaque-reference-123', request, 'tenant-context-reference-123456',
  );
  assert.equal(observed.session, session);
  assert.equal(observed.id, 'onboarding-opaque-reference-123');
  assert.equal(observed.context, 'tenant-context-reference-123456');
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.requestId, 'server-request-id');
  assert.equal(result.phoneReadiness?.[0]?.reasonCode, 'TOKEN_ELIGIBILITY_NOT_CONFIRMED');
  assert.equal(result.phoneReadiness?.[0]?.assetRef, 'f1c90208-010c-48b0-90e3-ef28f825efdd');
  assert.equal('access_token' in result, false);
  assert.equal('tenantId' in result, false);
});

test('onboarding creation rejects query strings so OAuth data cannot enter request targets', async () => {
  const session = Object.freeze({ sessionId: 'session-a', principalId: 'principal-a', tenantId: 'tenant-a' }) as VerifiedPortalSession;
  const controller = new OnboardingStatusController(
    { async read() { return undefined; } },
    {} as OnboardingSessionService,
    { async consume() {} } as unknown as AbuseLimitService,
  );
  const request = {
    portalSession: session,
    originalUrl: '/api/v1/onboarding-sessions?code=synthetic-sensitive-value',
    requestId: 'server-request-id',
    headers: {},
  } as never;

  await assert.rejects(
    controller.create({} as never, request),
    BadRequestException,
  );
});
