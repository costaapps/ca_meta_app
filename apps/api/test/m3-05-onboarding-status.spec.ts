import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import type { components } from '@ca-meta/contracts';
import { setPortalPreAuthCookie, setPortalSessionCookies, type IssuedPortalSession, type StartedPortalPreAuth } from '../src/identity/portal-session.service.js';
import type { VerifiedPortalSession } from '../src/identity/identity.trust.js';
import { OnboardingStatusController, type OnboardingStatusReader, type OnboardingStatusSnapshot } from '../src/onboarding/onboarding-status.controller.js';
import { UnavailableOnboardingStatusReader } from '../src/onboarding/onboarding-status.module.js';

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
    status: 'READY',
    readiness: 'READY',
    steps: [{ name: 'authorization', status: 'SUCCEEDED' }],
    nextAction: 'NONE',
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
  const controller = new OnboardingStatusController(reader);
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
  assert.equal(result.status, 'READY');
  assert.equal(result.requestId, 'server-request-id');
  assert.equal('access_token' in result, false);
  assert.equal('tenantId' in result, false);
});

test('unconfigured onboarding status is unavailable and cannot infer success from a callback', async () => {
  const reader = new UnavailableOnboardingStatusReader();
  await assert.rejects(
    reader.read({} as VerifiedPortalSession, 'onboarding-opaque-reference-123', 'tenant-context-reference-123456'),
    ServiceUnavailableException,
  );
});
