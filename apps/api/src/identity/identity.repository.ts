import type {
  MembershipStatus,
  MembershipRole,
  PrincipalIdentity,
  ServiceScope,
  ServiceTenantGrant,
  TenantMembership,
} from './identity.types.js';

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

export interface LegacyTenantMapping {
  readonly tenantId: string;
  readonly legacyDatabaseId: string;
  readonly legacyCompanyId: string;
  readonly environment: string;
}

export interface IdentityRepository {
  findPrincipalByIssuerSubject(issuer: string, subject: string): Promise<PrincipalIdentity | undefined>;
  findMembership(principalId: string, tenantId: string): Promise<TenantMembership | undefined>;
  listActiveMemberships(principalId: string): Promise<readonly TenantMembership[]>;
  findServiceTenantGrant(principalId: string, tenantId: string): Promise<ServiceTenantGrant | undefined>;
  findLegacyTenantMapping(
    tenantId: string,
    legacyDatabaseId: string,
    legacyCompanyId: string,
    environment: string,
  ): Promise<LegacyTenantMapping | undefined>;
}

export type MembershipRoleParser = (value: unknown) => readonly MembershipRole[];
export type MembershipStatusParser = (value: string) => MembershipStatus;
export type ServiceScopeParser = (value: unknown) => readonly ServiceScope[];
