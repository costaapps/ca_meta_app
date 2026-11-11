import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CredentialResolutionError } from '../src/credentials/credential-resolver.errors.js';
import { CredentialResolverService } from '../src/credentials/credential-resolver.service.js';
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
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import type { TenantAuthorizationService, TenantContextService } from '../src/identity/identity.service.js';
import type { ServiceTenantGrant, VerifiedServiceTenantScope } from '../src/identity/identity.types.js';
import { PortalSessionVerifier, ServiceCredentialVerifier } from '../src/identity/identity.trust.js';
import { META_CAPABILITY_MANIFEST, META_CAPABILITY_MANIFEST_VERSION } from '../src/meta-config/capability-manifest.js';
import { onboardingFlowForMetaProfile, type MetaAppConfiguration } from '../src/meta-config/meta-app-config.configuration.js';
import { MetaAppConfigRegistry } from '../src/meta-config/meta-app-config.registry.js';
import {
  ConnectionLifecycleConfigurationUnavailableError,
  ConnectionLifecycleService,
} from '../src/meta-lifecycle/connection-lifecycle.service.js';
import type { ConnectionLifecycleBinding, ConnectionLifecycleCommandRepository } from '../src/meta-lifecycle/connection-lifecycle.types.js';
import { MetaOnboardingConfigurationResolver } from '../src/onboarding/meta-onboarding-configuration.resolver.js';
import {
  type OnboardingCreateCommand,
  type OnboardingFlowVariant,
  type OnboardingProviderLaunchPort,
  type OnboardingSessionStore,
  type OnboardingStoredRecord,
} from '../src/onboarding/onboarding-session.types.js';
import {
  ONBOARDING_STATE_TTL_SECONDS,
  OnboardingSessionService,
  OnboardingStateSigner,
} from '../src/onboarding/onboarding-session.service.js';
import { OnboardingCodeProtector } from '../src/onboarding/onboarding-code-crypto.js';
import {
  OnboardingCodeConflictError,
  OnboardingCodeNotFoundError,
  OnboardingCodeSubmissionService,
} from '../src/onboarding/onboarding-code-submission.service.js';
import { hashOnboardingValue } from '../src/onboarding/onboarding-session.types.js';
import type { MysqlOnboardingCodeSubmissionStore } from '../src/onboarding/onboarding-code-submission.store.js';
import type { OnboardingSagaAdapter } from '../src/onboarding/onboarding-saga.types.js';

interface EvidenceCase {
  readonly file: string;
  readonly name: string;
  readonly assertion: string;
}

interface MatrixRow {
  readonly flow: string;
  readonly scenario: string;
  readonly coverage: string;
  readonly cases: readonly EvidenceCase[];
  readonly gap: string;
}

interface CertificationMatrix {
  readonly schemaVersion: number;
  readonly evidenceClass: string;
  readonly releaseCertification: string;
  readonly requiredFlows: readonly string[];
  readonly requiredScenarios: readonly string[];
  readonly authProfiles: readonly { readonly flow: string; readonly auth: string }[];
  readonly matrix: readonly MatrixRow[];
  readonly additionalCases: readonly {
    readonly cases?: readonly EvidenceCase[];
    readonly case?: string;
    readonly file?: string;
    readonly assertion?: string;
  }[];
  readonly sandboxGates: readonly { readonly status: string }[];
}

function repositoryRoot(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), '..', '..')]) {
    if (existsSync(join(candidate, 'apps', 'api', 'test', 'fixtures', 'm4-14', 'certification-matrix.v1.json'))) {
      return candidate;
    }
  }
  throw new Error('M4.14 fixture root is unavailable from the focused test working directory.');
}

const root = repositoryRoot();
const fixturePath = join(root, 'apps', 'api', 'test', 'fixtures', 'm4-14', 'certification-matrix.v1.json');
const matrix = JSON.parse(readFileSync(fixturePath, 'utf8')) as CertificationMatrix;

