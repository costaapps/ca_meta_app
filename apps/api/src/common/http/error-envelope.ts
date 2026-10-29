export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'RESOURCE_NOT_AVAILABLE'
  | 'ORIGIN_NOT_ALLOWED'
  | 'VALIDATION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'DEPENDENCY_UNAVAILABLE';

export type ErrorAction =
  | 'SIGN_IN'
  | 'FIX_REQUEST'
  | 'CONTACT_ADMIN'
  | 'REFRESH'
  | 'REDUCE_REQUEST'
  | 'RELOAD_PORTAL'
  | 'CHECK_STATUS';

export interface ErrorEnvelope {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly action: ErrorAction;
}

export function errorEnvelope(
  code: ErrorCode,
  safeMessage: string,
  requestId: string,
  retryable: boolean,
  action: ErrorAction,
): ErrorEnvelope {
  return { code, safeMessage, requestId, retryable, action };
}