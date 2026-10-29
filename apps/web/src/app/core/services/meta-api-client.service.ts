import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { ErrorAction, ErrorCode, ErrorEnvelope, paths } from '@ca-meta/contracts';
import { ERROR_ACTIONS } from '@ca-meta/contracts/error-actions';
import { ERROR_CODES } from '@ca-meta/contracts/error-codes';
import { ERROR_POLICIES } from '@ca-meta/contracts/error-policies';
import { catchError, map, Observable, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';

type HealthResponse = paths['/health']['get']['responses']['200']['content']['application/json'];
type ReadinessResponse = paths['/ready']['get']['responses']['200']['content']['application/json'];
type HealthValidator<T> = (value: unknown) => value is T;

export type MetaApiErrorCode = ErrorCode | 'UNRECOGNIZED_SERVER_ERROR' | 'CLIENT_TRANSPORT_ERROR';

export class MetaApiClientError extends Error {
  constructor(
    readonly code: MetaApiErrorCode,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly action: ErrorAction,
  ) {
    super(message);
    this.name = 'MetaApiClientError';
  }
}

const knownCodes = ERROR_CODES as readonly ErrorCode[];
const knownActions = ERROR_ACTIONS as readonly ErrorAction[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'action,code,requestId,retryable,safeMessage') return false;
  if (typeof value['code'] !== 'string' || !knownCodes.includes(value['code'] as ErrorCode)) return false;
  if (typeof value['action'] !== 'string' || !knownActions.includes(value['action'] as ErrorAction)) return false;
  if (typeof value['safeMessage'] !== 'string' || value['safeMessage'].length < 1 || value['safeMessage'].length > 240) return false;
  if (!isRequestId(value['requestId']) || typeof value['retryable'] !== 'boolean') return false;
  const policy = ERROR_POLICIES[value['code'] as ErrorCode];
  return !policy || (policy.retryable === value['retryable'] && policy.action === value['action']);
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return isRecord(value) && (value['status'] === 'ok' || value['status'] === 'unavailable') && Object.keys(value).length === 1;
}

function responseRequestId(headers: HttpHeaders): string {
  const requestId = headers.get('X-Request-Id');
  return isRequestId(requestId) ? requestId : '';
}

/**
 * Typed, validated client for the new Meta API. It does not proxy legacy PHP operations.
 * No retry operator is installed: callers must follow operation-specific effects and error policy.
 */
@Injectable({ providedIn: 'root' })
export class MetaApiClientService {
  private readonly baseUrl = environment.metaApiBaseUrl.replace(/\/+$/, '');

  constructor(private readonly http: HttpClient) {}

  getHealth(): Observable<HealthResponse> {
    return this.get('/health', isHealthResponse);
  }

  getReadiness(): Observable<ReadinessResponse> {
    return this.get('/ready', isHealthResponse);
  }

  private get<T>(path: '/health' | '/ready', validate: HealthValidator<T>): Observable<T> {
    return this.http.get<unknown>(`${this.baseUrl}${path}`, { observe: 'response' }).pipe(
      map((response) => {
        const value = response.body;
        if (!validate(value)) {
          throw new MetaApiClientError(
            'UNRECOGNIZED_SERVER_ERROR',
            'The service returned a response the portal could not validate.',
            responseRequestId(response.headers),
            false,
            'CONTACT_ADMIN',
          );
        }
        return value;
      }),
      catchError((error: unknown) => throwError(() => this.normalizeError(error))),
    );
  }

  private normalizeError(error: unknown): MetaApiClientError {
    if (error instanceof MetaApiClientError) return error;
    if (error instanceof HttpErrorResponse) {
      if (isErrorEnvelope(error.error)) {
        return new MetaApiClientError(
          error.error.code,
          error.error.safeMessage,
          error.error.requestId,
          error.error.retryable,
          error.error.action,
        );
      }
      const requestId = responseRequestId(error.headers);
      const unknownCode = isRecord(error.error) && typeof error.error['code'] === 'string'
        && !knownCodes.includes(error.error['code'] as ErrorCode);
      return new MetaApiClientError(
        unknownCode ? 'UNRECOGNIZED_SERVER_ERROR' : 'CLIENT_TRANSPORT_ERROR',
        unknownCode
          ? 'The service returned an error the portal could not validate.'
          : 'The service could not confirm this request.',
        requestId,
        false,
        'CONTACT_ADMIN',
      );
    }
    return new MetaApiClientError(
      'CLIENT_TRANSPORT_ERROR',
      'The service could not confirm this request.',
      '',
      false,
      'CONTACT_ADMIN',
    );
  }
}
