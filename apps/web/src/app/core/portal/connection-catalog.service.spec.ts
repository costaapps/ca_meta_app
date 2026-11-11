import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { ConnectionCatalogService } from './connection-catalog.service';

describe('ConnectionCatalogService', () => {
  let service: ConnectionCatalogService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: META_API_BASE_URL, useValue: '/api' },
      ],
    });
    service = TestBed.inject(ConnectionCatalogService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends product, modality, status, exact number and opaque cursor to server pagination', async () => {
    const result = service.list({
      channel: 'WHATSAPP', flowVariant: 'WHATSAPP_COEXISTENCE', status: 'PARTIAL', number: '+15555550123',
    }, 'opaque-server-cursor-0001');
    const request = http.expectOne((candidate) => candidate.url === '/api/v1/connections');

    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe('25');
    expect(request.request.params.get('channel')).toBe('WHATSAPP');
    expect(request.request.params.get('flowVariant')).toBe('WHATSAPP_COEXISTENCE');
    expect(request.request.params.get('status')).toBe('PARTIAL');
    expect(request.request.params.get('number')).toBe('+15555550123');
    expect(request.request.params.get('cursor')).toBe('opaque-server-cursor-0001');
    request.flush({ items: [], nextCursor: null, requestId: 'req-synthetic-list-01' });
    await expect(result).resolves.toMatchObject({ items: [], requestId: 'req-synthetic-list-01' });
  });

  it('uses the internal asset id for refresh and follows only a server-issued job id', async () => {
    const internalAssetId = '00000000-0000-4000-8000-000000000021';
    const refresh = service.refresh(internalAssetId);
    const refreshRequest = http.expectOne(`/api/v1/assets/${internalAssetId}/refresh`);
    expect(refreshRequest.request.method).toBe('POST');
    refreshRequest.flush({ jobId: '00000000-0000-4000-8000-000000000022', status: 'PENDING', location: '/api/v1/jobs/00000000-0000-4000-8000-000000000022', requestId: 'req-synthetic-refresh-01' });
    const accepted = await refresh;

    const status = service.job(accepted.jobId);
    const jobRequest = http.expectOne(`/api/v1/jobs/${accepted.jobId}`);
    expect(jobRequest.request.method).toBe('GET');
    jobRequest.flush({
      id: accepted.jobId, type: 'ASSET_REFRESH', status: 'RUNNING', attempts: 1, updatedAt: '2026-11-10T10:00:00Z', requestId: 'req-synthetic-job-01',
    });
    await expect(status).resolves.toMatchObject({ id: accepted.jobId, status: 'RUNNING' });
  });
});
