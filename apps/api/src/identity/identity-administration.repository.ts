import type { AuthorizedTenantScope } from './identity.types.js';
import type { VerifiedIdentityAssertion, VerifiedPlatformIdentityAdmin, VerifiedPortalSession } from './identity.trust.js';

export type IdentityAdministrationReason =
  | 'INITIAL_PROVISIONING'
  | 'MEMBERSHIP_GRANT'
  | 'ROLE_CHANGE'
  | 'MEMBERSHIP_REVOCATION';

const ASSIGNABLE_MEMBERSHIP_ROLES = new Set(['admin', 'operator', 'viewer']);

export function isAssignableMembershipRole(value: unknown): value is 'admin' | 'operator' | 'viewer' {
  return typeof value === 'string' && ASSIGNABLE_MEMBERSHIP_ROLES.has(value);
}

export interface LegacyTenantMappingInput {
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
}

export function isLegacyTenantMappingInput(value: unknown): value is LegacyTenantMappingInput {
  if (typeof value !== 'object' || value === null) return false;
  const mapping = value as Record<string, unknown>;
  const databaseId = mapping.legacyDatabaseId;
  const companyId = mapping.legacyCompanyId;
  const environment = mapping.environment;
  return typeof databaseId === 'string' && databaseId.length >= 1 && databaseId.length <= 128 && /^[\x20-\x7e]+$/.test(databaseId) &&
    typeof companyId === 'string' && companyId.length >= 1 && companyId.length <= 191 && !/[\u0000-\u001f\u007f]/u.test(companyId) &&
    (environment === 'development' || environment === 'test' || environment === 'staging' || environment === 'production');
}

export type IdentityAdministrationCommand =
  | {
      readonly action: 'BOOTSTRAP_TENANT';
      readonly actor: VerifiedPlatformIdentityAdmin;
      readonly target: VerifiedIdentityAssertion;
      readonly tenantId: string;
      readonly legacyMapping: LegacyTenantMappingInput;
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
