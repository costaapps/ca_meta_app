import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import type { IdentityRepository, LegacyTenantMapping } from '../src/identity/identity.repository.js';
import {
  hashTenantContextReference,
  resolveLegacyMappingForTenant,
  requireJobTenant,
  ServiceTenantAuthorizationService,
  TenantAuthorizationService,
  TenantContextService,
  tenantScopePredicate,
  tenantScopedIdPredicate,
} from '../src/identity/identity.service.js';
import type {
  MembershipRole,
  PrincipalIdentity,
  ServiceTenantGrant,
  TenantMembership,
  VerifiedPortalSession,
} from '../src/identity/identity.types.js';

const tenantA = 'tenant-a-internal';
const tenantB = 'tenant-b-internal';
const humanId = 'principal-human-internal';
const serviceId = 'principal-service-internal';
const sameExternalAssetId = 'meta-external-asset-123';

function membership(tenantId: string, roles: readonly MembershipRole[]): TenantMembership {
  return {
    tenantId,
    principalId: humanId,
    principalKind: 'USER',
    principalStatus: 'ACTIVE',
    tenantStatus: 'ACTIVE',
    roles,
    status: 'ACTIVE',
    version: 1,
  };
}

class FakeIdentityRepository implements IdentityRepository {
  readonly principal: PrincipalIdentity = {
    id: humanId,
    kind: 'USER',
    issuer: 'https://issuer.synthetic.invalid',
    subject: 'stable-subject-synthetic',
    status: 'ACTIVE',
    version: 1,
  };
  readonly memberships = new Map<string, TenantMembership>([
    [tenantA, membership(tenantA, ['operator'])],
    [tenantB, membership(tenantB, ['viewer'])],
  ]);
  serviceGrant: ServiceTenantGrant = {
    tenantId: tenantA,
    principalId: serviceId,
    principalKind: 'SERVICE',
    principalStatus: 'ACTIVE',
    tenantStatus: 'ACTIVE',
    scopes: ['CREDENTIAL_USE'],
  };
  readonly mappings: readonly LegacyTenantMapping[] = [
    { tenantId: tenantA, legacyDatabaseId: 'same-legacy-db', legacyCompanyId: 'company-a', environment: 'test' },
    { tenantId: tenantB, legacyDatabaseId: 'same-legacy-db', legacyCompanyId: 'company-b', environment: 'test' },
  ];
  membershipReads = 0;

  async findPrincipalByIssuerSubject(issuer: string, subject: string): Promise<PrincipalIdentity | undefined> {
    return issuer === this.principal.issuer && subject === this.principal.subject ? this.principal : undefined;
  }

  async findMembership(principalId: string, tenantId: string): Promise<TenantMembership | undefined> {
    this.membershipReads += 1;
    if (principalId !== humanId) return undefined;
    return this.memberships.get(tenantId);
  }

  async listActiveMemberships(principalId: string): Promise<readonly TenantMembership[]> {
    if (principalId !== humanId) return [];
    return [...this.memberships.values()].filter((row) => row.status === 'ACTIVE');
  }

  async findServiceTenantGrant(principalId: string, tenantId: string): Promise<ServiceTenantGrant | undefined> {
    return principalId === this.serviceGrant.principalId && tenantId === this.serviceGrant.tenantId
      ? this.serviceGrant
      : undefined;
  }

  async findLegacyTenantMapping(
    tenantId: string,
    legacyDatabaseId: string,
    legacyCompanyId: string,
    environment: string,
  ): Promise<LegacyTenantMapping | undefined> {
    return this.mappings.find((row) =>
      row.tenantId === tenantId &&
      row.legacyDatabaseId === legacyDatabaseId &&
      row.legacyCompanyId === legacyCompanyId &&
      row.environment === environment);
  }
}

