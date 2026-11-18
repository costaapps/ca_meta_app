// @vitest-environment jsdom
import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { of, Subject, type Observable } from 'rxjs';
import type { HttpClient } from '@angular/common/http';
import { CoexistenceOnboardingService, reauthorizationIdempotencyKey } from './coexistence-onboarding.service';
import type { CoexistenceProviderAdapter } from './coexistence-provider-adapter';
import { PortalTenantIdentityService, type TenantMutationCapability } from '../portal/portal-tenant-identity.service';
import type { PortalSessionService } from '../portal/portal-session.service';

const providerOrigin = 'https://provider.synthetic.invalid';
const onboardingRef = 'onboarding-session-reference-123456';
const stateRef = 'synthetic-provider-state-reference-1234567890';
const tenantContextRef = 'synthetic-tenant-context-reference-123';
const csrfToken = 'synthetic-csrf-cookie-value-1234567890';
const syntheticConfirmedCapability: TenantMutationCapability = Object.freeze({
  confirmed: true,
  tenantDisplayName: 'Synthetic confirmed company',
  source: 'server-session',
});
// Existing M4 flow tests exercise onboarding logic behind a typed capability. This synthetic fixture
// is not evidence that the current API supplies a confirmed company label.
const testTenantIdentity = {
  current: syntheticConfirmedCapability,
  forSession: () => syntheticConfirmedCapability,
} as unknown as PortalTenantIdentityService;

function portalSession(contextRef = tenantContextRef) {
  return {
    sessionRef: 'synthetic-session-reference-123',
    principalRef: 'synthetic-principal-reference-123',
    tenantRef: 'synthetic-tenant-reference-123',
    roles: ['operator'],
    tenantContextRef: contextRef,
    contextVersion: 1,
    requestId: 'synthetic-session-request-123',
  };
}

const readyStatus = {
  id: onboardingRef,
  flowVariant: 'WHATSAPP_COEXISTENCE',
  status: 'READY',
  readiness: 'READY',
  steps: [
    { name: 'authorization', status: 'SUCCEEDED' },
    { name: 'asset-verification', status: 'SUCCEEDED' },
    { name: 'subscription', status: 'SUCCEEDED' },
    { name: 'projection', status: 'SUCCEEDED' },
  ],
  nextAction: 'NONE',
  lastUpdatedAt: '2026-11-10T12:00:00.000Z',
  requestId: 'synthetic-status-request-1234567890',
};

const flowList = {
  items: [{
    variant: 'WHATSAPP_COEXISTENCE',
    flowVariant: 'WHATSAPP_COEXISTENCE',
    journeys: ['WHATSAPP_COEXISTENCE'],
    enabled: true,
    availability: 'AVAILABLE',
    prerequisites: {
      metaAppConfigured: true,
      serverAdapterRegistered: true,
      tenantFeatureFlag: 'ENABLED',
    },
    requestedCapabilities: ['ASSET_DISCOVERY'],
  }],
  requestId: 'synthetic-flow-list-request-123456',
};

