import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { PortalContextStore, readCsrfCookie } from './portal-context.store';
import { TENANT_IDENTITY_UNCONFIRMED_MESSAGE, PortalTenantIdentityService } from './portal-tenant-identity.service';

const NON_TENANT_SCOPED_POST_ENDPOINTS = new Set([
  '/auth/preauth',
  '/auth/exchanges',
  '/auth/magic-links',
  '/auth/magic-links/consume',
  '/session/logout',
]);

function apiPath(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? parsed.pathname : null;
  } catch {
    return null;
  }
}

function apiRequest(url: string, origin: string): boolean {
  const path = apiPath(url, origin);
  return path !== null && /(?:^|\/)api\/v1(?:\/|$)/.test(path);
}

function portalSessionRequest(url: string, origin: string): boolean {
  const path = apiPath(url, origin);
  return path !== null && /(?:^|\/)api\/v1\/(?!auth\/)/.test(path);
}

function pathForApiEndpoint(url: string, origin: string): string | null {
  const path = apiPath(url, origin);
  if (path === null) return null;
  const apiV1Marker = path.lastIndexOf('/api/v1');
  if (apiV1Marker < 0) return null;
  const endpoint = path.slice(apiV1Marker + '/api/v1'.length);
  return endpoint.startsWith('/') || endpoint === '' ? endpoint : null;
}

function nonTenantScopedMutation(url: string, method: string, origin: string): boolean {
  const endpoint = pathForApiEndpoint(url, origin);
  const normalizedMethod = method.toUpperCase();
  if (endpoint === null || ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return true;
  return normalizedMethod === 'POST' && NON_TENANT_SCOPED_POST_ENDPOINTS.has(endpoint);
}

function tenantScopedMutation(url: string, method: string, origin: string): boolean {
  return apiRequest(url, origin) && !nonTenantScopedMutation(url, method, origin);
}

function errorCode(error: HttpErrorResponse): string | undefined {
  const body = error.error;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : undefined;
}

export const portalApiInterceptor: HttpInterceptorFn = (request, next) => {
  const documentRef = inject(DOCUMENT);
  const origin = documentRef.location?.origin;
  if (!origin || !apiRequest(request.url, origin)) return next(request);

  if (tenantScopedMutation(request.url, request.method, origin)) {
    const capability = inject(PortalTenantIdentityService).current;
    if (!capability.confirmed) {
      return throwError(() => new HttpErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        url: request.url,
        error: {
          code: 'TENANT_IDENTITY_UNCONFIRMED',
          message: TENANT_IDENTITY_UNCONFIRMED_MESSAGE,
        },
      }));
    }
  }

  const context = inject(PortalContextStore);
  const headers = request.headers;
  let updatedHeaders = headers;

  if (portalSessionRequest(request.url, origin)) {
    const contextRef = context.contextRef;
    if (contextRef && !updatedHeaders.has('X-Tenant-Context')) {
      updatedHeaders = updatedHeaders.set('X-Tenant-Context', contextRef);
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = readCsrfCookie(documentRef.cookie);
      if (csrf) updatedHeaders = updatedHeaders.set('X-CSRF-Token', csrf);
    }
  }

  return next(request.clone({ withCredentials: true, headers: updatedHeaders })).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse) {
        const code = errorCode(error);
        if (code === 'CONTEXT_CHANGED') context.contextChanged();
        else if (error.status === 401) context.sessionExpired();
      }
      return throwError(() => error);
    }),
  );
};
