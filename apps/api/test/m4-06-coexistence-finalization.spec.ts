import assert from 'node:assert/strict';
import test from 'node:test';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import { ServiceCredentialVerifier } from '../src/identity/identity.trust.js';
import type { ServiceTenantGrant } from '../src/identity/identity.types.js';
import type { VerifiedServiceCredential } from '../src/identity/identity.trust.js';
import type { MetaSubscriptionActor, MetaSubscriptionReconcileResult, MetaSubscriptionRequest } from '../src/meta-subscriptions/meta-subscriptions.types.js';
import type { MetaSubscriptionService } from '../src/meta-subscriptions/meta-subscription.service.js';
import { CoexistenceOnboardingSagaAdapter, M4_11CoexistenceSubscriptionPort,
  UnavailableCoexistenceSagaPorts, coexistenceSubscriptionRequest, type CoexistenceSagaPorts,
  type CoexistenceSubscriptionInput } from '../src/onboarding/coexistence-saga.adapter.js';
import { OnboardingSagaEffectError, type OnboardingSagaContext, type OnboardingSagaReconciliation } from '../src/onboarding/onboarding-saga.types.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const PRINCIPAL = '10000000-0000-4000-8000-000000000002';
const APP_CONFIGURATION_ID = '10000000-0000-4000-8000-000000000003';
const SESSION = '10000000-0000-4000-8000-000000000004';
const ONBOARDING = '10000000-0000-4000-8000-000000000005';
const CORRELATION = '10000000-0000-4000-8000-000000000006';
const AUTHORIZATION = '10000000-0000-4000-8000-000000000007';
const PHONE = '10000000-0000-4000-8000-000000000008';
const ACCOUNT = '10000000-0000-4000-8000-000000000009';
const SUBSCRIPTION = `internal:subscription:${'a'.repeat(64)}`;
const CONFIG = 'm4-01-coexistence-profile';
const id = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function context(overrides: Partial<OnboardingSagaContext> = {}): OnboardingSagaContext {
  return Object.freeze({ tenantId: TENANT, onboardingId: ONBOARDING, flowVariant: 'WHATSAPP_COEXISTENCE',
    authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING', configurationRef: CONFIG, principalId: PRINCIPAL,
    portalSessionId: SESSION, correlationId: CORRELATION, graphApiVersion: 'v99.0',
    capabilityManifestVersion: 'm4.01-synthetic', ...overrides });
}

function operation<T extends Record<string, unknown>>(input: T): T & { readonly idempotencyKey: string; readonly signal: AbortSignal } {
  const onboardingId = typeof input.onboardingId === 'string' ? input.onboardingId : ONBOARDING;
  return Object.freeze({ ...input, idempotencyKey: `${onboardingId}:subscription`, signal: new AbortController().signal });
}

class FakePorts implements CoexistenceSagaPorts {
  readonly calls: string[] = [];
  readonly exchangeCodes: string[] = [];
  readonly subscriptionInputs: Array<{ tenantId: string; authorizationRef: string; phoneAssetRef: string; idempotencyKey: string }> = [];
  readonly phoneRefByOnboarding = new Map<string, string>();
  assetResult: { readonly state: 'VERIFIED'; readonly phoneAssetRef: string; readonly businessAccountAssetRef: string } |
    { readonly state: 'NO_ELIGIBLE_PHONE' | 'SELECTION_REQUIRED' | 'GRANT_NOT_CONFIRMED' } =
      { state: 'VERIFIED', phoneAssetRef: PHONE, businessAccountAssetRef: ACCOUNT };
  subscriptionResult: MetaSubscriptionReconcileResult = { state: 'ACTIVE', desiredState: 'SUBSCRIBED', observedState: 'SUBSCRIBED', version: 1 };
  readonly reconciliation: OnboardingSagaReconciliation = { disposition: 'UNKNOWN' };

