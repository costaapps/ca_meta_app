import assert from 'node:assert/strict';
import test from 'node:test';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import { ServiceCredentialVerifier } from '../src/identity/identity.trust.js';
import type { ServiceTenantGrant, VerifiedServiceTenantScope } from '../src/identity/identity.types.js';
import { CredentialResolutionError } from '../src/credentials/credential-resolver.errors.js';
import { CredentialResolverService } from '../src/credentials/credential-resolver.service.js';
import { MysqlCredentialResolutionRepository } from '../src/credentials/mysql-credential-resolver.repository.js';
import type {
  CredentialOperationPolicy,
  CredentialOperationPolicyPort,
  CredentialResolutionAuditEntry,
  CredentialResolutionAuditPort,
  CredentialResolutionCandidate,
  CredentialResolutionContext,
  CredentialResolutionRepository,
  CredentialResolutionSnapshot,
  CredentialSecretExecutor,
} from '../src/credentials/credential-resolver.types.js';
import type { CredentialBinding } from '../src/credentials/credential-vault.types.js';
import type { MetaAssetKind } from '../src/meta-assets/meta-assets.types.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const observedAt = new Date(NOW - 60_000).toISOString();
const expiresAt = new Date(NOW + 86_400_000).toISOString();
let candidateSequence = 1000;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

const tenantA = uuid(1);
const tenantB = uuid(2);
const appA = uuid(3);
const appB = uuid(4);
const serviceA = uuid(5);
const serviceB = uuid(6);
const correlationId = uuid(7);

class SyntheticServiceVerifier extends ServiceCredentialVerifier {
  constructor(private readonly tenantId: string, private readonly principalId: string) { super(); }
  override async verifyCredential(value: string | undefined) {
    if (value !== 'synthetic-service-proof') return undefined;
    return this.issueVerifiedServiceCredential(this.principalId, this.tenantId);
  }
}

class SyntheticIdentityRepository implements IdentityRepository {
  async findPrincipalByIssuerSubject() { return undefined; }
  async findMembership() { return undefined; }
  async listActiveMemberships() { return []; }
  async findLegacyTenantMapping() { return undefined; }
  async findServiceTenantGrant(principalId: string, tenantId: string): Promise<ServiceTenantGrant | undefined> {
    const principal = principalId === serviceA ? serviceA : principalId === serviceB ? serviceB : undefined;
    const tenant = tenantId === tenantA ? tenantA : tenantId === tenantB ? tenantB : undefined;
    if (!principal || !tenant || (principal === serviceA && tenant !== tenantA) || (principal === serviceB && tenant !== tenantB)) return undefined;
    return {
      principalId: principal,
      tenantId: tenant,
      principalKind: 'SERVICE',
      principalStatus: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      scopes: ['CREDENTIAL_USE'],
    };
  }
}

async function serviceScopeFor(tenantId: string): Promise<VerifiedServiceTenantScope> {
  const principalId = tenantId === tenantA ? serviceA : serviceB;
  const proof = await new SyntheticServiceVerifier(tenantId, principalId).verifyCredential('synthetic-service-proof');
  if (!proof) throw new Error('Synthetic service credential was not issued.');
  return new ServiceTenantAuthorizationService(new SyntheticIdentityRepository()).resolveScope(proof);
}

function context(assetId: string, tenantId = tenantA, appConfigurationId = appA,
  operation: CredentialResolutionContext['operation'] = 'SEND_MESSAGE',
  environment: CredentialResolutionContext['environment'] = 'test'): CredentialResolutionContext {
  return { tenantId, provider: 'META', appConfigurationId, environment, assetId, operation };
}