test('M4.14 evidence fixture has the explicit 4-by-7 matrix and exact executable case references', () => {
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.evidenceClass, 'LOCAL_SYNTHETIC_CONTRACT_CROSSWALK');
  assert.equal(matrix.releaseCertification, 'BLOCKED_NOT_CONFIRMED');
  assert.deepEqual(matrix.requiredFlows, [
    'FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE',
  ]);
  assert.deepEqual(matrix.requiredScenarios, [
    'success', 'cancel', 'partial_permission', 'replay', 'timeout', 'reauth', 'disconnect',
  ]);
  assert.equal(matrix.authProfiles.length, 5, 'Instagram Login variants remain separate profiles');
  assert.equal(matrix.matrix.length, 28);

  const actualCells = new Set(matrix.matrix.map((row) => row.flow + ':' + row.scenario));
  for (const flow of matrix.requiredFlows) {
    for (const scenario of matrix.requiredScenarios) {
      assert.ok(actualCells.has(flow + ':' + scenario), 'matrix cell missing: ' + flow + ':' + scenario);
    }
  }

  const evidenceCases = [
    ...matrix.matrix.flatMap((row) => row.cases),
    ...matrix.additionalCases.flatMap((entry) => entry.cases ?? (entry.case && entry.file
      ? [{ file: entry.file, name: entry.case, assertion: entry.assertion ?? '' }]
      : [])),
  ];
  for (const evidence of evidenceCases) {
    const source = readFileSync(join(root, evidence.file), 'utf8');
    assert.ok(source.includes("test('" + evidence.name + "'"),
      'evidence must resolve to the exact executable test case: ' + evidence.name);
    assert.ok(evidence.assertion.length > 0);
  }

  for (const row of matrix.matrix) {
    assert.ok(row.gap.length > 0, 'every minimum-matrix row records its remaining gate');
  }

  assert.equal(matrix.matrix.filter((row) => row.coverage === 'PARTIAL_LOCAL').length, 28);
  assert.equal(matrix.matrix.filter((row) => row.coverage === 'SHARED_COMPONENT_ONLY').length, 0);
  assert.equal(matrix.matrix.filter((row) => row.coverage === 'NOT_COVERED').length, 0);
  assert.ok(matrix.matrix.every((row) => row.coverage !== 'FULL_FLOW'),
    'local case references and shared components are not full-flow certification');
  assert.ok(matrix.sandboxGates.length >= 4);
  assert.ok(matrix.sandboxGates.every((gate) => gate.status === 'NOT_CONFIRMED'));
});

