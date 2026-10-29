import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { MetaApiClientError, MetaApiClientService } from './meta-api-client.service';

describe('MetaApiClientService', () => {
  let service: MetaApiClientService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), MetaApiClientService],
    });
    service = TestBed.inject(MetaApiClientService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('returns a validated typed health response', async () => {
    const result = firstValueFrom(service.getHealth());
    const request = http.expectOne('/health');
    expect(request.request.method).toBe('GET');
    request.flush({ status: 'ok' });
    await expect(result).resolves.toEqual({ status: 'ok' });
  });

  it('normalizes a known server error and preserves its correlation id', async () => {
    const result = firstValueFrom(service.getReadiness());
    http.expectOne('/ready').flush({
      code: 'DEPENDENCY_UNAVAILABLE',
      safeMessage: 'The operation could not be confirmed yet.',
      requestId: 'e312e88f-1b2e-46de-bdbf-165773ff33df',
      retryable: true,
      action: 'CHECK_STATUS',
    }, { status: 503, statusText: 'Service Unavailable' });
    await expect(result).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      requestId: 'e312e88f-1b2e-46de-bdbf-165773ff33df',
      retryable: true,
    });
  });

  it('fails safely for unknown future codes without exposing the raw response', async () => {
    const result = firstValueFrom(service.getReadiness());
    http.expectOne('/ready').flush({
      code: 'FUTURE_PROVIDER_ERROR',
      safeMessage: 'untrusted provider text',
      requestId: 'untrusted-body-reference',
      retryable: true,
      action: 'CHECK_STATUS',
    }, {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'X-Request-Id': 'safe-correlation-ref' },
    });
    await expect(result).rejects.toMatchObject({
      code: 'UNRECOGNIZED_SERVER_ERROR',
      message: 'The service returned an error the portal could not validate.',
      requestId: 'safe-correlation-ref',
      retryable: false,
    });
  });

  it('rejects malformed success payloads and reports a stable client error', async () => {
    const result = firstValueFrom(service.getHealth());
    http.expectOne('/health').flush({ status: 'ready', access_token: 'must-not-leak' }, {
      headers: { 'X-Request-Id': 'malformed-response-request' },
    });
    await expect(result).rejects.toMatchObject({
      code: 'UNRECOGNIZED_SERVER_ERROR',
      message: 'The service returned a response the portal could not validate.',
      requestId: 'malformed-response-request',
    });
  });

  it('does not retry automatically', async () => {
    const result = firstValueFrom(service.getReadiness());
    http.expectOne('/ready').error(new ProgressEvent('error'));
    await expect(result).rejects.toBeInstanceOf(MetaApiClientError);
    http.expectNone('/ready');
  });
});
