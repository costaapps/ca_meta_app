import { HttpErrorResponse } from '@angular/common/http';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function safeRequestId(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const header = error.headers.get('X-Request-Id');
  if (header && SAFE_REQUEST_ID.test(header)) return header;
  const body = error.error;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const requestId = (body as Record<string, unknown>)['requestId'];
  return typeof requestId === 'string' && SAFE_REQUEST_ID.test(requestId) ? requestId : null;
}
