import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { PortalContextStore, readCsrfCookie } from './portal-context.store';

function apiPath(url: string): string {
  try {
    return new URL(url, 'https://portal.invalid').pathname;
  } catch {
    return url;
  }
}

function apiRequest(url: string): boolean {
  return /(?:^|\/)api\/v1(?:\/|$)/.test(apiPath(url));
}

function portalSessionRequest(url: string): boolean {
  const path = apiPath(url);
  return /(?:^|\/)api\/v1\/(?!auth\/)/.test(path);
}

function errorCode(error: HttpErrorResponse): string | undefined {
  const body = error.error;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : undefined;
}

export const portalApiInterceptor: HttpInterceptorFn = (request, next) => {
  if (!apiRequest(request.url)) return next(request);

  const context = inject(PortalContextStore);
  const documentRef = inject(DOCUMENT);
  const headers = request.headers;
  let updatedHeaders = headers;

  if (portalSessionRequest(request.url)) {
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
