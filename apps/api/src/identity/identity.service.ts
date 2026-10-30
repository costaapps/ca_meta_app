import { createHash, timingSafeEqual } from 'node:crypto';
import { IdentityDeniedError } from './identity.errors.js';
import type { IdentityRepository } from './identity.repository.js';
import {
  isVerifiedServiceTenantScope,
  makeVerifiedServiceTenantScope,
  type AuthorizedTenantScope,
  type MembershipRole,
  type ServiceScope,
  type TenantOperation,
  type TenantScopePredicate,
  type TenantScopedIdPredicate,
  type VerifiedServiceTenantScope,
} from './identity.types.js';
import { isVerifiedPortalSession, type VerifiedPortalSession } from './identity.trust.js';

const ALLOWED_ROLES = new Set<MembershipRole>(['owner', 'admin', 'operator', 'viewer']);
const authorizedTenantScopes = new WeakSet<object>();

interface AuthorizedTenantScopeInput {
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly roles: readonly MembershipRole[];
  readonly membershipVersion: number;
  readonly contextVersion: number;
}

/** A scope is valid only when minted inside this trusted context resolver module. */
export function isAuthorizedTenantScope(value: unknown): value is AuthorizedTenantScope {
  return typeof value === 'object' && value !== null && authorizedTenantScopes.has(value);
}

function makeAuthorizedTenantScope(input: AuthorizedTenantScopeInput): AuthorizedTenantScope {
  const roles = Object.freeze([...input.roles]);
  const scope = Object.freeze({ ...input, roles }) as AuthorizedTenantScope;
  authorizedTenantScopes.add(scope);
  return scope;
}

function validContextVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function hashTenantContextReference(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function contextReferenceMatches(expectedHash: string, presentedReference: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || presentedReference.length < 16 || presentedReference.length > 512) {
    return false;
  }
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashTenantContextReference(presentedReference), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validRoles(roles: readonly MembershipRole[]): boolean {
  return roles.length > 0 && new Set(roles).size === roles.length && roles.every((role) => ALLOWED_ROLES.has(role));
}

function assertCurrentMembership(
  membership: Awaited<ReturnType<IdentityRepository['findMembership']>>,
  principalId: string,
  tenantId: string,
): asserts membership is NonNullable<typeof membership> {
  if (
    !membership ||
    membership.principalId !== principalId ||
    membership.tenantId !== tenantId ||
    membership.principalKind !== 'USER' ||
    membership.principalStatus !== 'ACTIVE' ||
    membership.tenantStatus !== 'ACTIVE' ||
    membership.status !== 'ACTIVE' ||
    !validRoles(membership.roles)
  ) {
    throw new IdentityDeniedError();
  }
}

export class TenantContextService {
  constructor(private readonly repository: IdentityRepository) {}

  async resolveCurrent(
    session: VerifiedPortalSession,
    presentedTenantContext: string | undefined,
  ): Promise<AuthorizedTenantScope> {
    this.assertCurrentReference(session, presentedTenantContext);
    const membership = await this.repository.findMembership(session.principalId, session.tenantId);
    assertCurrentMembership(membership, session.principalId, session.tenantId);
    return makeAuthorizedTenantScope({
      principalId: session.principalId,
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      roles: membership.roles,
      membershipVersion: membership.version,
      contextVersion: session.contextVersion,
    });
  }

  /** Resolve the destination only; M3.04 persists the session CAS/context-ref rotation. */
  async resolveTenantSwitch(
    session: VerifiedPortalSession,
    presentedTenantContext: string | undefined,
    requestedTenantId: string,
  ): Promise<AuthorizedTenantScope> {
    this.assertCurrentReference(session, presentedTenantContext);
    if (!requestedTenantId || requestedTenantId === session.tenantId) {
      if (requestedTenantId === session.tenantId) return this.resolveCurrent(session, presentedTenantContext);
      throw new IdentityDeniedError();
    }
    const membership = await this.repository.findMembership(session.principalId, requestedTenantId);
    assertCurrentMembership(membership, session.principalId, requestedTenantId);
    return makeAuthorizedTenantScope({
      principalId: session.principalId,
      sessionId: session.sessionId,
      tenantId: membership.tenantId,
      roles: membership.roles,
      membershipVersion: membership.version,
      contextVersion: session.contextVersion + 1,
    });
  }

  async listCurrentMemberships(principalId: string): Promise<readonly { tenantId: string; roles: readonly MembershipRole[] }[]> {
    const memberships = await this.repository.listActiveMemberships(principalId);
    return memberships
      .filter((membership) =>
        membership.principalId === principalId &&
        membership.principalKind === 'USER' &&
        membership.principalStatus === 'ACTIVE' &&
        membership.tenantStatus === 'ACTIVE' &&
        membership.status === 'ACTIVE' &&
        validRoles(membership.roles))
      .map((membership) => Object.freeze({ tenantId: membership.tenantId, roles: Object.freeze([...membership.roles]) }));
  }

  /** Rebuilds job authority from persisted tenant/principal IDs and the current membership. */
  async resolveJobContext(job: { readonly tenantId?: unknown; readonly principalId?: unknown }): Promise<AuthorizedTenantScope> {
    if (typeof job.tenantId !== 'string' || !job.tenantId || typeof job.principalId !== 'string' || !job.principalId) {
      throw new IdentityDeniedError();
    }
    const membership = await this.repository.findMembership(job.principalId, job.tenantId);
    assertCurrentMembership(membership, job.principalId, job.tenantId);
    return makeAuthorizedTenantScope({
      principalId: job.principalId,
      sessionId: 'server-job',
      tenantId: job.tenantId,
      roles: membership.roles,
      membershipVersion: membership.version,
      contextVersion: 1,
    });
  }

  private assertCurrentReference(session: VerifiedPortalSession, presented: string | undefined): void {
    if (
      !isVerifiedPortalSession(session) ||
      !session.sessionId ||
      !session.principalId ||
      !session.tenantId ||
      !validContextVersion(session.contextVersion) ||
      !presented ||
      !contextReferenceMatches(session.contextRefHash, presented)
    ) {
      throw new IdentityDeniedError('CONTEXT_CHANGED');
    }
  }
}

const ROLE_PERMISSIONS: Readonly<Record<TenantOperation, readonly MembershipRole[]>> = {
  TENANT_READ: ['owner', 'admin', 'operator', 'viewer'],
  RESOURCE_READ: ['owner', 'admin', 'operator', 'viewer'],
  CONNECT: ['owner', 'admin', 'operator'],
  REAUTHORIZE: ['owner', 'admin', 'operator'],
  DISCONNECT: ['owner', 'admin'],
  REPLAY_EVENT: ['owner', 'admin', 'operator'],
  MANAGE_MEMBERS: ['owner', 'admin'],
  GRANT_ADMIN: ['owner'],
  READ_CREDENTIAL_METADATA: ['owner', 'admin'],
  READ_CREDENTIAL_SECRET: [],
};

export class TenantAuthorizationService {
  constructor(private readonly repository: IdentityRepository) {}

  async authorize(
    scope: AuthorizedTenantScope,
    operation: TenantOperation,
    resourceTenantId: string,
  ): Promise<void> {
    if (!isAuthorizedTenantScope(scope) || resourceTenantId !== scope.tenantId) throw new IdentityDeniedError();
    const membership = await this.repository.findMembership(scope.principalId, scope.tenantId);
    assertCurrentMembership(membership, scope.principalId, scope.tenantId);
    if (
      membership.version !== scope.membershipVersion ||
      [...membership.roles].sort().join('|') !== [...scope.roles].sort().join('|')
    ) {
      throw new IdentityDeniedError('CONTEXT_CHANGED');
    }
    const allowedRoles = ROLE_PERMISSIONS[operation];
    if (!scope.roles.some((role) => allowedRoles.includes(role))) throw new IdentityDeniedError();
  }
}

export class ServiceTenantAuthorizationService {
  constructor(private readonly repository: IdentityRepository) {}

  async resolveScope(principalId: string, tenantId: string): Promise<VerifiedServiceTenantScope> {
    const grant = await this.repository.findServiceTenantGrant(principalId, tenantId);
    if (
      !grant ||
      grant.principalId !== principalId ||
      grant.tenantId !== tenantId ||
      grant.principalKind !== 'SERVICE' ||
      grant.principalStatus !== 'ACTIVE' ||
      grant.tenantStatus !== 'ACTIVE' ||
      grant.scopes.length === 0
    ) {
      throw new IdentityDeniedError();
    }
    return makeVerifiedServiceTenantScope({ principalId, tenantId, scopes: grant.scopes });
  }

  async authorize(scope: VerifiedServiceTenantScope, requiredScope: ServiceScope, resourceTenantId: string): Promise<void> {
    if (!isVerifiedServiceTenantScope(scope) || scope.tenantId !== resourceTenantId || !scope.scopes.includes(requiredScope)) {
      throw new IdentityDeniedError();
    }
    const grant = await this.repository.findServiceTenantGrant(scope.principalId, scope.tenantId);
    if (
      !grant ||
      grant.principalKind !== 'SERVICE' ||
      grant.principalStatus !== 'ACTIVE' ||
      grant.tenantStatus !== 'ACTIVE' ||
      !grant.scopes.includes(requiredScope)
    ) {
      throw new IdentityDeniedError();
    }
  }
}

export async function resolveLegacyMappingForTenant(
  repository: IdentityRepository,
  scope: AuthorizedTenantScope,
  legacyDatabaseId: string,
  legacyCompanyId: string,
  environment: string,
): Promise<{ readonly tenantId: string; readonly legacyDatabaseId: string; readonly legacyCompanyId: string; readonly environment: string }> {
  if (!isAuthorizedTenantScope(scope) || !legacyDatabaseId || !legacyCompanyId || !environment) {
    throw new IdentityDeniedError();
  }
  const mapping = await repository.findLegacyTenantMapping(
    scope.tenantId,
    legacyDatabaseId,
    legacyCompanyId,
    environment,
  );
  if (!mapping || mapping.tenantId !== scope.tenantId) throw new IdentityDeniedError();
  return Object.freeze({ ...mapping });
}

export function tenantScopePredicate(scope: AuthorizedTenantScope): TenantScopePredicate {
  if (!isAuthorizedTenantScope(scope)) throw new IdentityDeniedError();
  return Object.freeze({ sql: 'tenant_id = ?', values: [scope.tenantId] as const });
}

export function tenantScopedIdPredicate(scope: AuthorizedTenantScope, resourceId: string): TenantScopedIdPredicate {
  if (!isAuthorizedTenantScope(scope) || !resourceId) throw new IdentityDeniedError();
  return Object.freeze({ sql: 'id = ? AND tenant_id = ?', values: [resourceId, scope.tenantId] as const });
}

export function requireJobTenant(job: { readonly tenantId?: unknown }): string {
  if (typeof job.tenantId !== 'string' || job.tenantId.length === 0) throw new IdentityDeniedError();
  return job.tenantId;
}
