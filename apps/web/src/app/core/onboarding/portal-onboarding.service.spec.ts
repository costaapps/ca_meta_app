import { HttpErrorResponse, type HttpClient, type HttpHeaders } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { parseOnboardingFlowCatalog, type OnboardingFlowProfile } from './onboarding-flow-catalog';
import { OnboardingSessionStore } from './onboarding-session-store';
import {
  parseOnboardingServerStatus,
  PortalOnboardingService,
  type OnboardingServerStatus,
} from './portal-onboarding.service';
import type { OnboardingProviderLaunchAdapter, PreparedOnboardingPopup } from './onboarding-provider-launch';
import type { OnboardingTenantIdentityReader } from './onboarding-tenant-identity';

const tenantContextRef = 'synthetic-tenant-context-reference-123';
const onboardingIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

class MemorySessionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function makeDocument(): { documentRef: Document; storage: MemorySessionStorage; listeners: Map<string, EventListener> } {
  const storage = new MemorySessionStorage();
  const listeners = new Map<string, EventListener>();
  let keyIndex = 0;
  const windowRef = {
    sessionStorage: storage,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++keyIndex).padStart(12, '0')}` },
    addEventListener: (name: string, listener: EventListener) => { listeners.set(name, listener); },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  };
  const documentRef = {
    defaultView: windowRef,
    cookie: '__Host-ca_meta_csrf=synthetic-csrf-token-12345678901234567890',
    location: { origin: 'https://portal.synthetic.invalid' },
  } as unknown as Document;
  return { documentRef, storage, listeners };
}

function catalog(): unknown {
  return {
    requestId: 'req-catalog-1234567890',
    manifestVersion: 'm4.04-2026-11-10.1',
    profiles: [
      ['FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS'],
      ['INSTAGRAM', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'],
      ['INSTAGRAM', 'INSTAGRAM_LOGIN'],
      ['WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP'],
      ['WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING'],
    ].map(([flowVariant, authVariant]) => ({
      flowVariant,
      authVariant,
      enabled: true,
      reasonCode: null,
      capabilities: [
        { operation: 'READ_STATUS', enabled: true, reasonCode: null },
        { operation: 'SEND_MESSAGE', enabled: true, reasonCode: null },
      ],
    })),
  };
}

function flowList(): unknown {
  return {
    requestId: 'req-flows-1234567890',
    truncated: false,
    items: [
      'FACEBOOK_LOGIN',
      'INSTAGRAM_VIA_FACEBOOK_LOGIN',
      'INSTAGRAM_LOGIN',
      'WHATSAPP_CLOUD_API',
      'WHATSAPP_COEXISTENCE',
    ].map((variant) => ({
      variant,
      flowVariant: variant === 'FACEBOOK_LOGIN' ? 'FACEBOOK' :
        variant.startsWith('INSTAGRAM_') ? 'INSTAGRAM' :
          variant === 'WHATSAPP_CLOUD_API' ? 'WHATSAPP_EXCLUSIVE' : 'WHATSAPP_COEXISTENCE',
      enabled: true,
      availability: 'AVAILABLE',
      requestedCapabilities: ['READ_STATUS'],
    })),
  };
}

function serverStatus(
  id: string,
  status: 'READY' | 'PROVISIONING' | 'PARTIAL' = 'READY',
  flowVariant: OnboardingServerStatus['flowVariant'] = 'WHATSAPP_COEXISTENCE',
): OnboardingServerStatus {
  const steps = status === 'READY'
    ? ['authorization', 'asset-verification', 'subscription', 'projection'].map((name) => ({ name, status: 'SUCCEEDED' }))
    : status === 'PARTIAL'
      ? [
        { name: 'authorization', status: 'SUCCEEDED' },
        { name: 'asset-verification', status: 'SUCCEEDED' },
        { name: 'subscription', status: 'RETRY_PENDING' },
        { name: 'projection', status: 'PENDING' },
      ]
      : [
        { name: 'authorization', status: 'SUCCEEDED' },
        { name: 'asset-verification', status: 'RUNNING' },
      ];
  const value = {
    id,
    flowVariant,
    status,
    readiness: status === 'READY' ? 'READY' : status === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN',
    steps,
    nextAction: status === 'READY' ? 'NONE' : status === 'PARTIAL' ? 'RESUME' : 'CHECK_STATUS',
    lastUpdatedAt: new Date().toISOString(),
    requestId: 'req-status-1234567890',
  };
  const parsed = parseOnboardingServerStatus(value, id);
  if (!parsed) throw new Error('test status fixture is invalid');
  return parsed;
}

function fakePopup(): PreparedOnboardingPopup {
  return {
    source: {} as Window,
    navigate: vi.fn(() => true),
    isClosed: vi.fn(() => false),
    close: vi.fn(),
  };
}

function createHarness(options?: {
  capability?: OnboardingTenantIdentityReader;
  providerEnabled?: boolean;
  refs?: readonly { id: string; expiresAt: string }[];
  statuses?: Map<string, OnboardingServerStatus>;
}) {
  const { documentRef, storage, listeners } = makeDocument();
  const store = new OnboardingSessionStore(documentRef);
  for (const ref of options?.refs ?? []) store.remember(ref.id, ref.expiresAt, tenantContextRef);
  let createIndex = 0;
  const statuses = options?.statuses ?? new Map<string, OnboardingServerStatus>();
  const createdFlows = new Map<string, OnboardingServerStatus['flowVariant']>();
  const statusFailures = new Map<string, number>();
  const popup = fakePopup();
  const providerLaunch: OnboardingProviderLaunchAdapter = {
    prepare: vi.fn(() => popup),
    isAllowed: (url) => url.origin === 'https://provider.synthetic.invalid' && url.searchParams.getAll('state').length === 1,
  };
  const http = {
    get: vi.fn((url: string, _options?: { readonly withCredentials?: boolean; readonly headers?: HttpHeaders }) => {
      if (url.endsWith('/meta/bootstrap')) return of(catalog());
      if (url.endsWith('/integrations/flows')) return of(flowList());
      if (url.endsWith('/session')) return of({ tenantContextRef });
      const onboarding = url.match(/\/onboarding-sessions\/([^/?]+)$/)?.[1];
      if (onboarding) {
        const id = decodeURIComponent(onboarding);
        const failure = statusFailures.get(id);
        if (failure !== undefined) return throwError(() => ({ status: failure }));
        return of(statuses.get(id) ?? serverStatus(id, 'READY', createdFlows.get(id)));
      }
      if (url.includes('/jobs/')) return of({
        id: 'job-11111111', status: 'SUCCEEDED', operation: 'ONBOARDING_RECOVERY',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextAction: 'NONE', requestId: 'req-job-1234567890',
      });
      throw new Error(`unexpected GET ${url}`);
    }),
    post: vi.fn((url: string, body?: unknown, _options?: { readonly withCredentials?: boolean; readonly headers?: HttpHeaders }) => {
      if (url.endsWith('/onboarding-sessions')) {
        const id = onboardingIds[createIndex++ % onboardingIds.length];
        if (body && typeof body === 'object' && 'flowVariant' in body && typeof body.flowVariant === 'string') {
          createdFlows.set(id, body.flowVariant as OnboardingServerStatus['flowVariant']);
        }
        return of({
          id,
          status: 'AWAITING_PROVIDER',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          launchUrl: 'https://provider.synthetic.invalid/authorize?state=synthetic-state-value-1234567890123456',
          requestId: `req-create-${createIndex}-1234567890`,
        });
      }
      if (url.endsWith('/actions')) return of({
        jobId: 'job-11111111', status: 'PENDING', location: '/api/v1/jobs/job-11111111', requestId: 'req-action-1234567890',
      });
      throw new Error(`unexpected POST ${url}`);
    }),
  };
  const capability: OnboardingTenantIdentityReader = options?.capability ?? {
    current: () => ({ confirmed: true, tenantDisplayName: 'Empresa sintética', source: 'server-session' }),
  };
  const service = new PortalOnboardingService(
    http as unknown as HttpClient,
    '/api',
    documentRef,
    store,
    capability,
    providerLaunch,
    options?.providerEnabled ?? true,
  );
  return { service, http, store, storage, listeners, popup, providerLaunch, statuses, statusFailures };
}

describe('PortalOnboardingService', () => {
  it('preserves all five exact auth variants while presenting four product families', () => {
    const parsed = parseOnboardingFlowCatalog(catalog(), flowList());
    expect(parsed?.map((profile) => profile.flowVariant)).toEqual([
      'FACEBOOK_LOGIN',
      'INSTAGRAM_VIA_FACEBOOK_LOGIN',
      'INSTAGRAM_LOGIN',
      'WHATSAPP_CLOUD_API',
      'WHATSAPP_COEXISTENCE',
    ]);
    expect(new Set(parsed?.map((profile) => profile.product)).size).toBe(4);
    expect(parsed?.every((profile) => profile.requestedCapabilities.join(',') === 'READ_STATUS')).toBe(true);
  });

  it('requires an unambiguous complete server flow list and honors its availability', () => {
    const incomplete = flowList() as { items: Array<Record<string, unknown>>; truncated: boolean };
    incomplete.items.pop();
    expect(parseOnboardingFlowCatalog(catalog(), incomplete)).toBeUndefined();

    const unavailable = flowList() as { items: Array<Record<string, unknown>> };
    unavailable.items.find((item) => item['variant'] === 'WHATSAPP_COEXISTENCE')!['availability'] = 'ADAPTER_UNAVAILABLE';
    expect(parseOnboardingFlowCatalog(catalog(), unavailable)?.find((profile) => profile.flowVariant === 'WHATSAPP_COEXISTENCE')?.enabled).toBe(false);
  });

  it('fails closed if the Coexistence profile exposes conventional phone registration', () => {
    const value = catalog() as {
      profiles: Array<{
        flowVariant: string;
        authVariant: string;
        enabled: boolean;
        reasonCode: string | null;
        capabilities: Array<{ operation: string; enabled: boolean; reasonCode: string | null }>;
      }>;
    };
    value.profiles.find((profile) => profile.flowVariant === 'WHATSAPP_COEXISTENCE')?.capabilities.push({
      operation: 'PHONE_REGISTRATION_CONVENTIONAL', enabled: true, reasonCode: null,
    });

    const coexistence = parseOnboardingFlowCatalog(value, flowList())?.find((profile) => profile.flowVariant === 'WHATSAPP_COEXISTENCE');
    expect(coexistence?.enabled).toBe(false);
    expect(coexistence?.blockedReason).toContain('registro convencional');
  });

  it('loads authoritative status after reload with GET only and never starts a popup/session automatically', async () => {
    const id = onboardingIds[0];
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { service, http, store, providerLaunch } = createHarness({ refs: [{ id, expiresAt }] });

    await service.initialize();

    expect(http.get).toHaveBeenCalledWith('/api/v1/meta/bootstrap', { withCredentials: true });
    const flowRead = http.get.mock.calls.find(([url]) => url.endsWith('/integrations/flows'));
    expect(flowRead?.[1]?.headers?.get('X-Tenant-Context')).toBe(tenantContextRef);
    expect(http.get).toHaveBeenCalledWith('/api/v1/session', { withCredentials: true });
    expect(http.get).toHaveBeenCalledWith(`/api/v1/onboarding-sessions/${id}`, expect.anything());
    expect(http.post).not.toHaveBeenCalled();
    expect(providerLaunch.prepare).not.toHaveBeenCalled();
    expect(service.getSnapshot().attempts[0]?.status?.status).toBe('READY');
    expect(store.read(tenantContextRef)).toEqual([{ id, expiresAt }]);
  });

  it('clears cached status after the server denies the current tenant context', async () => {
    const id = onboardingIds[0];
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const harness = createHarness({
      refs: [{ id, expiresAt }],
      statuses: new Map([[id, serverStatus(id)]]),
    });
    await harness.service.initialize();
    expect(harness.service.getSnapshot().attempts[0]?.status?.status).toBe('READY');

    harness.statusFailures.set(id, 403);
    await harness.service.refreshStatus(id);

    expect(harness.service.getSnapshot().attempts[0]?.status).toBeUndefined();
    expect(harness.service.getSnapshot().attempts[0]?.message).toContain('não está disponível neste contexto');
  });

  it('hides prior tenant status and sends no onboarding read after a context switch', async () => {
    const id = onboardingIds[0];
    const harness = createHarness({
      refs: [{ id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }],
      statuses: new Map([[id, serverStatus(id)]]),
    });
    await harness.service.initialize();
    expect(harness.service.getSnapshot().attempts[0]?.status?.status).toBe('READY');
    const originalGet = harness.http.get.getMockImplementation();
    const onboardingReadsBeforeSwitch = harness.http.get.mock.calls.filter(([url]) => url.includes('/onboarding-sessions/')).length;
    harness.http.get.mockImplementation((url, options) => url.endsWith('/session')
      ? of({ tenantContextRef: 'different-tenant-context-reference-456' })
      : originalGet!(url, options));

    await harness.service.refreshStatus(id);

    expect(harness.http.get.mock.calls.filter(([url]) => url.includes('/onboarding-sessions/'))).toHaveLength(onboardingReadsBeforeSwitch);
    expect(harness.service.getSnapshot().attempts).toEqual([]);
    expect(harness.store.read('different-tenant-context-reference-456')).toEqual([]);
  });

  it('blocks every write with the exact M1.08 warning while company identity is unconfirmed', async () => {
    const capability: OnboardingTenantIdentityReader = {
      current: () => ({ confirmed: false, reason: 'TENANT_IDENTITY_UNCONFIRMED', message: 'Identidade da empresa não confirmada' }),
    };
    const { service, http, providerLaunch } = createHarness({ capability });
    const profile = parseOnboardingFlowCatalog(catalog(), flowList())?.[0] as OnboardingFlowProfile;

    expect(await service.start(profile)).toBe(false);
    expect(service.getSnapshot().notice).toBe('Identidade da empresa não confirmada');
    expect(http.post).not.toHaveBeenCalled();
    expect(providerLaunch.prepare).not.toHaveBeenCalled();
  });

  it('does not submit a catalog selected under a different tenant context', async () => {
    const { service, http } = createHarness();
    await service.initialize();
    const profile = service.getSnapshot().profiles.find((item) => item.flowVariant === 'FACEBOOK_LOGIN')!;
    const originalGet = http.get.getMockImplementation();
    http.get.mockImplementation((url, options) => url.endsWith('/session')
      ? of({ tenantContextRef: 'different-tenant-context-reference-456' })
      : originalGet!(url, options));

    expect(await service.start(profile)).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
    expect(service.getSnapshot().notice).toContain('O contexto da empresa mudou');
  });

  it('opens only a blank popup synchronously from the explicit user action', async () => {
    const { service, http, providerLaunch } = createHarness();
    await service.initialize();
    const profile = service.getSnapshot().profiles.find((item) => item.flowVariant === 'FACEBOOK_LOGIN')!;

    const start = service.start(profile);

    expect(providerLaunch.prepare).toHaveBeenCalledTimes(1);
    expect(http.post).not.toHaveBeenCalled();
    expect(await start).toBe(true);
  });

  it('uses a unique session and idempotency key for each of four sequential Coexistence numbers', async () => {
    const { service, http, store } = createHarness();
    await service.initialize();
    const coexistence = service.getSnapshot().profiles.find((profile) => profile.flowVariant === 'WHATSAPP_COEXISTENCE');
    expect(coexistence).toBeDefined();

    for (let i = 0; i < 4; i += 1) expect(await service.start(coexistence!)).toBe(true);

    const createCalls = http.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'));
    expect(createCalls).toHaveLength(4);
    expect(new Set(createCalls.map(([url, body, options]) => options?.headers?.get('Idempotency-Key'))).size).toBe(4);
    expect(createCalls.map(([, body]) => body)).toEqual(Array.from({ length: 4 }, () => ({
      flowVariant: 'WHATSAPP_COEXISTENCE', requestedCapabilities: ['READ_STATUS'], returnRoute: 'connections',
    })));
    expect(store.read(tenantContextRef).map((ref) => ref.id)).toEqual(onboardingIds.slice(0, 4));
  });

  it('treats a typed server Coexistence conflict as definitive and safe to resolve', async () => {
    const { service, http, popup, store } = createHarness();
    await service.initialize();
    const coexistence = service.getSnapshot().profiles.find((item) => item.flowVariant === 'WHATSAPP_COEXISTENCE')!;
    http.post.mockImplementationOnce(() => throwError(() => new HttpErrorResponse({
      status: 409,
      error: { code: 'COEXISTENCE_SESSION_ACTIVE', safeMessage: 'A WhatsApp Coexistence onboarding session is already active for this company.' },
    })));

    expect(await service.start(coexistence)).toBe(false);
    expect(service.getSnapshot().notice).toContain('Já existe uma autorização WhatsApp Coexistence');
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(store.read(tenantContextRef)).toEqual([]);
  });

  it('does not let an unreadable prior session block a server-authorized Coexistence start', async () => {
    const existingId = onboardingIds[1];
    const { service, http, statusFailures } = createHarness({
      refs: [{ id: existingId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }],
    });
    statusFailures.set(existingId, 403);
    await service.initialize();
    const coexistence = service.getSnapshot().profiles.find((item) => item.flowVariant === 'WHATSAPP_COEXISTENCE')!;

    expect(await service.start(coexistence)).toBe(true);
    expect(http.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'))).toHaveLength(1);
    expect(http.post.mock.calls.find(([url]) => url.endsWith('/onboarding-sessions'))?.[1]).toMatchObject({
      flowVariant: 'WHATSAPP_COEXISTENCE',
    });
  });

  it('runs each product and both Instagram auth variants through distinct server sessions', async () => {
    const flowVariants: OnboardingServerStatus['flowVariant'][] = [
      'FACEBOOK_LOGIN',
      'INSTAGRAM_VIA_FACEBOOK_LOGIN',
      'INSTAGRAM_LOGIN',
      'WHATSAPP_CLOUD_API',
      'WHATSAPP_COEXISTENCE',
    ];
    const statuses = new Map(flowVariants.map((variant, index) => [
      onboardingIds[index], serverStatus(onboardingIds[index], 'PARTIAL', variant),
    ]));
    const { service, http, store } = createHarness({ statuses });
    await service.initialize();
    const profiles = service.getSnapshot().profiles;

    for (const profile of profiles) expect(await service.start(profile)).toBe(true);

    const createCalls = http.post.mock.calls.filter(([url]) => url.endsWith('/onboarding-sessions'));
    expect(createCalls.map(([, body]) => (body as { flowVariant: string }).flowVariant)).toEqual([
      'FACEBOOK_LOGIN',
      'INSTAGRAM_VIA_FACEBOOK_LOGIN',
      'INSTAGRAM_LOGIN',
      'WHATSAPP_CLOUD_API',
      'WHATSAPP_COEXISTENCE',
    ]);
    expect(new Set(createCalls.map(([, , options]) => options?.headers?.get('Idempotency-Key'))).size).toBe(5);
    expect(store.read(tenantContextRef).map((ref) => ref.id)).toEqual(onboardingIds);
    expect(service.getSnapshot().attempts.every((attempt) => attempt.status?.status === 'PARTIAL')).toBe(true);

    for (const attempt of service.getSnapshot().attempts) {
      expect(attempt.recoveryOptions).toEqual([{ action: 'RESUME', stage: 'subscription', label: 'Retomar assinaturas' }]);
      expect(await service.recover(attempt.id, attempt.recoveryOptions[0])).toBe(true);
    }
    const recoveryCalls = http.post.mock.calls.filter(([url]) => url.endsWith('/actions'));
    expect(recoveryCalls).toHaveLength(5);
    expect(recoveryCalls.map(([, body]) => body)).toEqual(Array.from({ length: 5 }, () => ({ action: 'RESUME', stage: 'subscription' })));
    expect(new Set(recoveryCalls.map(([, , options]) => options?.headers?.get('Idempotency-Key'))).size).toBe(5);
  });

  it('treats auth_success as a status hint and never as server completion', async () => {
    const id = onboardingIds[0];
    const pending = serverStatus(id, 'PROVISIONING', 'FACEBOOK_LOGIN');
    const statuses = new Map([[id, pending]]);
    // Use a fresh harness whose server always reports the pending state for this session.
    const harness = createHarness({ statuses });
    await harness.service.initialize();
    const profile = harness.service.getSnapshot().profiles.find((item) => item.flowVariant === 'FACEBOOK_LOGIN')!;
    expect(await harness.service.start(profile)).toBe(true);
    const before = harness.http.get.mock.calls.length;
    const listener = harness.listeners.get('message') as ((event: MessageEvent<unknown>) => void) | undefined;
    listener?.({ source: harness.popup.source, origin: 'https://provider.synthetic.invalid', data: { auth_success: true } } as MessageEvent<unknown>);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.http.get.mock.calls.length).toBeGreaterThan(before);
    expect(harness.service.getSnapshot().attempts[0]?.status?.status).toBe('PROVISIONING');
    expect(harness.service.getSnapshot().attempts[0]?.message).not.toContain('confirmou esta conexão');
    expect(harness.http.post).toHaveBeenCalledTimes(1);
  });

  it('detaches a closed popup without claiming server cancellation or changing prior connections', async () => {
    const id = onboardingIds[0];
    const pending = serverStatus(id, 'PROVISIONING', 'FACEBOOK_LOGIN');
    const harness = createHarness({ statuses: new Map([[id, pending]]) });
    await harness.service.initialize();
    const profile = harness.service.getSnapshot().profiles.find((item) => item.flowVariant === 'FACEBOOK_LOGIN')!;
    expect(await harness.service.start(profile)).toBe(true);

    harness.service.detachPopup(id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.popup.close).toHaveBeenCalled();
    expect(harness.http.post).toHaveBeenCalledTimes(1);
    expect(harness.http.post.mock.calls[0]?.[0]).toMatch(/onboarding-sessions$/);
    expect(harness.service.getSnapshot().attempts[0]?.status?.status).toBe('PROVISIONING');
    expect(harness.service.getSnapshot().attempts[0]?.message).toContain('não cancela a sessão do servidor');
  });

  it('offers only the recovery action and stage returned by the server', async () => {
    const id = onboardingIds[0];
    const partial = serverStatus(id, 'PARTIAL');
    const { service, http } = createHarness({
      refs: [{ id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }],
      statuses: new Map([[id, partial]]),
    });
    await service.initialize();
    const attempt = service.getSnapshot().attempts[0];
    expect(attempt?.recoveryOptions).toEqual([{ action: 'RESUME', stage: 'subscription', label: 'Retomar assinaturas' }]);

    expect(await service.recover(id, attempt!.recoveryOptions[0])).toBe(true);
    const actionCall = http.post.mock.calls.find(([url]) => url.endsWith('/actions'));
    expect(actionCall?.[1]).toEqual({ action: 'RESUME', stage: 'subscription' });
    expect(actionCall?.[2]?.headers?.get('Idempotency-Key')).toMatch(/^[A-Fa-f0-9-]{36}$/);
  });

  it('does not rehydrate or post a recovery action after the active tenant context changes', async () => {
    const id = onboardingIds[0];
    const { service, http, store } = createHarness({
      refs: [{ id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }],
      statuses: new Map([[id, serverStatus(id, 'PARTIAL')]]),
    });
    await service.initialize();
    const option = service.getSnapshot().attempts[0]?.recoveryOptions[0];
    expect(option).toBeDefined();

    const originalGet = http.get.getMockImplementation();
    http.get.mockImplementation((url, options) => url.endsWith('/session')
      ? of({ tenantContextRef: 'different-tenant-context-reference-456' })
      : originalGet!(url, options));
    expect(await service.recover(id, option!)).toBe(false);

    expect(http.post.mock.calls.filter(([url]) => url.endsWith('/actions'))).toHaveLength(0);
    expect(service.getSnapshot().attempts).toEqual([]);
    expect(store.read('different-tenant-context-reference-456')).toEqual([]);
  });

  it('rejects a browser READY payload without all server readiness checkpoints', () => {
    const value = {
      id: onboardingIds[0], flowVariant: 'FACEBOOK_LOGIN', status: 'READY', readiness: 'READY',
      steps: [{ name: 'authorization', status: 'SUCCEEDED' }], nextAction: 'NONE',
      lastUpdatedAt: new Date().toISOString(), requestId: 'req-status-1234567890',
    };
    expect(parseOnboardingServerStatus(value, onboardingIds[0])).toBeUndefined();
  });
});