const AUTH_PROFILES = [
  { flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS' },
  { flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN' },
  { flowVariant: 'INSTAGRAM', authVariant: 'INSTAGRAM_LOGIN' },
  { flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' },
  { flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' },
] as const;

function unconfirmedReviewProfile(
  flowVariant: MetaAppConfiguration['flowVariant'],
  authVariant: MetaAppConfiguration['authVariant'],
): MetaAppConfiguration {
  const callbackUri = 'https://m4-14.example.invalid/callback/' + authVariant.toLowerCase();
  const capabilityEvidence = META_CAPABILITY_MANIFEST
    .filter((entry) => entry.flowVariant === flowVariant && entry.authVariant === authVariant)
    .map((entry) => ({
      operation: entry.operation,
      permissions: entry.candidatePermissions.map((permission) => ({
        permission,
        permissionStatus: 'CONFIRMED' as const,
        accessLevel: entry.requiredAccessLevel === 'ADVANCED' ? 'ADVANCED' as const : 'STANDARD' as const,
        appReviewStatus: 'NOT_CONFIRMED' as const,
        sandboxStatus: 'NOT_TESTED' as const,
      })),
    }));

  return {
    configurationRef: 'm4-14-synthetic-' + authVariant.toLowerCase(),
    environment: 'test',
    flowVariant,
    authVariant,
    providerAppIdRef: 'm4-14-synthetic-provider-app',
    providerAppId: '987654321012345',
    appMode: 'DEVELOPMENT',
    appDomain: 'm4-14.example.invalid',
    callbackUri,
    redirectAllowlist: [callbackUri],
    appSecretRef: 'vault://synthetic/m4-14/app-secret',
    tokenConfigurationRef: 'vault://synthetic/m4-14/token-config',
    capabilityManifestVersion: META_CAPABILITY_MANIFEST_VERSION,
    enabled: true,
    versions: {
      graphApi: {
        value: 'v27.0',
        status: 'VERIFIED',
        evidenceUrl: 'https://m4-14.example.invalid/fixture/version',
        verifiedAt: '2026-11-10',
      },
    },
    capabilityEvidence,
  };
}

test('M4.14 keeps every explicit Meta auth profile release-blocked while App Review and eligibility evidence are unconfirmed', () => {
  const configurations = AUTH_PROFILES.map(({ flowVariant, authVariant }) =>
    unconfirmedReviewProfile(flowVariant, authVariant));
  assert.ok(configurations.every((configuration) => configuration.capabilityEvidence
    .flatMap((item) => item.permissions)
    .every((permission) => permission.appReviewStatus === 'NOT_CONFIRMED' && permission.sandboxStatus === 'NOT_TESTED')));

  const registry = new MetaAppConfigRegistry(configurations);
  const bootstrap = registry.bootstrap();
  assert.equal(bootstrap.profiles.length, 5);
  assert.ok(bootstrap.profiles.every((profile) => !profile.enabled && profile.reasonCode !== null));
  assert.ok(bootstrap.profiles.every((profile) => profile.capabilities.every((capability) => !capability.enabled)));

  for (const { flowVariant, authVariant } of AUTH_PROFILES) {
    assert.equal(registry.resolve(flowVariant, authVariant, 'test'), undefined,
      'review/eligibility evidence must not resolve the exact app profile');
  }

  const coexProfile = bootstrap.profiles.find((profile) => profile.flowVariant === 'WHATSAPP_COEXISTENCE');
  const coexMessaging = coexProfile?.capabilities.find((capability) => capability.operation === 'SEND_MESSAGE');
  assert.equal(coexMessaging?.enabled, false);
  assert.equal(coexMessaging?.reasonCode, 'APP_REVIEW_NOT_CONFIRMED');

  const resolver = new MetaOnboardingConfigurationResolver(registry, 'test');
  const onboardingVariants: readonly OnboardingFlowVariant[] = [
    'FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN',
    'WHATSAPP_CLOUD_API', 'WHATSAPP_COEXISTENCE',
  ];
  for (const variant of onboardingVariants) {
    assert.equal(resolver.resolve(variant), undefined,
      'unconfirmed review/eligibility must keep release onboarding unavailable: ' + variant);
  }
});

const TENANT_ID = '20000000-0000-4000-8000-000000000001';
const SERVICE_ID = '20000000-0000-4000-8000-000000000002';
const APP_ID = '20000000-0000-4000-8000-000000000003';
const ASSET_ID = '20000000-0000-4000-8000-000000000004';
const CORRELATION_ID = '20000000-0000-4000-8000-000000000005';
const PREFERRED_CREDENTIAL_ID = '20000000-0000-4000-8000-000000000006';
const PREFERRED_AUTHORIZATION_ID = '20000000-0000-4000-8000-000000000007';
const FALLBACK_CREDENTIAL_ID = '20000000-0000-4000-8000-000000000008';
const FALLBACK_AUTHORIZATION_ID = '20000000-0000-4000-8000-000000000009';
const OBSERVED_AT = '2026-11-10T11:59:00.000Z';
const EXPIRES_AT = '2026-11-11T12:00:00.000Z';
const SYNTHETIC_SECRET = 'm4-14-synthetic-secret-marker-private-callback-only';

class SyntheticServiceCredentialVerifier extends ServiceCredentialVerifier {
  async verifyCredential(value: string | undefined) {
    if (value !== 'm4-14-synthetic-service-proof') return undefined;
    return this.issueVerifiedServiceCredential(SERVICE_ID, TENANT_ID);
  }
}

class SyntheticIdentityRepository implements IdentityRepository {
  async findPrincipalByIssuerSubject() { return undefined; }
  async findMembership() { return undefined; }
  async listActiveMemberships() { return []; }
  async findLegacyTenantMapping() { return undefined; }
  async findServiceTenantGrant(principalId: string, tenantId: string): Promise<ServiceTenantGrant | undefined> {
    if (principalId !== SERVICE_ID || tenantId !== TENANT_ID) return undefined;
    return {
      principalId: SERVICE_ID,
      tenantId: TENANT_ID,
      principalKind: 'SERVICE',
      principalStatus: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      scopes: ['CREDENTIAL_USE'],
    };
  }
}

class SyntheticResolutionRepository implements CredentialResolutionRepository {
  readonly snapshot: CredentialResolutionSnapshot;
  calls = 0;

  constructor(snapshot: CredentialResolutionSnapshot) { this.snapshot = snapshot; }

  async inspect(): Promise<CredentialResolutionSnapshot> {
    this.calls += 1;
    return this.snapshot;
  }
}

class SyntheticResolutionAudit implements CredentialResolutionAuditPort {
  readonly entries: CredentialResolutionAuditEntry[] = [];
  async recordSelection(entry: CredentialResolutionAuditEntry) { this.entries.push(entry); }
}

class SyntheticSecretExecutor implements CredentialSecretExecutor {
  readonly selections: Array<CredentialBinding & { readonly operation: string }> = [];

  async withCredential(
    input: CredentialBinding & { readonly actorRef: string; readonly correlationId: string; readonly operation: string },
    execute: (secret: string) => Promise<void>,
  ): Promise<void> {
    this.selections.push({ ...input });
    await execute(SYNTHETIC_SECRET);
  }
}

function candidate(credentialId: string, authorizationId: string, family: string): CredentialResolutionCandidate {
  return {
    binding: {
      tenantId: TENANT_ID,
      credentialId,
      authorizationId,
      appConfigurationId: APP_ID,
      provider: 'META',
      environment: 'test',
      family,
    },
    authorizationState: 'ACTIVE',
    authorizationVersion: 1,
    credentialStatus: 'ACTIVE',
    credentialVersion: 1,
    assetAuthorizationState: 'ACTIVE',
    assetVerificationState: 'VERIFIED',
    assetAuthorizationVersion: 1,
    grantAssetId: ASSET_ID,
    grantAssetKind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    lineage: [],
    grantedAssetGrants: ['SYNTHETIC_IG_ASSET_GRANT'],
    grantedAuthorizationScopes: ['SYNTHETIC_IG_MESSAGE_SCOPE'],
    secretAvailable: true,
    secretVersion: 1,
    health: { state: 'HEALTHY', observedAt: OBSERVED_AT, source: 'META_API' },
    expiry: { state: 'KNOWN', expiresAt: EXPIRES_AT, observedAt: OBSERVED_AT, source: 'META_API' },
    dataAccessExpiry: { state: 'KNOWN', expiresAt: EXPIRES_AT, observedAt: OBSERVED_AT, source: 'META_API' },
  };
}

test('M4.14 selects the preferred exact synthetic credential through an opaque handle and never exposes its secret', async () => {
  const context: CredentialResolutionContext = {
    tenantId: TENANT_ID,
    provider: 'META',
    appConfigurationId: APP_ID,
    environment: 'test',
    assetId: ASSET_ID,
    operation: 'SEND_MESSAGE',
  };
  const policy: CredentialOperationPolicy = {
    ...context,
    version: 1,
    flowVariant: 'INSTAGRAM',
    authVariant: 'INSTAGRAM_LOGIN',
    capability: 'SEND_MESSAGE',
    purpose: 'CUSTOMER_OPERATION',
    assetKinds: ['INSTAGRAM_BUSINESS_ACCOUNT'],
    allowedFamilies: ['SYNTHETIC_IG_FALLBACK', 'SYNTHETIC_IG_LOGIN'],
    preferredFamilies: ['SYNTHETIC_IG_LOGIN', 'SYNTHETIC_IG_FALLBACK'],
    requiredAssetGrants: ['SYNTHETIC_IG_ASSET_GRANT'],
    requiredAuthorizationScopes: ['SYNTHETIC_IG_MESSAGE_SCOPE'],
    ancestryRules: [],
    allowExpiring: false,
    maxHealthObservationAgeSeconds: 3600,
  };
  const fallback = candidate(FALLBACK_CREDENTIAL_ID, FALLBACK_AUTHORIZATION_ID, 'SYNTHETIC_IG_FALLBACK');
  const preferred = candidate(PREFERRED_CREDENTIAL_ID, PREFERRED_AUTHORIZATION_ID, 'SYNTHETIC_IG_LOGIN');
  const repository = new SyntheticResolutionRepository({
    asset: { assetId: ASSET_ID, kind: 'INSTAGRAM_BUSINESS_ACCOUNT', verified: true, version: 1 },
    candidates: [fallback, preferred],
  });
  const policies: CredentialOperationPolicyPort = { async findPolicy() { return policy; } };
  const audit = new SyntheticResolutionAudit();
  const vault = new SyntheticSecretExecutor();
  const tenantAuthorization = new ServiceTenantAuthorizationService(new SyntheticIdentityRepository());
  const authorization = {
    async authorize(scope: VerifiedServiceTenantScope, tenantId: string) {
      await tenantAuthorization.authorize(scope, 'CREDENTIAL_USE', tenantId);
    },
  };
  const service = new CredentialResolverService(repository, policies, authorization, audit, vault,
    () => Date.parse('2026-11-10T12:00:00.000Z'));
  const proof = await new SyntheticServiceCredentialVerifier().verifyCredential('m4-14-synthetic-service-proof');
  assert.ok(proof);
  const serviceScope = await tenantAuthorization.resolveScope(proof);
  const actor = { serviceScope, correlationId: CORRELATION_ID };

  const mismatched = await service.resolve(context, actor);
  await assert.rejects(service.withCredentialForContext(mismatched.handle, {
    ...context,
    flowVariant: 'INSTAGRAM',
    authVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN',
  }, async () => undefined), (error: unknown) =>
    error instanceof CredentialResolutionError && error.code === 'CONTEXT_CHANGED');
  assert.equal(vault.selections.length, 0, 'a different Instagram auth profile cannot consume the handle');

  const result = await service.resolve(context, actor);
  assert.equal(result.status, 'READY');
  assert.equal(result.family, 'SYNTHETIC_IG_LOGIN');
  assert.deepEqual(Object.keys(result.handle), [], 'the one-use handle has no enumerable credential fields');
  assert.equal(JSON.stringify(result).includes(PREFERRED_CREDENTIAL_ID), false);
  assert.equal(JSON.stringify(result).includes(PREFERRED_AUTHORIZATION_ID), false);
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_SECRET), false);
  assert.equal(audit.entries.at(-1)?.credentialId, PREFERRED_CREDENTIAL_ID,
    'the selection audit identifies the preferred synthetic credential');

  let secretStayedInsideCallback = false;
  await service.withCredentialForContext(result.handle, {
    ...context,
    flowVariant: 'INSTAGRAM',
    authVariant: 'INSTAGRAM_LOGIN',
  }, async (secret) => {
    assert.equal(secret, SYNTHETIC_SECRET);
    secretStayedInsideCallback = true;
  });
  assert.equal(secretStayedInsideCallback, true);
  assert.equal(vault.selections.length, 1);
  assert.equal(vault.selections[0]?.credentialId, PREFERRED_CREDENTIAL_ID,
    'the exact resolver-selected credential reaches the vault callback');
  assert.equal(JSON.stringify({ result, audit: audit.entries }).includes(SYNTHETIC_SECRET), false,
    'the secret marker is absent from the handle result and selection audit');
});

const LIFECYCLE_TENANT_ID = '30000000-0000-4000-8000-000000000001';
const LIFECYCLE_APP_ID = '30000000-0000-4000-8000-000000000002';
const LIFECYCLE_ASSET_ID = '30000000-0000-4000-8000-000000000003';
const LIFECYCLE_SESSION_ID = '30000000-0000-4000-8000-000000000004';
const LIFECYCLE_PRINCIPAL_ID = '30000000-0000-4000-8000-000000000005';

const LIFECYCLE_PROFILES = AUTH_PROFILES.map((profile) => ({
  ...profile,
  onboardingFlow: onboardingFlowForMetaProfile(profile.flowVariant, profile.authVariant),
}));

function lifecycleUuid(sequence: number): string {
  return '30000000-0000-4000-8000-' + sequence.toString().padStart(12, '0');
}

function lifecycleBinding(
  profile: (typeof LIFECYCLE_PROFILES)[number],
  sequence: number,
): ConnectionLifecycleBinding {
  return {
    tenantId: LIFECYCLE_TENANT_ID,
    authorizationId: lifecycleUuid(sequence),
    appConfigurationId: LIFECYCLE_APP_ID,
    environment: 'test',
    providerAuthorizationId: 'synthetic-provider-authorization-' + sequence,
    flowVariant: profile.flowVariant,
    authVariant: profile.authVariant,
    authorizationState: 'ACTIVE',
    authorizationVersion: 1,
    assetBindings: 4,
  };
}

async function lifecycleSession() {
  const verifier = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return {
        sessionId: LIFECYCLE_SESSION_ID,
        principalId: LIFECYCLE_PRINCIPAL_ID,
        tenantId: LIFECYCLE_TENANT_ID,
        contextVersion: 1,
        contextRefHash: 'c'.repeat(64),
        csrfTokenHash: 'd'.repeat(64),
        entryMode: 'PORTAL_TOP_LEVEL' as const,
      };
    },
  });
  const session = await verifier.verify('m4-14-synthetic-lifecycle-session-cookie-value');
  assert.ok(session);
  return session;
}