function sessionFor(tenantId: string, contextRef: string, contextVersion = 1): VerifiedPortalSession {
  return {
    sessionId: `server-session-${tenantId}`,
    principalId: humanId,
    tenantId,
    contextVersion,
    contextRefHash: hashTenantContextReference(contextRef),
  };
}

test('tenant context is server-derived, versioned and invalidates stale tabs on tenant switch', async () => {
  const repository = new FakeIdentityRepository();
  const contexts = new TenantContextService(repository);
  const session = sessionFor(tenantA, 'synthetic-context-ref-00000001');
  const scopeA = await contexts.resolveCurrent(session, 'synthetic-context-ref-00000001');
  assert.equal(scopeA.tenantId, tenantA);
  assert.ok(Object.isFrozen(scopeA));
  assert.ok(Object.isFrozen(scopeA.roles));

  const scopeB = await contexts.resolveTenantSwitch(
    session,
    'synthetic-context-ref-00000001',
    tenantB,
  );
  assert.equal(scopeB.tenantId, tenantB);
  assert.equal(scopeB.contextVersion, 2);
  assert.equal(session.tenantId, tenantA, 'switch resolution does not rewrite a session or existing onboarding/job tenant');
  await assert.rejects(
    contexts.resolveCurrent(session, 'synthetic-context-ref-stale-000000'),
    (error: unknown) => error instanceof IdentityDeniedError && error.code === 'CONTEXT_CHANGED',
  );
  await assert.rejects(
    contexts.resolveCurrent(session, undefined),
    (error: unknown) => error instanceof IdentityDeniedError && error.code === 'CONTEXT_CHANGED',
  );
});

test('tenant selection requires a live membership and rechecks it instead of caching authorization', async () => {
  const repository = new FakeIdentityRepository();
  const contexts = new TenantContextService(repository);
  const session = sessionFor(tenantA, 'synthetic-context-ref-00000002');
  await assert.rejects(contexts.resolveTenantSwitch(session, 'synthetic-context-ref-00000002', 'tenant-c-forged'));

  const scope = await contexts.resolveCurrent(session, 'synthetic-context-ref-00000002');
  const authorization = new TenantAuthorizationService(repository);
  await authorization.authorize(scope, 'RESOURCE_READ', tenantA);
  const readsBeforeRevocation = repository.membershipReads;
  repository.memberships.set(tenantA, { ...membership(tenantA, ['operator']), status: 'REVOKED', version: 2 });
  await assert.rejects(authorization.authorize(scope, 'RESOURCE_READ', tenantA));
  assert.equal(repository.membershipReads, readsBeforeRevocation + 1, 'each authorization observes membership revocation');
});

test('resource IDs and duplicate provider IDs never override the tenant-scoped policy', async () => {
  const repository = new FakeIdentityRepository();
  const contexts = new TenantContextService(repository);
  const authorization = new TenantAuthorizationService(repository);
  const scopeA = await contexts.resolveCurrent(sessionFor(tenantA, 'synthetic-context-ref-00000003'), 'synthetic-context-ref-00000003');
  const scopeB = await contexts.resolveCurrent(sessionFor(tenantB, 'synthetic-context-ref-00000004'), 'synthetic-context-ref-00000004');
  const assetA = { tenantId: tenantA, internalId: 'asset-a', externalId: sameExternalAssetId };
  const assetB = { tenantId: tenantB, internalId: 'asset-b', externalId: sameExternalAssetId };

  assert.equal(assetA.externalId, assetB.externalId);
  await authorization.authorize(scopeA, 'RESOURCE_READ', assetA.tenantId);
  await assert.rejects(authorization.authorize(scopeA, 'RESOURCE_READ', assetB.tenantId));
  await assert.rejects(authorization.authorize(scopeB, 'RESOURCE_READ', assetA.tenantId));
  await assert.rejects(authorization.authorize(scopeA, 'RESOURCE_READ', 'tenant-id-from-request'));

  assert.deepEqual(tenantScopedIdPredicate(scopeA, assetB.internalId), {
    sql: 'id = ? AND tenant_id = ?',
    values: [assetB.internalId, tenantA],
  });
  assert.deepEqual(tenantScopePredicate(scopeA), { sql: 'tenant_id = ?', values: [tenantA] });
  await assert.rejects(
    Promise.resolve().then(() => tenantScopePredicate({ tenantId: tenantB } as never)),
    (error: unknown) => error instanceof IdentityDeniedError,
  );
});

