import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { portalApiInterceptor } from './portal-api.interceptor';
import { PortalContextStore } from './portal-context.store';

describe('portalApiInterceptor tenant identity boundary', () => {
  let client: HttpClient;
  let context: PortalContextStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([portalApiInterceptor])),
        provideHttpClientTesting(),
        { provide: META_API_BASE_URL, useValue: '/api' },
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
});
