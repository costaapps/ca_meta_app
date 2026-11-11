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
  | 'MANAGE_AUTOMATION_CONFIG'
  | 'MANAGE_MEMBERS'
  | 'GRANT_ADMIN'
  | 'READ_CREDENTIAL_METADATA'
  | 'READ_CREDENTIAL_SECRET';

export type ServiceScope =
  | 'TENANT_RESOURCE_READ'
  | 'META_CONNECTION_EXECUTE'
  | 'CREDENTIAL_USE'
  | 'NOTIFICATION_PROJECTION_WRITE'
  | 'WEBHOOK_ROUTE'
  | 'MAGIC_LINK_DELIVERY';

declare const tenantScopeBrand: unique symbol;
declare const serviceScopeBrand: unique symbol;

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