function policyFor(value: CredentialResolutionContext): CredentialOperationPolicy {
  return {
    tenantId: value.tenantId,
    provider: value.provider,
    appConfigurationId: value.appConfigurationId,
    environment: value.environment,
    operation: value.operation,
    version: 1,
    flowVariant: 'WHATSAPP_COEXISTENCE',
    authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    capability: value.operation,
    purpose: 'CUSTOMER_OPERATION',
    assetKinds: ['WHATSAPP_PHONE_NUMBER'],
    allowedFamilies: ['SYNTHETIC_FAMILY_A', 'SYNTHETIC_FAMILY_B'],
    preferredFamilies: ['SYNTHETIC_FAMILY_A', 'SYNTHETIC_FAMILY_B'],
    requiredAssetGrants: ['SYNTHETIC_ASSET_GRANT'],
    requiredAuthorizationScopes: ['SYNTHETIC_AUTH_SCOPE'],
    ancestryRules: [{
      relationType: 'PHONE_TO_ACCOUNT',
      childKind: 'WHATSAPP_PHONE_NUMBER',
      parentKind: 'WHATSAPP_BUSINESS_ACCOUNT',
    }],
    allowExpiring: false,
    maxHealthObservationAgeSeconds: 3600,
  };
}

function candidate(value: CredentialResolutionContext, overrides: Partial<CredentialResolutionCandidate> = {}) {
  const candidateBinding: CredentialBinding = {
    tenantId: value.tenantId,
    credentialId: uuid(candidateSequence++),
    authorizationId: uuid(candidateSequence++),
    appConfigurationId: value.appConfigurationId,
    provider: 'META',
    environment: value.environment,
    family: 'SYNTHETIC_FAMILY_A',
  };
  return {
    binding: candidateBinding,
    authorizationState: 'ACTIVE',
    authorizationVersion: 1,
    credentialStatus: 'ACTIVE',
    credentialVersion: 1,
    assetAuthorizationState: 'ACTIVE',
    assetVerificationState: 'VERIFIED',
    assetAuthorizationVersion: 1,
    grantAssetId: value.assetId,
    grantAssetKind: 'WHATSAPP_PHONE_NUMBER',
    lineage: [],
    grantedAssetGrants: ['SYNTHETIC_ASSET_GRANT'],
    grantedAuthorizationScopes: ['SYNTHETIC_AUTH_SCOPE'],
    secretAvailable: true,
    secretVersion: 1,
    health: { state: 'HEALTHY', observedAt, source: 'META_API' },
    expiry: { state: 'KNOWN', expiresAt, observedAt, source: 'META_API' },
    ...overrides,
  } satisfies CredentialResolutionCandidate;
}

class MemoryResolutionRepository implements CredentialResolutionRepository {
  readonly snapshots = new Map<string, CredentialResolutionSnapshot>();
  readonly calls: CredentialResolutionContext[] = [];

  async inspect(value: CredentialResolutionContext): Promise<CredentialResolutionSnapshot> {
    this.calls.push(value);
    return this.snapshots.get(value.assetId) ?? { candidates: [] };
  }
}

class MemoryPolicies implements CredentialOperationPolicyPort {
  readonly policies = new Map<string, CredentialOperationPolicy>();
  async findPolicy(value: CredentialResolutionContext) { return this.policies.get(value.assetId) ?? policyFor(value); }
}

class MemoryAudit implements CredentialResolutionAuditPort {
  readonly entries: CredentialResolutionAuditEntry[] = [];
  async recordSelection(entry: CredentialResolutionAuditEntry) { this.entries.push(entry); }
}

class MemoryVault implements CredentialSecretExecutor {
  readonly calls: Array<CredentialBinding & { readonly operation: string }> = [];
  async withCredential(input: CredentialBinding & { readonly actorRef: string; readonly correlationId: string; readonly operation: string },
    execute: (secret: string) => Promise<void>): Promise<void> {
    this.calls.push({ ...input });
    await execute(`synthetic-secret-marker-${input.credentialId}`);
  }
}