function reviewedAdapter(
  messageSource: MessageEventSource = window,
  nextMessageSource?: () => MessageEventSource,
): CoexistenceProviderAdapter {
  return {
    contract: {
      authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
      sdkVersion: 'synthetic-sdk-version',
      embeddedSignupVersion: 'synthetic-signup-version',
      featureType: 'synthetic-feature-type',
      messageOrigin: providerOrigin,
      sourceSemantics: 'synthetic source binding fixture',
      eventSchemaEvidence: 'https://docs.synthetic.invalid/events',
      originAndSourceEvidence: 'https://docs.synthetic.invalid/origin-source',
    },
    prepareForUserGesture: () => ({
      messageOrigin: providerOrigin,
      messageSource: nextMessageSource?.() ?? messageSource,
      start: vi.fn(),
      dispose: vi.fn(),
    }),
    // The fixture maps local test-only shapes to normalized events; it is not a Meta wire schema.
    decodeMessage: (data) => {
      if (typeof data !== 'object' || data === null || !('fixtureEvent' in data)) return undefined;
      const value = data as { fixtureEvent?: string; code?: string };
      if (value.fixtureEvent === 'finished') return { type: 'finished' };
      if (value.fixtureEvent === 'cancelled') return { type: 'cancelled' };
      if (value.fixtureEvent === 'code' && typeof value.code === 'string') {
        return { type: 'authorization_code', authorizationCode: value.code };
      }
      return undefined;
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());
}

interface ServiceHarness {
  readonly service: CoexistenceOnboardingService;
  readonly messageSource: MessageEventSource;
  readonly post: { readonly mock: { readonly calls: readonly [string, unknown, unknown?][] } };
  readonly get: { readonly mock: { readonly calls: readonly [string][] } };
  setStatus(status: unknown): void;
  setStatusAfterAction(status: unknown): void;
  setTenantContextRef(value: string): void;
}

interface IdentityGuardAttempt {
  readonly onboardingRef: string;
  readonly stateRef: string;
  readonly tenantContextRef: string;
  state: string;
  message: string;
}

function pendingServerStatus(id: string): Record<string, unknown> {
  return {
    id,
    flowVariant: 'WHATSAPP_COEXISTENCE',
    status: 'AWAITING_PROVIDER',
    readiness: 'UNKNOWN',
    steps: [{ name: 'authorization', status: 'RUNNING' }],
    nextAction: 'WAIT',
    lastUpdatedAt: '2026-11-10T12:00:00.000Z',
    requestId: 'synthetic-status-request-1234567890',
  };
}

function serviceHarness(options: {
  readonly ref?: string;
  readonly state?: string;
  readonly source?: MessageEventSource;
  readonly expiresInMs?: number;
  readonly statusResponse?: (status: unknown) => Observable<unknown>;
} = {}): ServiceHarness {
  const ref = options.ref ?? onboardingRef;
  const state = options.state ?? stateRef;
  let activeTenantContextRef = tenantContextRef;
  const serverStatuses = new Map<string, unknown>([[ref, pendingServerStatus(ref)]]);
  let statusAfterAction: unknown;
  let createCount = 0;
  let preparedCount = 0;
  const messageSource = options.source ?? window;
  const get = vi.fn((url: string) => {
    if (url.endsWith('/session')) return of(portalSession(activeTenantContextRef));
    if (url.endsWith('/integrations/flows')) return of(flowList);
    const path = url.split('/');
    const sessionsIndex = path.lastIndexOf('onboarding-sessions');
    const requestedRef = path[sessionsIndex + 1] ?? ref;
    const status = serverStatuses.get(requestedRef) ?? pendingServerStatus(requestedRef);
    return options.statusResponse?.(status) ?? of(status);
  });
  const post = vi.fn((url: string, body: unknown, _options?: unknown) => {
    if (url.endsWith('/onboarding-sessions')) {
      createCount += 1;
      const createdRef = createCount === 1 ? ref : `${ref}-replacement-${createCount}`;
      const createdState = createCount === 1 ? state : `${state}-replacement-${createCount}`;
      if (createCount > 1) serverStatuses.set(createdRef, pendingServerStatus(createdRef));
      return of({
        id: createdRef,
        status: 'AWAITING_PROVIDER',
        expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60_000)).toISOString(),
        launchUrl: `${providerOrigin}/start?state=${createdState}`,
        requestId: 'synthetic-create-request-1234567890',
      });
    }
    if (url.endsWith('/actions')) {
      if (statusAfterAction !== undefined) serverStatuses.set(ref, statusAfterAction);
      return of({
        jobId: 'synthetic-recovery-job-1234567890',
        status: 'PENDING',
        location: '/api/v1/jobs/synthetic-recovery-job-1234567890',
        requestId: 'synthetic-recovery-request-1234567890',
      });
    }
    if (url.endsWith('/authorization-code')) {
      return of({
        jobId: 'synthetic-code-job-1234567890',
        status: 'PENDING',
        location: '/api/v1/jobs/synthetic-code-job-1234567890',
        requestId: 'synthetic-code-request-1234567890',
      });
    }
    return of({ body });
  });
  const service = new CoexistenceOnboardingService(
    { get, post } as unknown as HttpClient,
    '/api',
    [providerOrigin],
    reviewedAdapter(messageSource, () => {
      preparedCount += 1;
      return preparedCount === 1 ? messageSource : {} as MessageEventSource;
    }),
    document,
    testTenantIdentity,
  );
  return {
    service,
    messageSource,
    post,
    get,
    setStatus: (status) => {
      if (typeof status === 'object' && status !== null && 'id' in status && typeof status.id === 'string') {
        serverStatuses.set(status.id, status);
      }
    },
    setStatusAfterAction: (status) => { statusAfterAction = status; },
    setTenantContextRef: (value) => { activeTenantContextRef = value; },
  };
}