function lifecyclePorts() {
  const contexts = {
    async resolveCurrent() {
      return { tenantId: LIFECYCLE_TENANT_ID, principalId: LIFECYCLE_PRINCIPAL_ID, roles: ['owner'] };
    },
  } as unknown as TenantContextService;
  const authorization = {
    async authorize() { return undefined; },
  } as unknown as TenantAuthorizationService;
  return { contexts, authorization };
}

class SyntheticExpiringOnboardingStore implements OnboardingSessionStore {
  readonly records = new Map<string, OnboardingStoredRecord>();

  constructor(private readonly clock: () => Date) {}

  async findByIdempotency(tenantId: string, idempotencyHash: string): Promise<OnboardingStoredRecord | undefined> {
    const record = [...this.records.values()].find((candidate) => candidate.tenantId === tenantId &&
      candidate.idempotencyHash === idempotencyHash);
    if (!record) return undefined;
    if (record.expiresAt <= this.clock() && record.status === 'AWAITING_PROVIDER') {
      const expired = { ...record, status: 'EXPIRED' as const, nextAction: 'NONE' as const,
        stateConsumed: true, lastUpdatedAt: this.clock() };
      this.records.set(record.id, expired);
      return expired;
    }
    return record;
  }

  async createOrReplay(command: OnboardingCreateCommand): Promise<OnboardingStoredRecord> {
    const existing = await this.findByIdempotency(command.tenantId, command.idempotencyHash);
    if (existing) return existing;
    const record: OnboardingStoredRecord = {
      ...command,
      status: 'AWAITING_PROVIDER',
      readiness: 'UNKNOWN',
      steps: [
        { name: 'authorization', status: 'PENDING' },
        { name: 'asset-verification', status: 'PENDING' },
        { name: 'subscription', status: 'PENDING' },
        { name: 'projection', status: 'PENDING' },
      ],
      nextAction: 'WAIT',
      lastUpdatedAt: this.clock(),
      stateConsumed: false,
    };
    this.records.set(record.id, record);
    return record;
  }

