import { HttpClient, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { portalApiInterceptor } from './portal-api.interceptor';
import { PortalContextStore } from './portal-context.store';
import { PortalSessionService } from './portal-session.service';
import { firstValueFrom } from 'rxjs';

const session = {
  sessionRef: 'synthetic-session-ref-01',
  principalRef: 'synthetic-principal-ref-01',
  tenantRef: 'synthetic-tenant-ref-01',
  roles: ['operator'],
  tenantContextRef: 'synthetic-current-context-reference-01',
  contextVersion: 1,
  requestId: 'req-synthetic-session-01',
};

describe('PortalSessionService', () => {
  let service: PortalSessionService;
  let client: HttpClient;
  let context: PortalContextStore;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([portalApiInterceptor])),
        provideHttpClientTesting(),
        { provide: META_API_BASE_URL, useValue: '/api' },
      ],
    });
    service = TestBed.inject(PortalSessionService);
    client = TestBed.inject(HttpClient);
    context = TestBed.inject(PortalContextStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads the server session with credentials and stores only its current context reference', async () => {
    const result = service.ensureCurrentSession(true);
    const request = http.expectOne('/api/v1/session');
    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.headers.has('X-Tenant-Context')).toBe(false);
    request.flush(session);

    await expect(result).resolves.toMatchObject({ tenantRef: session.tenantRef, roles: ['operator'] });
    expect(context.contextRef).toBe(session.tenantContextRef);
    expect(sessionStorage.getItem('ca.meta.portal.context-ref.v1')).toBe(session.tenantContextRef);
  });

  it('clears stale context and reloads the session without replaying the prior context', async () => {
    context.setContextRef('synthetic-old-context-reference-01');
    const result = service.ensureCurrentSession(true);
    const staleRequest = http.expectOne('/api/v1/session');
    expect(staleRequest.request.headers.get('X-Tenant-Context')).toBe('synthetic-old-context-reference-01');
    staleRequest.flush({ code: 'CONTEXT_CHANGED', requestId: 'req-context-changed-01' }, {
      status: 409,
      statusText: 'Conflict',
    });

    await Promise.resolve();
    const retry = http.expectOne('/api/v1/session');
    expect(retry.request.headers.has('X-Tenant-Context')).toBe(false);
    retry.flush({ ...session, tenantContextRef: 'synthetic-new-context-reference-02', contextVersion: 2 });

    await expect(result).resolves.toMatchObject({ contextVersion: 2 });
    expect(context.contextRef).toBe('synthetic-new-context-reference-02');
  });

  it('preserves an explicitly supplied context reference from the trusted embed exchange', async () => {
    context.setContextRef('synthetic-old-context-reference-01');
    const response = firstValueFrom(client.get('/api/v1/session', {
      headers: new HttpHeaders({ 'X-Tenant-Context': 'synthetic-exchange-context-reference-01' }),
    }));
    const request = http.expectOne('/api/v1/session');
    expect(request.request.headers.get('X-Tenant-Context')).toBe('synthetic-exchange-context-reference-01');
    request.flush(session);
    await expect(response).resolves.toEqual(session);
  });

  it('does not attach session cookies, tenant context or CSRF to an external API-looking URL', async () => {
    context.setContextRef('synthetic-current-context-reference-01');
    const response = firstValueFrom(client.get('https://external.example.invalid/api/v1/session'));
    const request = http.expectOne('https://external.example.invalid/api/v1/session');

    expect(request.request.withCredentials).toBe(false);
    expect(request.request.headers.has('X-Tenant-Context')).toBe(false);
    expect(request.request.headers.has('X-CSRF-Token')).toBe(false);
    request.flush({ ok: true });
    await expect(response).resolves.toEqual({ ok: true });
  });

  it('does not treat a missing session as authenticated', async () => {
    const result = service.ensureCurrentSession(true);
    http.expectOne('/api/v1/session').flush({ code: 'AUTH_REQUIRED' }, { status: 401, statusText: 'Unauthorized' });

    await expect(result).resolves.toBeNull();
    expect(service.current).toBeNull();
    expect(context.contextRef).toBeNull();
  });
});
