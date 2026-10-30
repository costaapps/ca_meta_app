import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import { IdentityAdministrationService } from '../src/identity/identity-administration.service.js';
import type { LegacyTenantMappingInput } from '../src/identity/identity-administration.repository.js';
import type { IdentityAdministrationCommand, IdentityAdministrationRepository, IdentityAdministrationResult } from '../src/identity/identity-administration.repository.js';
import {
  IdentityAssertionVerifier,
  isVerifiedPortalSession,
  PlatformIdentityAdminAuthority,
  PortalSessionVerifier,
  type VerifiedIdentityAssertion,
  type VerifiedPortalSession,
} from '../src/identity/identity.trust.js';
import { IdentityAdministrationConflictError, MysqlIdentityAdministrationRepository } from '../src/identity/mysql-identity-administration.repository.js';
import type { IdentityRepository, LegacyTenantMapping } from '../src/identity/identity.repository.js';
import {
  hashTenantContextReference,
  resolveLegacyMappingForTenant,
  requireJobTenant,
  ServiceTenantAuthorizationService,
  TenantAuthorizationService,
  TenantContextService,
  isAuthorizedTenantScope,
  tenantScopePredicate,
  tenantScopedIdPredicate,
} from '../src/identity/identity.service.js';
import type {
  AuthorizedTenantScope,
  MembershipRole,
  PrincipalIdentity,
  ServiceTenantGrant,
  TenantMembership,
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

async function sessionFor(tenantId: string, contextRef: string, contextVersion = 1): Promise<VerifiedPortalSession> {
  const cookie = `synthetic-cookie-for-${tenantId}-with-adequate-entropy`;
  const expectedHash = createHash('sha256').update(cookie, 'utf8').digest();
  const session = await new PortalSessionVerifier({
    async findActiveBySecretHash(hash) {
      if (!Buffer.from(hash).equals(expectedHash)) return undefined;
      return {
        sessionId: `server-session-${tenantId}`,
        principalId: humanId,
        tenantId,
        contextVersion,
        contextRefHash: hashTenantContextReference(contextRef),
      };
    },
  }).verify(cookie);
  if (!session) throw new Error('Synthetic session verification failed.');
  return session;
}

class SyntheticAssertionVerifier extends IdentityAssertionVerifier {
  verify(subject: string): VerifiedIdentityAssertion {
    return this.issueVerifiedAssertion('https://issuer.synthetic.invalid', subject);
  }
}

class FakeIdentityAdministrationRepository implements IdentityAdministrationRepository {
  readonly commands: IdentityAdministrationCommand[] = [];
  readonly auditEvents: Array<{ readonly action: string; readonly actorRef: string; readonly reasonCode: string; readonly idempotencyKey: string; readonly requestHash: string }> = [];
  readonly legacyMappings: LegacyTenantMappingInput[] = [];
  readonly members = new Map<string, { readonly principalId: string; role: string; status: string }>();
  private readonly idempotency = new Map<string, { readonly requestHash: string; readonly result: IdentityAdministrationResult }>();

  async execute(command: IdentityAdministrationCommand): Promise<IdentityAdministrationResult> {
    this.commands.push(command);
    const ref = command.action === 'BOOTSTRAP_TENANT' ? command.actor.actorRef : command.actor.principalId;
    const key = `${command.action === 'BOOTSTRAP_TENANT' ? 'PLATFORM' : command.scope.tenantId}:${ref}:${command.idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.requestHash !== command.requestHash) throw new IdentityAdministrationConflictError();
      return { ...prior.result, replayed: true };
    }
    let result: IdentityAdministrationResult;
    if (command.action === 'BOOTSTRAP_TENANT') {
      this.legacyMappings.push(command.legacyMapping);
      result = { tenantId: command.tenantId, principalId: `created-${command.target.subject}`, replayed: false };
    } else if (command.action === 'GRANT_MEMBERSHIP') {
      const digest = createHash('sha256').update(command.target.subject).digest('hex');
      const principalId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      this.members.set(`${command.scope.tenantId}:${principalId}`, { principalId, role: command.role, status: 'ACTIVE' });
      result = { tenantId: command.scope.tenantId, principalId, replayed: false };
    } else {
      const member = this.members.get(`${command.scope.tenantId}:${command.targetPrincipalId}`);
      if (!member || member.status !== 'ACTIVE') throw new IdentityDeniedError();
      member.status = 'REVOKED';
      result = { tenantId: command.scope.tenantId, principalId: command.targetPrincipalId, replayed: false };
    }
    this.idempotency.set(key, { requestHash: command.requestHash, result });
    this.auditEvents.push({
      action: command.action,
      actorRef: command.action === 'BOOTSTRAP_TENANT' ? command.actor.actorRef : command.actor.principalId,
      reasonCode: command.reasonCode,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
    });
    return result;
  }
}

test('tenant context is server-derived, versioned and invalidates stale tabs on tenant switch', async () => {
  const repository = new FakeIdentityRepository();
  const contexts = new TenantContextService(repository);
  const session = await sessionFor(tenantA, 'synthetic-context-ref-00000001');
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
  const session = await sessionFor(tenantA, 'synthetic-context-ref-00000002');
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
  const scopeA = await contexts.resolveCurrent(await sessionFor(tenantA, 'synthetic-context-ref-00000003'), 'synthetic-context-ref-00000003');
  const scopeB = await contexts.resolveCurrent(await sessionFor(tenantB, 'synthetic-context-ref-00000004'), 'synthetic-context-ref-00000004');
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
  const forgedScope = { ...scopeA, roles: ['owner'] } as unknown as AuthorizedTenantScope;
  assert.equal(isAuthorizedTenantScope(forgedScope), false);
  await assert.rejects(authorization.authorize(forgedScope, 'RESOURCE_READ', tenantA), IdentityDeniedError);
  assert.throws(() => tenantScopedIdPredicate(forgedScope, 'asset-a'), IdentityDeniedError);
  await assert.rejects(
    Promise.resolve().then(() => tenantScopePredicate({ tenantId: tenantB } as never)),
    (error: unknown) => error instanceof IdentityDeniedError,
  );
});

test('legacy IdDatabase and IdCompany resolution always includes the authorized tenant', async () => {
  const repository = new FakeIdentityRepository();
  const scopeA = await new TenantContextService(repository).resolveCurrent(
    await sessionFor(tenantA, 'synthetic-context-ref-00000005'),
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
  const operator = await contexts.resolveCurrent(await sessionFor(tenantA, 'synthetic-context-ref-00000006'), 'synthetic-context-ref-00000006');
  await authorization.authorize(operator, 'CONNECT', tenantA);
  await authorization.authorize(operator, 'REPLAY_EVENT', tenantA);
  await assert.rejects(authorization.authorize(operator, 'DISCONNECT', tenantA));
  await assert.rejects(authorization.authorize(operator, 'GRANT_ADMIN', tenantA));
  await assert.rejects(authorization.authorize(operator, 'READ_CREDENTIAL_SECRET', tenantA));

  const viewer = await contexts.resolveCurrent(await sessionFor(tenantB, 'synthetic-context-ref-00000007'), 'synthetic-context-ref-00000007');
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

test('portal context rejects a forged DTO and only the server session verifier issues a runtime capability', async () => {
  const contextRef = 'synthetic-context-ref-for-session-brand';
  const contexts = new TenantContextService(new FakeIdentityRepository());
  const forged = {
    sessionId: 'server-session-forged', principalId: humanId, tenantId: tenantA,
    contextVersion: 1, contextRefHash: hashTenantContextReference(contextRef),
  } as VerifiedPortalSession;
  assert.equal(isVerifiedPortalSession(forged), false);
  await assert.rejects(contexts.resolveCurrent(forged, contextRef), IdentityDeniedError);
  const verified = await sessionFor(tenantA, contextRef);
  assert.equal(isVerifiedPortalSession(verified), true);
  await contexts.resolveCurrent(verified, contextRef);
});

test('platform bootstrap fails closed until explicit allowlist authority and is idempotently audited', async () => {
  const assertions = new SyntheticAssertionVerifier();
  const platformIdentity = assertions.verify('synthetic-platform-admin-subject');
  const subject = assertions.verify('synthetic-initial-owner-subject');
  const noAdmins = new PlatformIdentityAdminAuthority([]);
  assert.throws(() => noAdmins.verify(platformIdentity), /not configured/);
  assert.throws(() => noAdmins.verify({ issuer: platformIdentity.issuer, subject: platformIdentity.subject } as VerifiedIdentityAssertion));

  const authority = new PlatformIdentityAdminAuthority([{
    issuer: 'https://issuer.synthetic.invalid', subject: 'synthetic-platform-admin-subject',
  }]);
  const actor = authority.verify(platformIdentity);
  const repository = new FakeIdentityAdministrationRepository();
  const service = new IdentityAdministrationService(repository, new TenantContextService(new FakeIdentityRepository()));
  const mapping: LegacyTenantMappingInput = {
    legacyDatabaseId: 'synthetic-db-1', legacyCompanyId: 'synthetic-company-1', environment: 'test',
  };
  const first = await service.bootstrapTenant(actor, subject, mapping, '00000000-0000-4000-8000-000000000001');
  const replay = await service.bootstrapTenant(actor, subject, mapping, '00000000-0000-4000-8000-000000000001');
  assert.equal(first.tenantId, replay.tenantId);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(repository.commands.length, 2);
  assert.ok(repository.commands.every((command) => command.action === 'BOOTSTRAP_TENANT' && command.reasonCode === 'INITIAL_PROVISIONING'));
  await assert.rejects(service.bootstrapTenant(actor, assertions.verify('different-owner-subject'), mapping, '00000000-0000-4000-8000-000000000001'), IdentityAdministrationConflictError);
  assert.deepEqual(repository.legacyMappings, [mapping]);
  assert.ok(!JSON.stringify(repository.auditEvents).includes(platformIdentity.subject));
  assert.ok(!JSON.stringify(repository.auditEvents).includes(subject.subject));
});

test('membership admin operation denies escalation, records replay identity and revokes access', async () => {
  const identities = new FakeIdentityRepository();
  identities.memberships.set(tenantA, membership(tenantA, ['owner']));
  const adminRepository = new FakeIdentityAdministrationRepository();
  const service = new IdentityAdministrationService(adminRepository, new TenantContextService(identities));
  const actor = await sessionFor(tenantA, 'synthetic-context-ref-admin-grant');
  const assertion = new SyntheticAssertionVerifier().verify('synthetic-invitee-subject');
  const key = '00000000-0000-4000-8000-000000000002';
  const granted = await service.grantMembership(actor, 'synthetic-context-ref-admin-grant', assertion, 'admin', 'MEMBERSHIP_GRANT', key);
  const replay = await service.grantMembership(actor, 'synthetic-context-ref-admin-grant', assertion, 'admin', 'MEMBERSHIP_GRANT', key);
  assert.equal(replay.replayed, true);
  assert.equal(granted.principalId, replay.principalId);
  const commandCount = adminRepository.commands.length;
  await assert.rejects(
    service.grantMembership(actor, 'synthetic-context-ref-admin-grant', assertion, 'owner' as never, 'ROLE_CHANGE', '00000000-0000-4000-8000-000000000006'),
    IdentityDeniedError,
  );
  assert.equal(adminRepository.commands.length, commandCount, 'runtime role spoof is denied before repository execution');

  identities.memberships.set(tenantA, membership(tenantA, ['admin']));
  await assert.rejects(
    service.grantMembership(actor, 'synthetic-context-ref-admin-grant', assertion, 'admin', 'ROLE_CHANGE', '00000000-0000-4000-8000-000000000003'),
    IdentityDeniedError,
  );
  identities.memberships.set(tenantA, membership(tenantA, ['operator']));
  await assert.rejects(
    service.grantMembership(actor, 'synthetic-context-ref-admin-grant', assertion, 'viewer', 'MEMBERSHIP_GRANT', '00000000-0000-4000-8000-000000000004'),
    IdentityDeniedError,
  );

  identities.memberships.set(tenantA, membership(tenantA, ['owner']));
  const revoked = await service.revokeMembership(actor, 'synthetic-context-ref-admin-grant', granted.principalId as string, '00000000-0000-4000-8000-000000000005');
  assert.equal(adminRepository.members.get(`${tenantA}:${revoked.principalId}`)?.status, 'REVOKED');
  const lastCommand = adminRepository.commands.at(-1);
  assert.equal(lastCommand?.action, 'REVOKE_MEMBERSHIP');
  assert.equal(lastCommand?.reasonCode, 'MEMBERSHIP_REVOCATION');
  assert.ok(!JSON.stringify(adminRepository.auditEvents).includes(assertion.subject));

  const scope = await new TenantContextService(identities).resolveCurrent(actor, 'synthetic-context-ref-admin-grant');
  const databaseRepository = new MysqlIdentityAdministrationRepository({
    host: '127.0.0.1', port: 3306, name: 'synthetic', user: 'synthetic', password: 'synthetic', connectTimeoutMs: 100,
  });
  try {
    await assert.rejects(databaseRepository.execute({
      action: 'GRANT_MEMBERSHIP', actor, scope, target: assertion, role: 'owner' as never,
      reasonCode: 'ROLE_CHANGE', idempotencyKey: '00000000-0000-4000-8000-000000000007', requestHash: 'a'.repeat(64),
    }), IdentityDeniedError);
    const forgedScope = { ...scope, roles: Object.freeze(['owner']) } as unknown as AuthorizedTenantScope;
    await assert.rejects(databaseRepository.execute({
      action: 'GRANT_MEMBERSHIP', actor, scope: forgedScope, target: assertion, role: 'viewer',
      reasonCode: 'ROLE_CHANGE', idempotencyKey: '00000000-0000-4000-8000-000000000008', requestHash: 'b'.repeat(64),
    }), IdentityDeniedError);
  } finally {
    await databaseRepository.onApplicationShutdown();
  }
});
