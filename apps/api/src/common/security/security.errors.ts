export type SafeBoundaryCode = 'ORIGIN_NOT_ALLOWED' | 'CSRF_INVALID' | 'RATE_LIMITED';

/** Safe error class for HTTP boundary failures that need a stable public code. */
export class SafeBoundaryError extends Error {
  constructor(readonly code: SafeBoundaryCode) {
    super(code);
    this.name = 'SafeBoundaryError';
  }
}