test('legacy IdDatabase and IdCompany resolution always includes the authorized tenant', async () => {
  const repository = new FakeIdentityRepository();
  const scopeA = await new TenantContextService(repository).resolveCurrent(
    sessionFor(tenantA, 'synthetic-context-ref-00000005'),
    'synthetic-context-ref-00000005',
  );
  const companyA = await resolveLegacyMappingForTenant(repository, scopeA, 'same-legacy-db', 'company-a', 'test');
  assert.equal(companyA.tenantId, tenantA);
  await assert.rejects(
    resolveLegacyMappingForTenant(repository, scopeA, 'same-legacy-db', 'company-b', 'test'),
    (error: unknown) => error instanceof IdentityDeniedError,
  );
});

test('operator cannot grant admin, disconnect or read secrets; viewer remains read-only', async () => {
  const repository = new FakeIdentityRepository();
  const contexts = new TenantContextService(repository);
  const authorization = new TenantAuthorizationService(repository);
  const operator = await contexts.resolveCurrent(sessionFor(tenantA, 'synthetic-context-ref-00000006'), 'synthetic-context-ref-00000006');
  await authorization.authorize(operator, 'CONNECT', tenantA);
  await authorization.authorize(operator, 'REPLAY_EVENT', tenantA);
  await assert.rejects(authorization.authorize(operator, 'DISCONNECT', tenantA));
  await assert.rejects(authorization.authorize(operator, 'GRANT_ADMIN', tenantA));
  await assert.rejects(authorization.authorize(operator, 'READ_CREDENTIAL_SECRET', tenantA));

  const viewer = await contexts.resolveCurrent(sessionFor(tenantB, 'synthetic-context-ref-00000007'), 'synthetic-context-ref-00000007');
  await authorization.authorize(viewer, 'RESOURCE_READ', tenantB);
  await assert.rejects(authorization.authorize(viewer, 'CONNECT', tenantB));
  await assert.rejects(authorization.authorize(viewer, 'MANAGE_MEMBERS', tenantB));
});

test('service authorization uses tenant-scoped service scopes and never human membership roles', async () => {
  const repository = new FakeIdentityRepository();
  const services = new ServiceTenantAuthorizationService(repository);
  const serviceScope = await services.resolveScope(serviceId, tenantA);
  await services.authorize(serviceScope, 'CREDENTIAL_USE', tenantA);
  await assert.rejects(services.authorize(serviceScope, 'WEBHOOK_ROUTE', tenantA));
  await assert.rejects(services.authorize(serviceScope, 'CREDENTIAL_USE', tenantB));
  await assert.rejects(
    services.authorize({ principalId: humanId, tenantId: tenantA, scopes: ['CREDENTIAL_USE'] } as never, 'CREDENTIAL_USE', tenantA),
  );
});

test('jobs require a persisted tenant and principal, then revalidate the membership at execution', async () => {
  const repository = new FakeIdentityRepository();
  const contexts = new TenantContextService(repository);
  assert.throws(() => requireJobTenant({}), IdentityDeniedError);
  await assert.rejects(contexts.resolveJobContext({ tenantId: tenantA }));
  const jobScope = await contexts.resolveJobContext({ tenantId: tenantA, principalId: humanId });
  assert.equal(jobScope.tenantId, tenantA);
  repository.memberships.set(tenantA, { ...membership(tenantA, ['operator']), status: 'REVOKED', version: 2 });
  await assert.rejects(new TenantAuthorizationService(repository).authorize(jobScope, 'CONNECT', tenantA));
});
