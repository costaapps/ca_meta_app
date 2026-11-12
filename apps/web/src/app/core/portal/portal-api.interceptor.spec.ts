import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { portalApiInterceptor } from './portal-api.interceptor';
import { PortalContextStore } from './portal-context.store';
import { PortalTenantIdentityService, type TenantMutationCapability } from './portal-tenant-identity.service';

describe('portalApiInterceptor tenant identity boundary', () => {
  let client: HttpClient;
  let context: PortalContextStore;
  let http: HttpTestingController;
  let currentCapability: TenantMutationCapability;

  beforeEach(() => {
    currentCapability = Object.freeze({
      confirmed: false,
      reason: 'TENANT_IDENTITY_UNCONFIRMED',
      message: 'Identidade da empresa não confirmada',
    });
    const identity = { get current(): TenantMutationCapability { return currentCapability; } };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([portalApiInterceptor])),
        provideHttpClientTesting(),
        { provide: META_API_BASE_URL, useValue: '/api' },
        { provide: PortalTenantIdentityService, useValue: identity as unknown as PortalTenantIdentityService },
      ],
    });
    client = TestBed.inject(HttpClient);
    context = TestBed.inject(PortalContextStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('blocks tenant-scoped mutations before transport when identity is unconfirmed', async () => {
    context.setContextRef('synthetic-current-context-reference-01');
    const onboarding = firstValueFrom(client.post('/api/v1/onboarding-sessions', { flowVariant: 'WHATSAPP_COEXISTENCE' }));
    const tenantSwitch = firstValueFrom(client.post('/api/v1/session/tenant-switch', { tenantRef: 'synthetic-other-tenant' }));

    const blockedError = {
      status: 403,
      error: { code: 'TENANT_IDENTITY_UNCONFIRMED', message: 'Identidade da empresa não confirmada' },
    };
    await expect(onboarding).rejects.toMatchObject(blockedError);
    await expect(tenantSwitch).rejects.toMatchObject(blockedError);
    http.expectNone('/api/v1/onboarding-sessions');
    http.expectNone('/api/v1/session/tenant-switch');
  });

  it('keeps authenticated server-scoped reads available', async () => {
    const result = firstValueFrom(client.get('/api/v1/connections'));
    const request = http.expectOne('/api/v1/connections');

    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBe(true);
    request.flush({ items: [], requestId: 'synthetic-read-request-123' });
    await expect(result).resolves.toEqual({ items: [], requestId: 'synthetic-read-request-123' });
  });

  it('allows public magic-link issuance without tenant context or CSRF', async () => {
    context.setContextRef('synthetic-current-context-reference-01');
    const result = firstValueFrom(client.post('/api/v1/auth/magic-links', { email: 'user@synthetic.invalid' }));
    const request = http.expectOne('/api/v1/auth/magic-links');

    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.headers.has('X-Tenant-Context')).toBe(false);
    expect(request.request.headers.has('X-CSRF-Token')).toBe(false);
    request.flush({ accepted: true });
    await expect(result).resolves.toEqual({ accepted: true });

    const logout = firstValueFrom(client.post('/api/v1/session/logout', null));
    const logoutRequest = http.expectOne('/api/v1/session/logout');
    expect(logoutRequest.request.method).toBe('POST');
    logoutRequest.flush(null);
    await expect(logout).resolves.toBeNull();
  });

  it('allows exact preauth and exchange paths while blocking adjacent auth paths', async () => {
    const preauth = firstValueFrom(client.post('/api/v1/auth/preauth', { synthetic: true }));
    const exchange = firstValueFrom(client.post('/api/v1/auth/exchanges', { synthetic: true }));
    const consume = firstValueFrom(client.post('/api/v1/auth/magic-links/consume', { synthetic: true }));
    const adjacent = firstValueFrom(client.post('/api/v1/auth/magic-links/extra', { synthetic: true }));

    const preauthRequest = http.expectOne('/api/v1/auth/preauth');
    const exchangeRequest = http.expectOne('/api/v1/auth/exchanges');
    const consumeRequest = http.expectOne('/api/v1/auth/magic-links/consume');
    preauthRequest.flush({ accepted: true });
    exchangeRequest.flush({ accepted: true });
    consumeRequest.flush({ accepted: true });
    await expect(preauth).resolves.toEqual({ accepted: true });
    await expect(exchange).resolves.toEqual({ accepted: true });
    await expect(consume).resolves.toEqual({ accepted: true });
    await expect(adjacent).rejects.toMatchObject({
      error: { code: 'AUTH_MUTATION_NOT_ALLOWLISTED' },
    });
    http.expectNone('/api/v1/auth/magic-links/extra');
  });

  it('permanently blocks cross-origin legacy writes even after tenant identity is confirmed', async () => {
    currentCapability = Object.freeze({
      confirmed: true,
      tenantDisplayName: 'Synthetic company display name',
      source: 'server-session',
    });
    const legacyMutation = firstValueFrom(client.post('https://msg4.app/meta/auth/save_auto_reply', { synthetic: true }));
    const adjacentAuthMutation = firstValueFrom(client.post('/api/v1/auth/magic-links/extra', { synthetic: true }));

    await expect(legacyMutation).rejects.toMatchObject({
      status: 403,
      error: { code: 'CROSS_ORIGIN_MUTATION_BLOCKED' },
    });
    await expect(adjacentAuthMutation).rejects.toMatchObject({
      status: 403,
      error: { code: 'AUTH_MUTATION_NOT_ALLOWLISTED' },
    });
    http.expectNone('https://msg4.app/meta/auth/save_auto_reply');
    http.expectNone('/api/v1/auth/magic-links/extra');
  });
});