  readonly authorization: CoexistenceSagaPorts['authorization'] = {
    exchangeAndStore: async (input) => {
      this.calls.push('authorization.exchangeAndStore');
      this.exchangeCodes.push(input.code);
      return { authorizationRef: AUTHORIZATION };
    },
    reconcile: async () => { this.calls.push('authorization.reconcile'); return this.reconciliation; },
  };
  readonly assets: CoexistenceSagaPorts['assets'] = {
    verifyAndPersist: async (input) => {
      this.calls.push('assets.verifyAndPersist');
      const phoneAssetRef = this.phoneRefByOnboarding.get(input.onboardingId);
      return phoneAssetRef ? { state: 'VERIFIED', phoneAssetRef, businessAccountAssetRef: ACCOUNT } : this.assetResult;
    },
    reconcile: async () => { this.calls.push('assets.reconcile'); return this.reconciliation; },
  };
  readonly subscriptions: CoexistenceSagaPorts['subscriptions'] = {
    connect: async (input) => {
      this.calls.push('subscriptions.connect');
      this.subscriptionInputs.push({ tenantId: input.tenantId, authorizationRef: input.authorizationRef,
        phoneAssetRef: input.phoneAssetRef, idempotencyKey: input.idempotencyKey });
      return this.subscriptionResult;
    },
    reconcile: async () => { this.calls.push('subscriptions.reconcile'); return this.reconciliation; },
  };
  readonly projection: CoexistenceSagaPorts['projection'] = {
    publish: async () => { this.calls.push('projection.publish'); },
    reconcile: async () => { this.calls.push('projection.reconcile'); return this.reconciliation; },
  };
}

