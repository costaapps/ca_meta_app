import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { components } from '@ca-meta/contracts';
import { META_API_BASE_URL } from '../config/public-runtime-config';
import { AutomationConfigService } from './automation-config.service';

type AutomationConfig = components['schemas']['AutomationConfig'];

describe('AutomationConfigService', () => {
  let service: AutomationConfigService;
  let http: HttpTestingController;

  const config: AutomationConfig = {
    assetId: '00000000-0000-4000-8000-000000000051',
    assetKind: 'WHATSAPP_PHONE_NUMBER',
    inheritanceMode: 'ASSET_ONLY',
    supportedFields: ['privateWelcomeMessage'],
    privateWelcomeMessage: null,
    commentPublicReply: null,
    commentPrivateReply: null,
    capabilities: { canEdit: true, executable: false },
    version: 0,
    updatedAt: null,
    projectionState: 'UNKNOWN',
    requestId: 'req-synthetic-automation-ui-01',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: META_API_BASE_URL, useValue: '/api' },
      ],
    });
    service = TestBed.inject(AutomationConfigService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('uses the internal asset endpoint and enforces response ETag versioning for reads and updates', async () => {
    const loaded = service.read(config.assetId);
    const readRequest = http.expectOne(`/api/v1/assets/${config.assetId}/automation-config`);
    expect(readRequest.request.method).toBe('GET');
    readRequest.flush(config, { headers: { ETag: '"automation-v0"' } });
    const current = await loaded;
    expect(current.etag).toBe('"automation-v0"');

    const update = { version: 0, privateWelcomeMessage: 'Synthetic portal value' };
    const saving = service.update(config.assetId, update, current.etag);
    const updateRequest = http.expectOne(`/api/v1/assets/${config.assetId}/automation-config`);
    expect(updateRequest.request.method).toBe('PATCH');
    expect(updateRequest.request.headers.get('If-Match')).toBe('"automation-v0"');
    expect(updateRequest.request.body).toEqual(update);
    updateRequest.flush({ ...config, privateWelcomeMessage: update.privateWelcomeMessage, version: 1 }, {
      headers: { ETag: '"automation-v1"' },
    });
    await expect(saving).resolves.toMatchObject({ etag: '"automation-v1"', config: { version: 1 } });
  });

  it('rejects a response whose ETag does not match the body version', async () => {
    const loaded = service.read(config.assetId);
    const request = http.expectOne(`/api/v1/assets/${config.assetId}/automation-config`);
    request.flush(config, { headers: { ETag: '"automation-v1"' } });
    await expect(loaded).rejects.toThrow('The automation config response is incomplete.');
  });
});