  async findForSession(id: string, sessionId: string, principalId: string): Promise<OnboardingStoredRecord | undefined> {
    const record = this.records.get(id);
    return record?.portalSessionId === sessionId && record.principalId === principalId ? record : undefined;
  }

  async findByProviderStateHash(hash: string): Promise<OnboardingStoredRecord | undefined> {
    return [...this.records.values()].find((record) => record.providerStateHash === hash);
  }

  async cancelByProviderState(hash: string): Promise<boolean> {
    const record = await this.findByProviderStateHash(hash);
    if (!record || record.stateConsumed || record.status !== 'AWAITING_PROVIDER') return false;
    this.records.set(record.id, { ...record, status: 'CANCELLED', nextAction: 'NONE', stateConsumed: true });
    return true;
  }

  async completeByProviderState(): Promise<boolean> { return false; }
}

test('M4.14 persists expiry and prevents provider-state replay after timeout for all five profiles', async () => {
  const session = await lifecycleSession();
  const ports = lifecyclePorts();
  const encodedKey = Buffer.alloc(32, 0x71).toString('base64url');

  for (let index = 0; index < LIFECYCLE_PROFILES.length; index += 1) {
    const profile = LIFECYCLE_PROFILES[index]!;
    let currentTime = new Date('2026-11-10T12:00:00.000Z');
    const store = new SyntheticExpiringOnboardingStore(() => currentTime);
    const launchStates: string[] = [];
    const launch: OnboardingProviderLaunchPort = {
      async buildAuthorizationUrl(input) {
        launchStates.push(input.stateRef);
        const url = new URL('https://provider.synthetic.invalid/authorize');
        url.searchParams.set('state', input.stateRef);
        return url.toString();
      },
    };
    const configurations = {
      resolve(flowVariant: OnboardingFlowVariant) {
        const exact = LIFECYCLE_PROFILES.find((candidate) => candidate.onboardingFlow === flowVariant);
        if (!exact) return undefined;
        return {
          configurationRef: 'm4-14-synthetic-' + exact.authVariant.toLowerCase(),
          providerAppId: 'm4-14-synthetic-provider-app',
          providerEnvironment: 'test' as const,
          authVariant: exact.authVariant,
          capabilityManifestVersion: META_CAPABILITY_MANIFEST_VERSION,
          graphApiVersion: 'v27.0',
        };
      },
    };
    const service = new OnboardingSessionService(store, ports.contexts, ports.authorization,
      new OnboardingStateSigner(encodedKey), launch, () => currentTime, configurations);
    const idempotencyKey = 'm4-14-timeout-state-' + index;
    const created = await service.create(session, 'synthetic-m4-14-tenant-context', idempotencyKey, {
      flowVariant: profile.onboardingFlow,
      requestedCapabilities: [],
      returnRoute: 'connections',
    });
    assert.equal(launchStates.length, 1);
    assert.equal(created.expiresAt, new Date(Date.parse('2026-11-10T12:00:00.000Z') +
      ONBOARDING_STATE_TTL_SECONDS * 1000).toISOString());
    currentTime = new Date(Date.parse(created.expiresAt) + 1);

    await assert.rejects(service.create(session, 'synthetic-m4-14-tenant-context', idempotencyKey, {
      flowVariant: profile.onboardingFlow,
      requestedCapabilities: [],
      returnRoute: 'connections',
    }));
    const expired = store.records.get(created.id);
    assert.equal(expired?.status, 'EXPIRED');
    assert.equal(expired?.stateConsumed, true);
    assert.equal(launchStates.length, 1, 'timeout replay does not reissue provider state');
  }
});