function resolver(repository: MemoryResolutionRepository, policies = new MemoryPolicies(),
  audit = new MemoryAudit(), vault = new MemoryVault(), authorize?: (tenantId: string) => void): {
    readonly service: CredentialResolverService;
    readonly audit: MemoryAudit;
    readonly vault: MemoryVault;
    readonly authorizationCalls: string[];
  } {
  const identityAuthorization = new ServiceTenantAuthorizationService(new SyntheticIdentityRepository());
  const authorizationCalls: string[] = [];
  const authorization = {
    async authorize(scope: VerifiedServiceTenantScope, tenantId: string) {
      authorizationCalls.push(tenantId);
      authorize?.(tenantId);
      await identityAuthorization.authorize(scope, 'CREDENTIAL_USE', tenantId);
    },
  };
  return {
    service: new CredentialResolverService(repository, policies, authorization, audit, vault, () => NOW),
    audit,
    vault,
    authorizationCalls,
  };
}

function asset(assetId: string, kind: MetaAssetKind = 'WHATSAPP_PHONE_NUMBER') {
  return { assetId, kind, verified: true, version: 1 } as const;
}

function phoneToWaba(phoneId: string, wabaId: string): CredentialResolutionCandidate['lineage'] {
  return [{
    childAssetId: phoneId,
    childKind: 'WHATSAPP_PHONE_NUMBER',
    relationType: 'PHONE_TO_ACCOUNT',
    parentAssetId: wabaId,
    parentKind: 'WHATSAPP_BUSINESS_ACCOUNT',
    verified: true,
  }];
}

test('resolves four synthetic phone numbers through exact grants, a shared WABA and partial reauthorization', async () => {
  const scope = await serviceScopeFor(tenantA);
  const repository = new MemoryResolutionRepository();
  const runtime = resolver(repository);
  const phones = [uuid(10), uuid(11), uuid(12), uuid(13)];
  const sharedWaba = uuid(20);
  const firstAuthorization = uuid(30);
  const sharedAuthorization = uuid(31);
  const reauthorized = uuid(32);
  const expectedAuths = [firstAuthorization, sharedAuthorization, sharedAuthorization, reauthorized];
  for (let index = 0; index < phones.length; index += 1) {
    const value = context(phones[index]!);
    let candidates: CredentialResolutionCandidate[];
    if (index === 0) {
      candidates = [candidate(value, { binding: { ...candidate(value).binding, credentialId: uuid(40), authorizationId: firstAuthorization } })];
    } else {
      candidates = [candidate(value, {
        binding: { ...candidate(value).binding, credentialId: uuid(41), authorizationId: sharedAuthorization },
        authorizationState: 'PARTIAL',
        grantAssetId: sharedWaba,
        grantAssetKind: 'WHATSAPP_BUSINESS_ACCOUNT',
        lineage: phoneToWaba(value.assetId, sharedWaba),
      })];
    }
    if (index === 3) {
      candidates.push(candidate(value, {
        binding: { ...candidate(value).binding, credentialId: uuid(42), authorizationId: reauthorized, family: 'SYNTHETIC_FAMILY_B' },
        authorizationState: 'PARTIAL',
        authorizationVersion: 2,
      }));
    }
    repository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates });
  }

  const resolutions = [];
  for (let index = 0; index < phones.length; index += 1) {
    const value = context(phones[index]!);
    resolutions.push(await runtime.service.resolve(value, { serviceScope: scope, correlationId }));
  }
  assert.deepEqual(runtime.audit.entries.map((entry) => entry.authorizationId), expectedAuths);
  assert.deepEqual(runtime.audit.entries.map((entry) => entry.reason), [
    'DIRECT_ASSET_GRANT', 'VERIFIED_ANCESTOR_GRANT', 'VERIFIED_ANCESTOR_GRANT', 'DIRECT_ASSET_GRANT',
  ]);
  assert.equal(resolutions[3]?.family, 'SYNTHETIC_FAMILY_B');
  assert.equal(runtime.authorizationCalls.length, 4);

  const serialized = JSON.stringify(resolutions);
  assert.equal(serialized.includes('credentialId'), false);
  assert.equal(serialized.includes('authorizationId'), false);
  assert.equal(serialized.includes('synthetic-secret-marker'), false);
  assert.equal(serialized.includes('ciphertext'), false);
  for (const resolution of resolutions) {
    const useResult = await runtime.service.withCredential(resolution.handle, async (secret) => {
      assert.match(secret, /^synthetic-secret-marker-/);
    });
    assert.equal(useResult, undefined);
  }
  assert.deepEqual(runtime.vault.calls.map((call) => call.authorizationId), expectedAuths);
  assert.equal(runtime.authorizationCalls.length, 8);
});

