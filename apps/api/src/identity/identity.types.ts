export type PrincipalKind = 'USER' | 'SERVICE';
export type PrincipalStatus = 'ACTIVE' | 'DISABLED';
export type TenantStatus = 'ACTIVE' | 'SUSPENDED';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'REVOKED' | 'SUSPENDED';
export type MembershipRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface PrincipalIdentity {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly issuer: string;
  readonly subject: string;
  readonly status: PrincipalStatus;
  readonly version: number;
}

export interface TenantMembership {
  readonly tenantId: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly principalStatus: PrincipalStatus;
  readonly tenantStatus: TenantStatus;
  readonly roles: readonly MembershipRole[];
  readonly status: MembershipStatus;
  readonly version: number;
}

export type TenantOperation =
  | 'TENANT_READ'
  | 'RESOURCE_READ'
  | 'CONNECT'
  | 'REAUTHORIZE'
  | 'DISCONNECT'
  | 'REPLAY_EVENT'
  | 'MANAGE_MEMBERS'
  | 'GRANT_ADMIN'
  | 'READ_CREDENTIAL_METADATA'
  | 'READ_CREDENTIAL_SECRET';

export type ServiceScope =
  | 'TENANT_RESOURCE_READ'
  | 'META_CONNECTION_EXECUTE'
  | 'CREDENTIAL_USE'
  | 'WEBHOOK_ROUTE'
  | 'MAGIC_LINK_DELIVERY';

const tenantScopeBrand: unique symbol = Symbol('authorized-tenant-scope');
const serviceScopeBrand: unique symbol = Symbol('verified-service-tenant-scope');

/**
 * A context minted after the current session and membership have been checked.
 * Its runtime brand prevents request DTOs and raw UUIDs from acting as a scope.
 */
export interface AuthorizedTenantScope {
  readonly [tenantScopeBrand]: true;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly roles: readonly MembershipRole[];
  readonly membershipVersion: number;
  readonly contextVersion: number;
}

export interface TenantScopePredicate {
  readonly sql: 'tenant_id = ?';
  readonly values: readonly [string];
}

export interface TenantScopedIdPredicate {
  readonly sql: 'id = ? AND tenant_id = ?';
  readonly values: readonly [string, string];
}

export interface ServiceTenantGrant {
  readonly tenantId: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly principalStatus: PrincipalStatus;
  readonly tenantStatus: TenantStatus;
  readonly scopes: readonly ServiceScope[];
}

export interface VerifiedServiceTenantScope {
  readonly [serviceScopeBrand]: true;
  readonly principalId: string;
  readonly tenantId: string;
  readonly scopes: readonly ServiceScope[];
}

export function isAuthorizedTenantScope(value: unknown): value is AuthorizedTenantScope {
  return typeof value === 'object' && value !== null && tenantScopeBrand in value;
}

export function makeAuthorizedTenantScope(input: Omit<AuthorizedTenantScope, typeof tenantScopeBrand>): AuthorizedTenantScope {
  const roles = Object.freeze([...input.roles]);
  return Object.freeze({ ...input, roles, [tenantScopeBrand]: true as const });
}

export function isVerifiedServiceTenantScope(value: unknown): value is VerifiedServiceTenantScope {
  return typeof value === 'object' && value !== null && serviceScopeBrand in value;
}

export function makeVerifiedServiceTenantScope(input: Omit<VerifiedServiceTenantScope, typeof serviceScopeBrand>): VerifiedServiceTenantScope {
  return Object.freeze({ ...input, scopes: Object.freeze([...input.scopes]), [serviceScopeBrand]: true as const });
}
