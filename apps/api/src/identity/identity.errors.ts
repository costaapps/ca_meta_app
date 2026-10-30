export type IdentityDenialCode = 'ACCESS_DENIED' | 'CONTEXT_CHANGED';

/** Safe domain error: never includes principal, tenant, asset or legacy identifiers. */
export class IdentityDeniedError extends Error {
  constructor(readonly code: IdentityDenialCode = 'ACCESS_DENIED') {
    super(code === 'CONTEXT_CHANGED' ? 'The tenant context has changed.' : 'The requested resource is unavailable.');
    this.name = 'IdentityDeniedError';
  }
}
