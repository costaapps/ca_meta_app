export type CredentialResolutionErrorCode =
  | 'ACCESS_DENIED'
  | 'INTERNAL_SCOPE_DENIED'
  | 'RESOURCE_NOT_AVAILABLE'
  | 'ASSET_GRANT_MISSING'
  | 'META_PERMISSION_REQUIRED'
  | 'META_REAUTH_REQUIRED'
  | 'CONTEXT_CHANGED'
  | 'DEPENDENCY_UNAVAILABLE';

/** Safe resolver error. It never includes IDs, policy details, provider text, or credential material. */
export class CredentialResolutionError extends Error {
  constructor(readonly code: CredentialResolutionErrorCode) {
    super('The requested credential is unavailable for this operation.');
    this.name = 'CredentialResolutionError';
  }
}