function partialPermissionProfile(
  flowVariant: MetaAppConfiguration['flowVariant'],
  authVariant: MetaAppConfiguration['authVariant'],
): { readonly profile: MetaAppConfiguration; readonly operation: string } {
  const profile = unconfirmedReviewProfile(flowVariant, authVariant);
  const target = META_CAPABILITY_MANIFEST.find((entry) => entry.flowVariant === flowVariant &&
    entry.authVariant === authVariant && entry.candidatePermissions.length > 0);
  if (!target) throw new Error('No synthetic permission-bearing operation exists for the exact auth profile.');
  let marked = false;
  const capabilityEvidence = profile.capabilityEvidence.map((entry) => entry.operation !== target.operation || marked
    ? entry
    : {
      ...entry,
      permissions: entry.permissions.map((permission) => {
        if (marked) return permission;
        marked = true;
        return { ...permission, permissionStatus: 'NOT_CONFIRMED' as const };
      }),
    });
  if (!marked) throw new Error('A required synthetic permission was not marked partial.');
  return { profile: { ...profile, capabilityEvidence }, operation: target.operation };
}

test('M4.14 keeps every exact profile and prior authorization blocked when one required permission is unconfirmed', async () => {
  const partial = AUTH_PROFILES.map(({ flowVariant, authVariant }) =>
    partialPermissionProfile(flowVariant, authVariant));
  const registry = new MetaAppConfigRegistry(partial.map((entry) => entry.profile));
  const sessionStore = {
    writes: 0,
    async findByIdempotency() { return undefined; },
    async createOrReplay(_command: OnboardingCreateCommand) {
      this.writes += 1;
      throw new Error('blocked configuration must not persist a replacement onboarding session');
    },
    async findForSession() { return undefined; },
    async findByProviderStateHash() { return undefined; },
    async cancelByProviderState() { return false; },
    async completeByProviderState() { return false; },
  } satisfies OnboardingSessionStore & { writes: number };
  const launch: OnboardingProviderLaunchPort = {
    async buildAuthorizationUrl() { throw new Error('blocked profile must not create a provider URL'); },
  };
  const ports = lifecyclePorts();
  const resolver = new MetaOnboardingConfigurationResolver(registry, 'test');
  const onboarding = new OnboardingSessionService(sessionStore, ports.contexts, ports.authorization,
    new OnboardingStateSigner(Buffer.alloc(32, 0x52).toString('base64url')), launch,
    () => new Date('2026-11-10T12:00:00.000Z'), resolver);
  const session = await lifecycleSession();

  for (let index = 0; index < LIFECYCLE_PROFILES.length; index += 1) {
    const profile = LIFECYCLE_PROFILES[index]!;
    const binding = lifecycleBinding(profile, 100 + index);
    let associationWrites = 0;
    const repository = {
      async findBinding(input: { readonly tenantId: string; readonly authorizationId: string }) {
        assert.equal(input.tenantId, LIFECYCLE_TENANT_ID);
        assert.equal(input.authorizationId, binding.authorizationId);
        return binding;
      },
      async associateReauthorization() { associationWrites += 1; },
    } as unknown as ConnectionLifecycleCommandRepository;
    const lifecycle = new ConnectionLifecycleService(repository, ports.contexts, ports.authorization, onboarding);
    const partialCase = partial[index]!;
    const capability = registry.bootstrap().profiles.find((entry) => entry.flowVariant === profile.flowVariant &&
      entry.authVariant === profile.authVariant)?.capabilities.find((entry) => entry.operation === partialCase.operation);
    assert.equal(capability?.enabled, false);
    assert.equal(capability?.reasonCode, 'CAPABILITY_EVIDENCE_MISSING');
    assert.equal(registry.resolve(profile.flowVariant, profile.authVariant, 'test'), undefined);
    await assert.rejects(lifecycle.reauthorize({
      session,
      tenantContextRef: 'synthetic-m4-14-tenant-context',
      authorizationRef: binding.authorizationId,
      idempotencyKey: 'm4-14-partial-permission-' + index,
      requestId: 'm4-14-partial-permission-' + index,
    }), (error: unknown) => error instanceof ConnectionLifecycleConfigurationUnavailableError);
    assert.equal(binding.authorizationState, 'ACTIVE', 'the prior persisted authorization remains active');
    assert.equal(associationWrites, 0, 'no replacement session is associated after a partial permission gate');
  }
  assert.equal(sessionStore.writes, 0, 'no new onboarding record is written under partial permission evidence');
});