test('denies candidates from another tenant, app or environment without a global fallback', async () => {
  const scope = await serviceScopeFor(tenantA);
  for (const foreign of [
    candidate(context(uuid(50)), { binding: { ...candidate(context(uuid(50))).binding, tenantId: tenantB } }),
    candidate(context(uuid(51)), { binding: { ...candidate(context(uuid(51))).binding, appConfigurationId: appB } }),
    candidate(context(uuid(52)), { binding: { ...candidate(context(uuid(52))).binding, environment: 'production' } }),
  ]) {
    const value = context(foreign.grantAssetId);
    const repository = new MemoryResolutionRepository();
    repository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates: [foreign] });
    const runtime = resolver(repository);
    await assert.rejects(runtime.service.resolve(value, { serviceScope: scope, correlationId }), (error: unknown) =>
      error instanceof CredentialResolutionError && error.code === 'ASSET_GRANT_MISSING');
    assert.equal(runtime.vault.calls.length, 0);
  }
  const mismatch = context(uuid(53), tenantB);
  const runtime = resolver(new MemoryResolutionRepository());
  await assert.rejects(runtime.service.resolve(mismatch, { serviceScope: scope, correlationId }), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'ACCESS_DENIED');
});

test('missing asset grant, missing scope and unknown validity fail recoverably without trying another credential', async () => {
  const scope = await serviceScopeFor(tenantA);
  for (const [overrides, code] of [
    [{ grantedAssetGrants: [] }, 'ASSET_GRANT_MISSING'],
    [{ grantedAuthorizationScopes: [] }, 'META_PERMISSION_REQUIRED'],
    [{ expiry: { state: 'UNKNOWN' } }, 'DEPENDENCY_UNAVAILABLE'],
    [{ health: { state: 'UNKNOWN' } }, 'DEPENDENCY_UNAVAILABLE'],
  ] as const) {
    const value = context(uuid(60 + code.length));
    const repository = new MemoryResolutionRepository();
    repository.snapshots.set(value.assetId, {
      asset: asset(value.assetId),
      candidates: [candidate(value, overrides as Partial<CredentialResolutionCandidate>)],
    });
    const runtime = resolver(repository);
    await assert.rejects(runtime.service.resolve(value, { serviceScope: scope, correlationId }), (error: unknown) =>
      error instanceof CredentialResolutionError && error.code === code);
    assert.equal(runtime.vault.calls.length, 0);
  }
});

test('uses the explicit server policy family preference before version tie-breakers', async () => {
  const scope = await serviceScopeFor(tenantA);
  const value = context(uuid(69));
  const preferred = candidate(value, {
    binding: { ...candidate(value).binding, credentialId: uuid(691), authorizationId: uuid(692), family: 'SYNTHETIC_FAMILY_B' },
    authorizationVersion: 1,
  });
  const newerButLowerPreference = candidate(value, {
    binding: { ...candidate(value).binding, credentialId: uuid(693), authorizationId: uuid(694), family: 'SYNTHETIC_FAMILY_A' },
    authorizationVersion: 9,
  });
  const repository = new MemoryResolutionRepository();
  repository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates: [newerButLowerPreference, preferred] });
  const policies = new MemoryPolicies();
  policies.policies.set(value.assetId, { ...policyFor(value), preferredFamilies: ['SYNTHETIC_FAMILY_B', 'SYNTHETIC_FAMILY_A'] });
  const runtime = resolver(repository, policies);
  const result = await runtime.service.resolve(value, { serviceScope: scope, correlationId });
  assert.equal(result.family, 'SYNTHETIC_FAMILY_B');
  assert.equal(runtime.audit.entries[0]?.credentialId, uuid(691));
});

