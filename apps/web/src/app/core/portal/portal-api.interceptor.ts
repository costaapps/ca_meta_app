import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { PortalContextStore, readCsrfCookie } from './portal-context.store';

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