function installSyntheticCsrfCookie(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => `__Host-ca_meta_csrf=${csrfToken}`,
  });
  return () => {
    if (descriptor) Object.defineProperty(document, 'cookie', descriptor);
    else Reflect.deleteProperty(document, 'cookie');
  };
}

async function startSyntheticAttempt(harness: ServiceHarness): Promise<void> {
  await harness.service.refreshAvailability();
  await harness.service.start();
}

function dispatchSyntheticMessage(source: MessageEventSource, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    origin: providerOrigin,
    source: source as MessagePort,
    data,
  }));
}

describe('CoexistenceOnboardingService', () => {
  it('gives concurrent tabs the same bounded reauthorization key for one source session', () => {
    const tabAKey = reauthorizationIdempotencyKey(onboardingRef);
    const tabBKey = reauthorizationIdempotencyKey(onboardingRef);
    expect(tabAKey).toBe(`reauth-${onboardingRef}`);
    expect(tabBKey).toBe(tabAKey);
    expect(tabAKey).toMatch(/^[A-Za-z0-9._~-]{16,128}$/);
    expect(reauthorizationIdempotencyKey(`${onboardingRef}-other`)).not.toBe(tabAKey);
  });

  it('keeps the provider path disabled when the reviewed adapter contract is absent', async () => {
    const http = { get: vi.fn(), post: vi.fn() } as unknown as HttpClient;
    const service = new CoexistenceOnboardingService(http, '/api', [providerOrigin], {
      prepareForUserGesture: () => undefined,
      decodeMessage: () => undefined,
    }, document, testTenantIdentity);

    await service.refreshAvailability();

    expect(service.getSnapshot().canStart).toBe(false);
    expect(service.getSnapshot().state).toBe('unavailable');
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
    service.dispose();
  });

  it('retains server reads but blocks direct coexistence create, recovery, and code submission without confirmed identity', async () => {
    const prepared = reviewedAdapter().prepareForUserGesture();
    const prepareForUserGesture = vi.fn(() => prepared);
    const adapter = { ...reviewedAdapter(), prepareForUserGesture };
    const get = vi.fn((url: string) => of(url.endsWith('/session') ? portalSession() : flowList));
    const post = vi.fn(() => of({}));
    const sessions = { current: portalSession() } as unknown as PortalSessionService;
    const identity = new PortalTenantIdentityService(sessions);
    const service = new CoexistenceOnboardingService(
      { get, post } as unknown as HttpClient,
      '/api',
      [providerOrigin],
      adapter,
      document,
      identity,
    );

    await service.refreshAvailability();
    expect(get).toHaveBeenCalledWith('/api/v1/session', { withCredentials: true });
    expect(get).toHaveBeenCalledWith('/api/v1/integrations/flows', expect.anything());
    expect(service.getSnapshot()).toMatchObject({
      state: 'unavailable',
      message: 'Identidade da empresa não confirmada',
      canStart: false,
    });

    await service.start();
    await service.recover(onboardingRef, { action: 'RESUME', stage: 'authorization' });
    expect(prepareForUserGesture).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();

    const restoreCookie = installSyntheticCsrfCookie();
    const attempt: IdentityGuardAttempt = {
      onboardingRef,
      stateRef,
      tenantContextRef,
      state: 'awaiting_provider',
      message: '',
    };
    const internal = service as unknown as {
      submitCode(attempt: IdentityGuardAttempt, authorizationCode: string): Promise<void>;
      stopListening(attempt: IdentityGuardAttempt): void;
      confirmStatus(attempt: IdentityGuardAttempt, scheduleNext: boolean): Promise<void>;
    };
    internal.stopListening = vi.fn();
    internal.confirmStatus = vi.fn(async () => undefined);
    try {
      await internal.submitCode(attempt, 'synthetic-authorization-code');
      expect(post).not.toHaveBeenCalled();
    } finally {
      restoreCookie();
      service.dispose();
    }
  });

  it('does not create a server session if the user-gesture provider context cannot be prepared', async () => {
    const adapter: CoexistenceProviderAdapter = {
      ...reviewedAdapter(),
      prepareForUserGesture: vi.fn(() => undefined),
    };
    const get = vi.fn((url: string) => of(url.endsWith('/session')
      ? portalSession()
      : url.endsWith('/integrations/flows') ? flowList : pendingServerStatus(onboardingRef)));
    const post = vi.fn(() => of({}));
    const service = new CoexistenceOnboardingService(
      { get, post } as unknown as HttpClient,
      '/api',
      [providerOrigin],
      adapter,
      document,
      testTenantIdentity,
    );

    await service.refreshAvailability();
    get.mockClear();
    await service.start();

    expect(adapter.prepareForUserGesture).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(service.getSnapshot().canStart).toBe(false);
    service.dispose();
  });

  it('keeps finish-before-code on one source-bound session and only accepts server READY', async () => {
    const cookieDescriptor = Object.getOwnPropertyDescriptor(document, 'cookie');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => `__Host-ca_meta_csrf=${csrfToken}`,
    });
    let serverStatus: unknown = {
      ...readyStatus,
      status: 'AWAITING_PROVIDER',
      readiness: 'UNKNOWN',
      steps: [{ name: 'authorization', status: 'RUNNING' }],
      nextAction: 'WAIT',
    };
    const preparationOrder: string[] = [];
    const prepared = reviewedAdapter().prepareForUserGesture();
    const start = vi.spyOn(prepared!, 'start');
    const dispose = vi.spyOn(prepared!, 'dispose');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const adapter: CoexistenceProviderAdapter = {
      ...reviewedAdapter(),
      prepareForUserGesture: vi.fn(() => { preparationOrder.push('prepare'); return prepared; }),
    };
    const get = vi.fn((url: string) => {
      preparationOrder.push('get');
      return of(url.endsWith('/session')
        ? portalSession()
        : url.endsWith('/integrations/flows') ? flowList : serverStatus);
    });
    const post = vi.fn((url: string, body: unknown) => {
      if (url.endsWith('/onboarding-sessions')) {
        return of({
          id: onboardingRef,
          status: 'AWAITING_PROVIDER',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          launchUrl: `https://provider.synthetic.invalid/start?state=${stateRef}`,
          requestId: 'synthetic-create-request-1234567890',
        });
      }
      if (url.endsWith(`/onboarding-sessions/${onboardingRef}/authorization-code`)) {
        serverStatus = readyStatus;
        return of({
          jobId: 'synthetic-job-reference-1234567890',
          status: 'PENDING',
          location: '/api/v1/jobs/synthetic-job-reference-1234567890',
          requestId: 'synthetic-code-request-1234567890',
        });
      }
      return of({ body });
    });
    const service = new CoexistenceOnboardingService(
      { get, post } as unknown as HttpClient,
      '/api',
      [providerOrigin],
      adapter,
      document,
      testTenantIdentity,
    );

    try {
      await service.refreshAvailability();
      preparationOrder.length = 0;
      await service.start();
      expect(preparationOrder[0]).toBe('prepare');
      expect(start).toHaveBeenCalledWith({
        launchUrl: `https://provider.synthetic.invalid/start?state=${stateRef}`,
        onboardingRef,
      });
      expect(service.getSnapshot().attempts[0]?.state).toBe('awaiting_provider');

      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://attacker.synthetic.invalid',
        source: window as unknown as MessagePort,
        data: { fixtureEvent: 'code', code: 'wrong-origin-code' },
      }));
      window.dispatchEvent(new MessageEvent('message', {
        origin: providerOrigin,
        source: {} as MessagePort,
        data: { fixtureEvent: 'code', code: 'wrong-source-code' },
      }));
      expect(post).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new MessageEvent('message', {
        origin: providerOrigin,
        source: window as unknown as MessagePort,
        data: { fixtureEvent: 'finished' },
      }));
      await flushMicrotasks();
      window.dispatchEvent(new MessageEvent('message', {
        origin: providerOrigin,
        source: window as unknown as MessagePort,
        data: { fixtureEvent: 'code', code: 'synthetic-code-for-this-session' },
      }));
      window.dispatchEvent(new MessageEvent('message', {
        origin: providerOrigin,
        source: window as unknown as MessagePort,
        data: { fixtureEvent: 'code', code: 'duplicate-code-for-this-session' },
      }));
      await flushMicrotasks();

      const codeCall = post.mock.calls.find(([url]) => url.endsWith(`/onboarding-sessions/${onboardingRef}/authorization-code`));
      expect(codeCall?.[1]).toEqual({ authorizationCode: 'synthetic-code-for-this-session', stateRef });
      expect(codeCall?.[0]).toBe(`/api/v1/onboarding-sessions/${onboardingRef}/authorization-code`);
      expect(post.mock.calls.filter(([url]) => url.endsWith(`/onboarding-sessions/${onboardingRef}/authorization-code`)))
        .toHaveLength(1);
      expect(service.getSnapshot().attempts[0]?.state).toBe('ready');
      expect(dispose).toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
    } finally {
      service.dispose();
      if (cookieDescriptor) Object.defineProperty(document, 'cookie', cookieDescriptor);
      else Reflect.deleteProperty(document, 'cookie');
      vi.restoreAllMocks();
    }
  });

  it('keeps PARTIAL blocked through RESUME until authoritative READY', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    const partial = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [
        { name: 'authorization', status: 'SUCCEEDED' },
        { name: 'asset-verification', status: 'RETRY_PENDING' },
      ],
      nextAction: 'RESUME',
    };
    const queued = {
      ...partial,
      status: 'PROVISIONING',
      readiness: 'UNKNOWN',
      steps: [{ name: 'asset-verification', status: 'PENDING' }],
      nextAction: 'CHECK_STATUS',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partial);
      dispatchSyntheticMessage(harness.messageSource, { fixtureEvent: 'finished' });
      await flushMicrotasks();

      const attempt = harness.service.getSnapshot().attempts[0];
      expect(attempt?.state).toBe('partial');
      expect(attempt?.nextAction).toBe('RESUME');
      expect(attempt?.recoveryOptions).toEqual([{ action: 'RESUME', stage: 'asset-verification' }]);
      expect(harness.service.getSnapshot().canStart).toBe(false);

      harness.setStatusAfterAction(queued);
      await harness.service.recover(onboardingRef, { action: 'RESUME', stage: 'asset-verification' });
      const actionCall = harness.post.mock.calls.find(([url]) => url.endsWith('/actions'));
      expect(actionCall?.[0]).toBe(`/api/v1/onboarding-sessions/${onboardingRef}/actions`);
      expect(actionCall?.[1]).toEqual({ action: 'RESUME', stage: 'asset-verification' });
      expect(harness.service.getSnapshot().attempts[0]?.pendingRecovery)
        .toEqual({ action: 'RESUME', stage: 'asset-verification' });
      expect(harness.service.getSnapshot().canStart).toBe(false);

      await harness.service.start();
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'))).toHaveLength(1);

      harness.setStatus(readyStatus);
      await harness.service.refreshAttemptStatus(onboardingRef);
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('ready');
      expect(harness.service.getSnapshot().canStart).toBe(true);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('discards an older recovery status after a newer manual read confirms READY', async () => {
    vi.useFakeTimers();
    const restoreCookie = installSyntheticCsrfCookie();
    const deferredStatusResponses: Subject<unknown>[] = [];
    let deferStatusResponses = false;
    const harness = serviceHarness({
      statusResponse: (status) => {
        if (!deferStatusResponses) return of(status);
        const response = new Subject<unknown>();
        deferredStatusResponses.push(response);
        return response;
      },
    });
    const partial = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [{ name: 'subscription', status: 'UNKNOWN' }],
      nextAction: 'RECONCILE',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partial);
      dispatchSyntheticMessage(harness.messageSource, { fixtureEvent: 'finished' });
      await flushMicrotasks();
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('partial');

      deferStatusResponses = true;
      const recovery = harness.service.recover(onboardingRef, { action: 'RECONCILE', stage: 'subscription' });
      await flushMicrotasks();
      expect(deferredStatusResponses).toHaveLength(1);

      const manualRefresh = harness.service.refreshAttemptStatus(onboardingRef);
      await flushMicrotasks();
      expect(deferredStatusResponses).toHaveLength(2);

      deferredStatusResponses[1]?.next(readyStatus);
      deferredStatusResponses[1]?.complete();
      await manualRefresh;
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('ready');

      deferredStatusResponses[0]?.next(partial);
      deferredStatusResponses[0]?.complete();
      await recovery;

      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('ready');
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/actions'))).toHaveLength(0);
      expect(harness.service.getSnapshot().canStart).toBe(true);
    } finally {
      harness.service.dispose();
      for (const response of deferredStatusResponses) response.complete();
      restoreCookie();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('does not send a provider code or read session status after the active tenant context changes', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    try {
      await startSyntheticAttempt(harness);
      const statusReadsBeforeSwitch = harness.get.mock.calls.filter(([url]) =>
        url.endsWith(`/onboarding-sessions/${onboardingRef}`)).length;
      harness.setTenantContextRef('synthetic-other-tenant-context-reference-456');

      dispatchSyntheticMessage(harness.messageSource, { fixtureEvent: 'code', code: 'synthetic-code-for-original-session' });
      await flushMicrotasks();

      expect(harness.post.mock.calls.filter(([url]) =>
        url.endsWith(`/onboarding-sessions/${onboardingRef}/authorization-code`))).toHaveLength(0);
      expect(harness.get.mock.calls.filter(([url]) =>
        url.endsWith(`/onboarding-sessions/${onboardingRef}`))).toHaveLength(statusReadsBeforeSwitch);
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('awaiting_server_confirmation');
      expect(harness.service.getSnapshot().attempts[0]?.message).toContain('contexto ativo mudou');
      expect(harness.service.getSnapshot().canStart).toBe(false);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('keeps four consecutive ready numbers in separate ordered history entries', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    const refs: string[] = [];
    try {
      await harness.service.refreshAvailability();
      for (let index = 0; index < 4; index += 1) {
        await harness.service.start();
        const attempt = harness.service.getSnapshot().attempts[index];
        expect(attempt?.ordinal).toBe(index + 1);
        expect(attempt?.state).toBe('awaiting_provider');
        refs.push(attempt!.onboardingRef);

        harness.setStatus({ ...readyStatus, id: attempt!.onboardingRef });
        await harness.service.refreshAttemptStatus(attempt!.onboardingRef);
        expect(harness.service.getSnapshot().attempts[index]?.state).toBe('ready');
      }

      expect(new Set(refs).size).toBe(4);
      expect(harness.service.getSnapshot().attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2, 3, 4]);
      expect(harness.service.getSnapshot().attempts.map((attempt) => attempt.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
      expect(harness.service.getSnapshot().canStart).toBe(true);
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'))).toHaveLength(4);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('starts a new scoped onboarding only after PARTIAL authorization REAUTHORIZE is reconfirmed', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    const partialReauthorize = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [{ name: 'authorization', status: 'FAILED' }],
      nextAction: 'REAUTHORIZE',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partialReauthorize);
      dispatchSyntheticMessage(harness.messageSource, { fixtureEvent: 'finished' });
      await flushMicrotasks();

      const partialAttempt = harness.service.getSnapshot().attempts[0];
      expect(partialAttempt?.state).toBe('partial');
      expect(partialAttempt?.nextAction).toBe('REAUTHORIZE');
      expect(partialAttempt?.recoveryOptions).toEqual([{ action: 'REAUTHORIZE', stage: 'authorization' }]);
      expect(harness.service.getSnapshot().canStart).toBe(false);

      harness.setStatus({
        ...partialReauthorize,
        status: 'PROVISIONING',
        readiness: 'UNKNOWN',
        steps: [{ name: 'authorization', status: 'UNKNOWN' }],
        nextAction: 'RECONCILE',
      });
      await harness.service.recover(onboardingRef, { action: 'REAUTHORIZE', stage: 'authorization' });
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'))).toHaveLength(1);
      expect(harness.service.getSnapshot().canStart).toBe(false);

      harness.setStatus(partialReauthorize);
      await harness.service.refreshAttemptStatus(onboardingRef);
      expect(harness.service.getSnapshot().attempts[0]?.recoveryOptions)
        .toEqual([{ action: 'REAUTHORIZE', stage: 'authorization' }]);

      // Reauthorization follows the new-onboarding contract, never /actions/REAUTHORIZE.
      await harness.service.recover(onboardingRef, { action: 'REAUTHORIZE', stage: 'authorization' });
      const createCalls = harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'));
      expect(createCalls).toHaveLength(2);
      expect(createCalls[1]?.[1]).toEqual({
        flowVariant: 'WHATSAPP_COEXISTENCE',
        requestedCapabilities: ['ASSET_DISCOVERY'],
        returnRoute: 'setup',
      });
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/actions'))).toHaveLength(0);
      const createHeaders = createCalls[1]?.[2] as { headers?: { get(name: string): string | null } } | undefined;
      const firstCreateHeaders = createCalls[0]?.[2] as { headers?: { get(name: string): string | null } } | undefined;
      expect(createHeaders?.headers?.get('Idempotency-Key')).toBeTruthy();
      expect(createHeaders?.headers?.get('Idempotency-Key')).toBe(reauthorizationIdempotencyKey(onboardingRef));
      expect(createHeaders?.headers?.get('Idempotency-Key'))
        .not.toBe(firstCreateHeaders?.headers?.get('Idempotency-Key'));

      const attempts = harness.service.getSnapshot().attempts;
      const replacementRef = attempts[1]?.onboardingRef;
      expect(replacementRef).toMatch(/-replacement-/);
      expect(attempts[0]?.state).toBe('partial');
      expect(attempts[0]?.replacementOnboardingRef).toBe(replacementRef);
      expect(attempts[1]?.state).toBe('awaiting_provider');
      expect(harness.service.getSnapshot().canStart).toBe(false);

      await harness.service.start();
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'))).toHaveLength(2);

      harness.setStatus({ ...readyStatus, id: replacementRef });
      await harness.service.refreshAttemptStatus(replacementRef ?? '');
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('partial');
      expect(harness.service.getSnapshot().attempts[1]?.state).toBe('ready');
      expect(harness.service.getSnapshot().canStart).toBe(true);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('does not create a reauthorization session after the mocked tenant context changes', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    const partialReauthorize = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [{ name: 'authorization', status: 'FAILED' }],
      nextAction: 'REAUTHORIZE',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partialReauthorize);
      dispatchSyntheticMessage(harness.messageSource, { fixtureEvent: 'finished' });
      await flushMicrotasks();

      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('partial');
      expect(harness.service.getSnapshot().attempts[0]?.recoveryOptions)
        .toEqual([{ action: 'REAUTHORIZE', stage: 'authorization' }]);
      const profileReadsBeforeSwitch = harness.get.mock.calls.filter(([url]) => url.endsWith('/integrations/flows')).length;
      const statusReadsBeforeSwitch = harness.get.mock.calls.filter(([url]) =>
        url.endsWith(`/onboarding-sessions/${onboardingRef}`)).length;
      const createCallsBeforeSwitch = harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions')).length;
      const actionCallsBeforeSwitch = harness.post.mock.calls.filter(([url]) => url.endsWith('/actions')).length;

      // Change only the mocked /session response; no browser storage or cross-tab API is used.
      harness.setTenantContextRef('synthetic-other-tenant-context-reference-456');
      await harness.service.recover(onboardingRef, { action: 'REAUTHORIZE', stage: 'authorization' });

      expect(harness.get.mock.calls.filter(([url]) => url.endsWith('/integrations/flows')))
        .toHaveLength(profileReadsBeforeSwitch);
      expect(harness.get.mock.calls.filter(([url]) => url.endsWith(`/onboarding-sessions/${onboardingRef}`)))
        .toHaveLength(statusReadsBeforeSwitch);
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions')))
        .toHaveLength(createCallsBeforeSwitch);
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/actions')))
        .toHaveLength(actionCallsBeforeSwitch);
      expect(harness.service.getSnapshot().attempts).toHaveLength(1);
      expect(harness.service.getSnapshot().attempts[0]?.onboardingRef).toBe(onboardingRef);
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('partial');
      expect(harness.service.getSnapshot().attempts[0]?.replacementOnboardingRef).toBeUndefined();
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('keeps PARTIAL blocked through RECONCILE and preserves its pending action while RUNNING', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    const partial = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [
        { name: 'authorization', status: 'SUCCEEDED' },
        { name: 'subscription', status: 'UNKNOWN' },
      ],
      nextAction: 'RECONCILE',
    };
    const reconciling = {
      ...partial,
      status: 'PROVISIONING',
      readiness: 'UNKNOWN',
      steps: [{ name: 'subscription', status: 'RUNNING' }],
      nextAction: 'CHECK_STATUS',
    };
    const retryable = {
      ...partial,
      steps: [{ name: 'subscription', status: 'RETRY_PENDING' }],
      nextAction: 'RESUME',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partial);
      dispatchSyntheticMessage(harness.messageSource, { fixtureEvent: 'finished' });
      await flushMicrotasks();

      const attempt = harness.service.getSnapshot().attempts[0];
      expect(attempt?.state).toBe('partial');
      expect(attempt?.nextAction).toBe('RECONCILE');
      expect(attempt?.recoveryOptions).toEqual([{ action: 'RECONCILE', stage: 'subscription' }]);
      expect(harness.service.getSnapshot().canStart).toBe(false);

      harness.setStatusAfterAction(reconciling);
      await harness.service.recover(onboardingRef, { action: 'RECONCILE', stage: 'subscription' });
      const actionCall = harness.post.mock.calls.find(([url]) => url.endsWith('/actions'));
      expect(actionCall?.[0]).toBe(`/api/v1/onboarding-sessions/${onboardingRef}/actions`);
      expect(actionCall?.[1]).toEqual({ action: 'RECONCILE', stage: 'subscription' });
      expect(harness.service.getSnapshot().attempts[0]?.pendingRecovery)
        .toEqual({ action: 'RECONCILE', stage: 'subscription' });
      expect(harness.service.getSnapshot().canStart).toBe(false);

      await harness.service.start();
      expect(harness.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'))).toHaveLength(1);
      harness.setStatus(retryable);
      await harness.service.refreshAttemptStatus(onboardingRef);
      expect(harness.service.getSnapshot().attempts[0]?.nextAction).toBe('RESUME');
      expect(harness.service.getSnapshot().attempts[0]?.recoveryOptions)
        .toEqual([{ action: 'RESUME', stage: 'subscription' }]);
      expect(harness.service.getSnapshot().canStart).toBe(false);
      harness.setStatus(readyStatus);
      await harness.service.refreshAttemptStatus(onboardingRef);
      expect(harness.service.getSnapshot().canStart).toBe(true);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('keeps provider messages isolated between two service instances/tabs', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const sourceA = {} as MessagePort;
    const sourceB = {} as MessagePort;
    const first = serviceHarness({ ref: 'onboarding-session-reference-tab-a', state: 'synthetic-state-reference-tab-a-123456', source: sourceA });
    const second = serviceHarness({ ref: 'onboarding-session-reference-tab-b', state: 'synthetic-state-reference-tab-b-123456', source: sourceB });
    try {
      await startSyntheticAttempt(first);
      await startSyntheticAttempt(second);

      dispatchSyntheticMessage(sourceA, { fixtureEvent: 'code', code: 'synthetic-code-for-tab-a' });
      await flushMicrotasks();

      expect(first.post.mock.calls.filter(([url]) => url.endsWith('/authorization-code'))).toHaveLength(1);
      expect(second.post.mock.calls.filter(([url]) => url.endsWith('/authorization-code'))).toHaveLength(0);
      expect(first.post.mock.calls.find(([url]) => url.endsWith('/authorization-code'))?.[0])
        .toBe('/api/v1/onboarding-sessions/onboarding-session-reference-tab-a/authorization-code');
      expect(first.service.getSnapshot().attempts[0]?.state).toBe('awaiting_server_confirmation');
      expect(second.service.getSnapshot().attempts[0]?.state).toBe('awaiting_provider');
    } finally {
      first.service.dispose();
      second.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('does not release a number after local cancellation until server status is terminal', async () => {
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness();
    const partial = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [{ name: 'subscription', status: 'UNKNOWN' }],
      nextAction: 'RECONCILE',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partial);
      harness.service.cancel(onboardingRef);
      await flushMicrotasks();
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('partial');
      expect(harness.service.getSnapshot().canStart).toBe(false);

      harness.setStatus({ ...partial, status: 'CANCELLED', nextAction: 'NONE' });
      await harness.service.refreshAttemptStatus(onboardingRef);
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('cancelled');
      expect(harness.service.getSnapshot().canStart).toBe(true);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.restoreAllMocks();
    }
  });

  it('keeps number creation blocked when timeout status is still PARTIAL', async () => {
    vi.useFakeTimers();
    const restoreCookie = installSyntheticCsrfCookie();
    const harness = serviceHarness({ expiresInMs: 1_000 });
    const partial = {
      ...pendingServerStatus(onboardingRef),
      status: 'PARTIAL',
      readiness: 'PARTIAL',
      steps: [{ name: 'asset-verification', status: 'RETRY_PENDING' }],
      nextAction: 'RESUME',
    };
    try {
      await startSyntheticAttempt(harness);
      harness.setStatus(partial);
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('partial');
      expect(harness.service.getSnapshot().canStart).toBe(false);

      harness.setStatus({ ...partial, status: 'EXPIRED', nextAction: 'NONE' });
      await harness.service.refreshAttemptStatus(onboardingRef);
      expect(harness.service.getSnapshot().attempts[0]?.state).toBe('expired');
      expect(harness.service.getSnapshot().canStart).toBe(true);
    } finally {
      harness.service.dispose();
      restoreCookie();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