test('ranks provider-declared no-expiry after known future deadlines', async () => {
  const scope = await serviceScopeFor(tenantA);
  const value = context(uuid(695));
  const noExpiry = candidate(value, {
    binding: { ...candidate(value).binding, credentialId: uuid(696), authorizationId: uuid(697) },
    authorizationVersion: 9,
    credentialVersion: 9,
    expiry: { state: 'PROVIDER_NO_EXPIRY', observedAt, source: 'META_API' },
  });
  const knownExpiry = candidate(value, {
    binding: { ...candidate(value).binding, credentialId: uuid(698), authorizationId: uuid(699) },
    authorizationVersion: 1,
    credentialVersion: 1,
    expiry: { state: 'KNOWN', expiresAt, observedAt, source: 'META_API' },
  });
  const repository = new MemoryResolutionRepository();
  repository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates: [noExpiry, knownExpiry] });
  const runtime = resolver(repository);
  await runtime.service.resolve(value, { serviceScope: scope, correlationId });
  assert.equal(runtime.audit.entries[0]?.credentialId, uuid(698));
});

test('revocation and version changes invalidate one-use handles; the resolver keeps no cache', async () => {
  const scope = await serviceScopeFor(tenantA);
  const value = context(uuid(70));
  const selected = candidate(value);
  const repository = new MemoryResolutionRepository();
  repository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates: [selected] });
  const runtime = resolver(repository);
  const resolved = await runtime.service.resolve(value, { serviceScope: scope, correlationId });

  repository.snapshots.set(value.assetId, {
    asset: asset(value.assetId),
    candidates: [candidate(value, { ...selected, credentialStatus: 'REVOKED' })],
  });
  await assert.rejects(runtime.service.withCredential(resolved.handle, async () => undefined), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'META_REAUTH_REQUIRED');
  await assert.rejects(runtime.service.withCredential(resolved.handle, async () => undefined), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'ACCESS_DENIED');
  await assert.rejects(runtime.service.resolve(value, { serviceScope: scope, correlationId }), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'META_REAUTH_REQUIRED');
  assert.equal(runtime.vault.calls.length, 0);

  const freshRepository = new MemoryResolutionRepository();
  const oldCandidate = candidate(value);
  freshRepository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates: [oldCandidate] });
  const freshRuntime = resolver(freshRepository);
  const oldHandle = await freshRuntime.service.resolve(value, { serviceScope: scope, correlationId });
  freshRepository.snapshots.set(value.assetId, {
    asset: { ...asset(value.assetId), version: 2 },
    candidates: [candidate(value, { ...oldCandidate, credentialVersion: 2, secretVersion: 2 })],
  });
  await assert.rejects(freshRuntime.service.withCredential(oldHandle.handle, async () => undefined), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'CONTEXT_CHANGED');
  assert.equal(freshRepository.calls.length, 2);
  assert.equal(freshRuntime.vault.calls.length, 0);
});