test('M4.14 consumes provider cancellation only for the exact flow/auth pair and blocks replay for all five profiles', async () => {
  const callbackProfiles = [
    { flowVariant: 'FACEBOOK_LOGIN', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', callback: 'facebook-login' },
    { flowVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN', authVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN', callback: 'instagram-via-facebook-login' },
    { flowVariant: 'INSTAGRAM_LOGIN', authVariant: 'INSTAGRAM_LOGIN', callback: 'instagram-login' },
    { flowVariant: 'WHATSAPP_CLOUD_API', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', callback: 'whatsapp-cloud-api' },
    { flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING', callback: 'whatsapp-coexistence' },
  ] as const;
  const records = new Map<string, OnboardingStoredRecord>();
  const store: OnboardingSessionStore = {
    async findByIdempotency() { return undefined; },
    async createOrReplay() { throw new Error('callback test does not create onboarding records'); },
    async findForSession() { return undefined; },
    async findByProviderStateHash(hash) { return [...records.values()].find((record) => record.providerStateHash === hash); },
    async cancelByProviderState(hash) {
      const record = [...records.values()].find((candidate) => candidate.providerStateHash === hash);
      if (!record || record.stateConsumed || record.status !== 'AWAITING_PROVIDER') return false;
      records.set(record.id, { ...record, status: 'CANCELLED', readiness: 'UNKNOWN', nextAction: 'NONE', stateConsumed: true });
      return true;
    },
    async completeByProviderState() { return false; },
  };
  const encodedKey = Buffer.alloc(32, 0x62).toString('base64url');
  const service = new OnboardingCodeSubmissionService(store, {} as unknown as TenantContextService,
    {} as unknown as TenantAuthorizationService, { resolve() { return undefined; } }, new OnboardingCodeProtector(encodedKey),
    {} as unknown as MysqlOnboardingCodeSubmissionStore, {} as unknown as OnboardingSagaAdapter,
    () => new Date('2026-11-10T12:00:00.000Z'));
  const defaultSteps = [
    { name: 'authorization', status: 'PENDING' as const },
    { name: 'asset-verification', status: 'PENDING' as const },
    { name: 'subscription', status: 'PENDING' as const },
    { name: 'projection', status: 'PENDING' as const },
  ];

  for (let index = 0; index < callbackProfiles.length; index += 1) {
    const profile = callbackProfiles[index]!;
    const stateRef = 'm4-14-state-callback-' + index.toString().padStart(12, '0');
    const recordId = lifecycleUuid(200 + index);
    const record: OnboardingStoredRecord = {
      id: recordId,
      tenantId: LIFECYCLE_TENANT_ID,
      principalId: LIFECYCLE_PRINCIPAL_ID,
      portalSessionId: LIFECYCLE_SESSION_ID,
      tenantContextHash: 'e'.repeat(64),
      flowVariant: profile.flowVariant,
      configurationRef: 'm4-14-synthetic-config',
      providerAppId: '987654321012345',
      providerEnvironment: 'test',
      authVariant: profile.authVariant,
      capabilityManifestVersion: META_CAPABILITY_MANIFEST_VERSION,
      graphApiVersion: 'v27.0',
      requestedCapabilities: [],
      returnRoute: 'connections',
      idempotencyHash: hashOnboardingValue('m4-14-idempotency-' + index),
      requestHash: hashOnboardingValue('m4-14-request-' + index),
      providerStateHash: hashOnboardingValue(stateRef),
      expiresAt: new Date('2026-11-10T12:10:00.000Z'),
      status: 'AWAITING_PROVIDER',
      readiness: 'UNKNOWN',
      steps: defaultSteps,
      nextAction: 'WAIT',
      lastUpdatedAt: new Date('2026-11-10T12:00:00.000Z'),
      stateConsumed: false,
    };
    records.set(record.id, record);

    const wrongCallback = profile.callback === 'facebook-login' ? 'instagram-login' : 'facebook-login';
    await assert.rejects(service.callback(wrongCallback, stateRef, undefined, 'access_denied'),
      (error: unknown) => error instanceof OnboardingCodeNotFoundError);
    assert.equal(records.get(record.id)?.status, 'AWAITING_PROVIDER');
    await service.callback(profile.callback, stateRef, undefined, 'access_denied');
    assert.equal(records.get(record.id)?.status, 'CANCELLED');
    assert.equal(records.get(record.id)?.stateConsumed, true);
    await assert.rejects(service.callback(profile.callback, stateRef, 'synthetic-authorization-code', undefined),
      (error: unknown) => error instanceof OnboardingCodeConflictError);
    assert.equal(records.get(record.id)?.status, 'CANCELLED');
  }
});

test('M4.14 creates a reauthorization session for the exact auth profile and preserves prior authorizations', async () => {
  const session = await lifecycleSession();
  const ports = lifecyclePorts();

  for (let index = 0; index < LIFECYCLE_PROFILES.length; index += 1) {
    const profile = LIFECYCLE_PROFILES[index]!;
    const binding = lifecycleBinding(profile, 300 + index);
    let associatedAuthorization: string | undefined;
    let createdFlow: OnboardingFlowVariant | undefined;
    const repository = {
      async findBinding() { return binding; },
      async associateReauthorization(input: { readonly authorizationId: string }) {
        associatedAuthorization = input.authorizationId;
      },
    } as unknown as ConnectionLifecycleCommandRepository;
    const onboarding = {
      async create(_session: unknown, _contextRef: string, _key: string, input: { readonly flowVariant: OnboardingFlowVariant }) {
        createdFlow = input.flowVariant;
        return {
          id: lifecycleUuid(400 + index),
          status: 'AWAITING_PROVIDER' as const,
          expiresAt: '2026-11-10T12:10:00.000Z',
          launchUrl: 'https://m4-14.example.invalid/authorize?state=synthetic',
        };
      },
    } as unknown as OnboardingSessionService;
    const lifecycle = new ConnectionLifecycleService(repository, ports.contexts, ports.authorization, onboarding);
    const result = await lifecycle.reauthorize({
      session,
      tenantContextRef: 'synthetic-m4-14-tenant-context',
      authorizationRef: binding.authorizationId,
      idempotencyKey: 'm4-14-reauthorization-' + index,
      requestId: 'm4-14-reauthorization-' + index,
    });
    assert.equal(createdFlow, profile.onboardingFlow);
    assert.equal(result.status, 'AWAITING_PROVIDER');
    assert.equal(associatedAuthorization, binding.authorizationId);
    assert.equal(binding.authorizationState, 'ACTIVE', 'reauthorization does not replace or revoke the old grant');
  }
});

test('M4.14 disconnects only the selected asset and blocks provider cleanup for all five exact auth profiles', async () => {
  const session = await lifecycleSession();
  const ports = lifecyclePorts();

  for (let index = 0; index < LIFECYCLE_PROFILES.length; index += 1) {
    const profile = LIFECYCLE_PROFILES[index]!;
    const binding = lifecycleBinding(profile, 500 + index);
    let disconnectedAsset: string | null | undefined;
    const repository = {
      async findBinding() { return binding; },
      async disconnect(input: { readonly assetId: string | null }) {
        disconnectedAsset = input.assetId;
        return {
          commandRef: lifecycleUuid(600 + index),
          localState: 'DISCONNECTED' as const,
          cleanupState: 'BLOCKED' as const,
          safeReasonCode: 'PROVIDER_OFFBOARDING_NOT_CONFIRMED' as const,
        };
      },
    } as unknown as ConnectionLifecycleCommandRepository;
    const lifecycle = new ConnectionLifecycleService(repository, ports.contexts, ports.authorization,
      {} as OnboardingSessionService);
    const result = await lifecycle.disconnect({
      session,
      tenantContextRef: 'synthetic-m4-14-tenant-context',
      authorizationRef: binding.authorizationId,
      assetRef: LIFECYCLE_ASSET_ID,
      idempotencyKey: 'm4-14-disconnect-asset-' + index,
      correlationId: lifecycleUuid(700 + index),
    });
    assert.equal(disconnectedAsset, LIFECYCLE_ASSET_ID,
      'only the selected asset is changed for ' + profile.flowVariant + ':' + profile.authVariant);
    assert.equal(result.localState, 'DISCONNECTED');
    assert.equal(result.cleanupState, 'BLOCKED');
    assert.equal(result.safeReasonCode, 'PROVIDER_OFFBOARDING_NOT_CONFIRMED');
    assert.equal(binding.authorizationState, 'ACTIVE', 'sibling grants and provider authorization are preserved');
  }
});
