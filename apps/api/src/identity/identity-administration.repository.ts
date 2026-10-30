import type { AuthorizedTenantScope } from './identity.types.js';
import type { VerifiedIdentityAssertion, VerifiedPlatformIdentityAdmin, VerifiedPortalSession } from './identity.trust.js';

export type IdentityAdministrationReason =
  | 'INITIAL_PROVISIONING'
  | 'MEMBERSHIP_GRANT'
  | 'ROLE_CHANGE'
  | 'MEMBERSHIP_REVOCATION';

export type IdentityAdministrationCommand =
  | {
      readonly action: 'BOOTSTRAP_TENANT';
      readonly actor: VerifiedPlatformIdentityAdmin;
      readonly target: VerifiedIdentityAssertion;
      readonly tenantId: string;
      readonly reasonCode: IdentityAdministrationReason;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    }
  | {
      readonly action: 'GRANT_MEMBERSHIP';
      readonly actor: VerifiedPortalSession;
      readonly scope: AuthorizedTenantScope;
      readonly target: VerifiedIdentityAssertion;
      readonly role: 'admin' | 'operator' | 'viewer';
      readonly reasonCode: IdentityAdministrationReason;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    }
  | {
      readonly action: 'REVOKE_MEMBERSHIP';
      readonly actor: VerifiedPortalSession;
      readonly scope: AuthorizedTenantScope;
      readonly targetPrincipalId: string;
      readonly reasonCode: IdentityAdministrationReason;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    };

export interface IdentityAdministrationResult {
  readonly tenantId: string;
  readonly principalId?: string;
  readonly replayed: boolean;
}

export interface IdentityAdministrationRepository {
  execute(command: IdentityAdministrationCommand): Promise<IdentityAdministrationResult>;
}

export const IDENTITY_ADMINISTRATION_REPOSITORY = Symbol('IDENTITY_ADMINISTRATION_REPOSITORY');