test('rejects conventional phone registration for Coexistence and fails if selection audit is unavailable', async () => {
  const scope = await serviceScopeFor(tenantA);
  const value = context(uuid(80), tenantA, appA, 'PHONE_REGISTRATION_CONVENTIONAL');
  const repository = new MemoryResolutionRepository();
  repository.snapshots.set(value.assetId, { asset: asset(value.assetId), candidates: [candidate(value)] });
  const policies = new MemoryPolicies();
  policies.policies.set(value.assetId, { ...policyFor(value), flowVariant: 'WHATSAPP_COEXISTENCE' });
  const runtime = resolver(repository, policies);
  await assert.rejects(runtime.service.resolve(value, { serviceScope: scope, correlationId }), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'DEPENDENCY_UNAVAILABLE');
  assert.equal(repository.calls.length, 0);

  const direct = context(uuid(81));
  const directRepository = new MemoryResolutionRepository();
  directRepository.snapshots.set(direct.assetId, { asset: asset(direct.assetId), candidates: [candidate(direct)] });
  const unavailableAudit: CredentialResolutionAuditPort = { async recordSelection() { throw new Error('unavailable'); } };
  const auditRuntime = resolver(directRepository, new MemoryPolicies(), unavailableAudit as unknown as MemoryAudit);
  await assert.rejects(auditRuntime.service.resolve(direct, { serviceScope: scope, correlationId }), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'DEPENDENCY_UNAVAILABLE');
  assert.equal(auditRuntime.vault.calls.length, 0);
});

test('MySQL adapter binds every read to the exact context and treats absent health/expiry as unknown', async () => {
  const value = context(uuid(90));
  const source = candidate(value, {
    binding: { ...candidate(value).binding, credentialId: uuid(91), authorizationId: uuid(92) },
  });
  const queries: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = [];
  const dataSource = {
    async query(sql: string, parameters: readonly unknown[] = []) {
      queries.push({ sql, parameters });
      if (sql.includes('SELECT a.id, a.asset_kind')) {
        return [{ id: value.assetId, kind: 'WHATSAPP_PHONE_NUMBER', version: 1 }];
      }
      if (sql.includes('FROM ca_meta_asset_relations ar')) return [];
      if (sql.includes('FROM ca_meta_asset_authorizations aa')) {
        return [{
          tenant_id: value.tenantId,
          credential_id: source.binding.credentialId,
          authorization_id: source.binding.authorizationId,
          app_configuration_id: value.appConfigurationId,
          provider: value.provider,
          environment: value.environment,
          family: source.binding.family,
          authorization_state: 'ACTIVE',
          authorization_version: 1,
          credential_status: 'ACTIVE',
          credential_version: 1,
          asset_auth_state: 'ACTIVE',
          verification_state: 'VERIFIED',
          asset_auth_version: 1,
          grant_asset_id: value.assetId,
          grant_asset_kind: 'WHATSAPP_PHONE_NUMBER',
          secret_version: 1,
        }];
      }
      if (sql.includes('FROM ca_meta_asset_grants')) {
        return [{ authorization_id: source.binding.authorizationId, asset_id: value.assetId,
          grant_name: 'SYNTHETIC_ASSET_GRANT', status: 'GRANTED' }];
      }
      if (sql.includes('FROM ca_meta_authorization_scopes')) {
        return [{ authorization_id: source.binding.authorizationId,
          scope_name: 'SYNTHETIC_AUTH_SCOPE', status: 'GRANTED' }];
      }
      return [];
    },
  };
  const database = { async getDataSource() { return dataSource; } } as unknown as DurableWorkDatabase;
  const repository = new MysqlCredentialResolutionRepository(database);
  const snapshot = await repository.inspect(value, policyFor(value));
  assert.equal(snapshot.asset?.verified, true);
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.candidates[0]?.health.state, 'UNKNOWN');
  assert.equal(snapshot.candidates[0]?.expiry.state, 'UNKNOWN');
  for (const query of queries) {
    assert.ok(query.parameters.includes(value.tenantId));
    assert.ok(query.parameters.includes(value.appConfigurationId));
    assert.ok(query.parameters.includes(value.provider));
    assert.ok(query.parameters.includes(value.environment));
    assert.equal(query.sql.includes('ciphertext'), false);
    assert.equal(query.sql.includes('authentication_tag'), false);
    assert.equal(query.sql.includes('credential_ref'), false);
  }
});