test('adapter rejects every non-Coexistence flow before touching a provider port', async () => {
  const ports = new FakePorts();
  const adapter = new CoexistenceOnboardingSagaAdapter(ports);
  await assert.rejects(() => adapter.exchangeAuthorizationCode(operation({ ...context({ flowVariant: 'WHATSAPP_CLOUD_API' }),
    code: 'synthetic-code' })), (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
  assert.deepEqual(ports.calls, []);
});

test('exchange returns only an internal authorization reference; the port owns vault persistence', async () => {
  const ports = new FakePorts();
  const result = await new CoexistenceOnboardingSagaAdapter(ports).exchangeAuthorizationCode(
    operation({ ...context(), code: 'synthetic-one-use-code' }));
  assert.deepEqual(result, { authorizationRef: AUTHORIZATION });
  assert.deepEqual(ports.exchangeCodes, ['synthetic-one-use-code']);
  assert.equal(JSON.stringify(result).includes('synthetic-one-use-code'), false);
  assert.equal('credential' in result, false);
  assert.equal('accessToken' in result, false);
});

test('asset discovery returns only a verified phone and its verified account relation', async () => {
  const ports = new FakePorts();
  const result = await new CoexistenceOnboardingSagaAdapter(ports).discoverAndPersistAssets(
    operation({ ...context(), authorizationRef: AUTHORIZATION }));
  assert.deepEqual(result.assetRefs, [PHONE, ACCOUNT]);
  assert.equal(Object.keys(result).some((key) => /provider|external|token|credential/i.test(key)), false);
});

test('ambiguous or grant-incomplete discovery cannot continue to subscription or projection', async () => {
  for (const state of ['SELECTION_REQUIRED', 'GRANT_NOT_CONFIRMED', 'NO_ELIGIBLE_PHONE'] as const) {
    const ports = new FakePorts();
    ports.assetResult = { state };
    const adapter = new CoexistenceOnboardingSagaAdapter(ports);
    await assert.rejects(() => adapter.discoverAndPersistAssets(operation({ ...context(), authorizationRef: AUTHORIZATION })),
      (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
    assert.deepEqual(ports.calls, ['assets.verifyAndPersist']);
  }
});

test('M4.11 subscription is accepted only after observed SUBSCRIBED for the exact phone grant', async () => {
  const ports = new FakePorts();
  const adapter = new CoexistenceOnboardingSagaAdapter(ports);
  await adapter.ensureSubscriptions(operation({ ...context(), authorizationRef: AUTHORIZATION, assetRefs: [PHONE, ACCOUNT] }));
  assert.deepEqual(ports.subscriptionInputs, [{ tenantId: TENANT, authorizationRef: AUTHORIZATION,
    phoneAssetRef: PHONE, idempotencyKey: `${ONBOARDING}:subscription` }]);

  ports.subscriptionResult = { state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version: 2,
    reasonCode: 'PROVIDER_DEPENDENCY_UNAVAILABLE' };
  await assert.rejects(() => adapter.ensureSubscriptions(operation({ ...context(), authorizationRef: AUTHORIZATION,
    assetRefs: [PHONE, ACCOUNT] })), (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'UNKNOWN');
  assert.equal(ports.subscriptionInputs[1]?.idempotencyKey, ports.subscriptionInputs[0]?.idempotencyKey);
  assert.equal(ports.calls.includes('authorization.exchangeAndStore'), false);
});

test('unconfirmed subscription semantics and wrong asset pairs never create a success receipt', async () => {
  const ports = new FakePorts();
  const adapter = new CoexistenceOnboardingSagaAdapter(ports);
  ports.subscriptionResult = { state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version: 0,
    reasonCode: 'SUBSCRIPTION_VARIANT_NOT_CONFIRMED' };
  await assert.rejects(() => adapter.ensureSubscriptions(operation({ ...context(), authorizationRef: AUTHORIZATION,
    assetRefs: [PHONE, ACCOUNT] })), (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
  await assert.rejects(() => adapter.ensureSubscriptions(operation({ ...context(), authorizationRef: AUTHORIZATION,
    assetRefs: [id(20), ACCOUNT] })), (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
  assert.equal(ports.calls.includes('projection.publish'), false);
});

test('projection requires both internal relation refs and a subscription receipt', async () => {
  const ports = new FakePorts();
  const adapter = new CoexistenceOnboardingSagaAdapter(ports);
  await assert.rejects(() => adapter.publishProjection(operation({ ...context(), authorizationRef: AUTHORIZATION,
    assetRefs: [PHONE, ACCOUNT], subscriptionRef: 'unverified' })),
  (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
  await adapter.publishProjection(operation({ ...context(), authorizationRef: AUTHORIZATION, assetRefs: [PHONE, ACCOUNT],
    subscriptionRef: SUBSCRIPTION }));
  assert.deepEqual(ports.calls, ['projection.publish']);
});

test('reconcile dispatch is read-only and never calls an effect port', async () => {
  const ports = new FakePorts();
  const result = await new CoexistenceOnboardingSagaAdapter(ports).reconcileStage(operation({ ...context(), stage: 'subscription',
    evidence: { authorizationRef: AUTHORIZATION, verifiedAssetRefs: [PHONE, ACCOUNT] } }));
  assert.deepEqual(result, { disposition: 'UNKNOWN' });
  assert.deepEqual(ports.calls, ['subscriptions.reconcile']);
});

test('M4.11 adapter builds a tenant-scoped request from internal refs and a verified worker scope', async () => {
  class SyntheticCredential extends ServiceCredentialVerifier {
    override async verifyCredential(_credential: string | undefined): Promise<VerifiedServiceCredential> {
      return this.issueVerifiedServiceCredential(PRINCIPAL, TENANT);
    }
  }
  const grant: ServiceTenantGrant = { tenantId: TENANT, principalId: PRINCIPAL, principalKind: 'SERVICE', principalStatus: 'ACTIVE',
    tenantStatus: 'ACTIVE', scopes: ['META_CONNECTION_EXECUTE'] };
  const repository = { findServiceTenantGrant: async () => grant } as unknown as IdentityRepository;
  const credential = await new SyntheticCredential().verifyCredential('synthetic-only');
  const scope = await new ServiceTenantAuthorizationService(repository).resolveScope(credential);
  const actor: MetaSubscriptionActor = Object.freeze({ serviceScope: scope, correlationId: CORRELATION });
  let savedRequest: MetaSubscriptionRequest | undefined;
  let reconcileReads = 0;
  const service = { connect: async (request: MetaSubscriptionRequest, suppliedActor: MetaSubscriptionActor) => {
    assert.equal(suppliedActor, actor);
    savedRequest = request;
    return { state: 'ACTIVE', desiredState: 'SUBSCRIBED', observedState: 'SUBSCRIBED', version: 1 } as MetaSubscriptionReconcileResult;
  } } as unknown as MetaSubscriptionService;
  const port = new M4_11CoexistenceSubscriptionPort(service, { resolve: async () => ({ appConfigurationId: APP_CONFIGURATION_ID,
    environment: 'test', actor }) }, {
    read: async () => { reconcileReads += 1; return { disposition: 'NO_EFFECT' }; },
  });
  const input = operation({ ...context(), authorizationRef: AUTHORIZATION, phoneAssetRef: PHONE });
  const result = await port.connect(input);
  assert.equal(result.state, 'ACTIVE');
  assert.deepEqual(savedRequest, { tenantId: TENANT, appConfigurationId: APP_CONFIGURATION_ID, environment: 'test', assetId: PHONE,
    authorizationId: AUTHORIZATION, desiredFields: [], correlationId: CORRELATION });
  assert.equal(JSON.stringify(savedRequest).includes('providerObjectId'), false);
  const reconciliation = await port.reconcile(operation({ ...context(), stage: 'subscription', evidence: {} }));
  assert.deepEqual(reconciliation, { disposition: 'NO_EFFECT' });
  assert.equal(reconcileReads, 1);
});

test('four synthetic phone bindings keep distinct authorization refs under one account target', async () => {
  const targetBindings = new Map<string, Set<string>>();
  let remoteSubscribeCalls = 0;
  const ports = new FakePorts();
  ports.subscriptions.connect = async (input: CoexistenceSubscriptionInput) => {
    const bindings = targetBindings.get(ACCOUNT) ?? new Set<string>();
    targetBindings.set(ACCOUNT, bindings);
    const binding = `${input.phoneAssetRef}:${input.authorizationRef}`;
    if (!bindings.has(binding)) bindings.add(binding);
    if (remoteSubscribeCalls === 0) remoteSubscribeCalls += 1;
    ports.subscriptionInputs.push({ tenantId: input.tenantId, authorizationRef: input.authorizationRef,
      phoneAssetRef: input.phoneAssetRef, idempotencyKey: input.idempotencyKey });
    return { state: 'ACTIVE', desiredState: 'SUBSCRIBED', observedState: 'SUBSCRIBED', version: bindings.size };
  };
  const adapter = new CoexistenceOnboardingSagaAdapter(ports);
  for (let index = 1; index <= 4; index += 1) {
    const onboardingId = id(index);
    const authorizationRef = id(10 + index);
    const phoneAssetRef = id(30 + index);
    ports.phoneRefByOnboarding.set(onboardingId, phoneAssetRef);
    const sessionContext = context({ onboardingId });
    const assets = await adapter.discoverAndPersistAssets(operation({ ...sessionContext, authorizationRef }));
    assert.deepEqual(assets.assetRefs, [phoneAssetRef, ACCOUNT]);
    await adapter.ensureSubscriptions(operation({ ...sessionContext, authorizationRef, assetRefs: assets.assetRefs }));
    assert.equal(ports.subscriptionInputs[index - 1]?.authorizationRef, authorizationRef);
  }
  assert.equal(targetBindings.get(ACCOUNT)?.size, 4);
  assert.equal(remoteSubscribeCalls, 1);
  assert.equal('registerPhone' in ports, false);
  assert.equal('deregisterPhone' in ports, false);
  assert.equal('deleteAsset' in ports, false);
});

test('disabled provider ports fail closed and provide no registration or deletion method', async () => {
  const ports = new UnavailableCoexistenceSagaPorts();
  const adapter = new CoexistenceOnboardingSagaAdapter(ports);
  await assert.rejects(() => adapter.exchangeAuthorizationCode(operation({ ...context(), code: 'synthetic-only' })),
    (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
  assert.deepEqual(Object.keys(ports).sort(), ['assets', 'authorization', 'projection', 'subscriptions']);
  assert.equal('registerPhone' in ports, false);
  assert.equal('deregisterPhone' in ports, false);
  assert.equal('deleteAsset' in ports, false);
});

test('subscription request helper never accepts provider IDs or non-Coexistence variants', () => {
  const request = coexistenceSubscriptionRequest({ ...context(), authorizationRef: AUTHORIZATION, phoneAssetRef: PHONE,
    idempotencyKey: `${ONBOARDING}:subscription`, signal: new AbortController().signal }, PHONE, APP_CONFIGURATION_ID, 'test');
  assert.deepEqual(request, { tenantId: TENANT, appConfigurationId: APP_CONFIGURATION_ID, environment: 'test', assetId: PHONE,
    authorizationId: AUTHORIZATION, desiredFields: [], correlationId: CORRELATION });
  assert.equal('providerObjectId' in request, false);
  assert.throws(() => coexistenceSubscriptionRequest({ ...context({ flowVariant: 'WHATSAPP_CLOUD_API' }),
    authorizationRef: AUTHORIZATION, phoneAssetRef: PHONE, idempotencyKey: `${ONBOARDING}:subscription`,
    signal: new AbortController().signal }, PHONE, APP_CONFIGURATION_ID, 'test'),
  (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
});
