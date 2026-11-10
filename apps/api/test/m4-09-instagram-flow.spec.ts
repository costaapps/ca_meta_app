import assert from 'node:assert/strict';
import test from 'node:test';
import { OnboardingSagaEffectError, type OnboardingSagaContext } from '../src/onboarding/onboarding-saga.types.js';
import {
  InstagramAccountStoreNotConfigured,
  InstagramOnboardingAdapter,
  InstagramProviderNotConfigured,
  InstagramSubscriptionsNotConfigured,
  type InstagramAccountStore,
  type InstagramDiscoveredAccount,
  type InstagramDiscoveryResult,
  type InstagramOnboardingContext,
  type InstagramProjectionPort,
  type InstagramProvider,
  type InstagramSubscriptionPort,
  instagramPageLinkRequired,
  isInstagramOnboardingContext,
  persistedInstagramAuthorizationVariant,
} from '../src/meta-instagram/instagram-onboarding.adapter.js';

const tenantId = 'a406aaf4-837a-45d7-9f93-4db17920668d';
const onboardingId = '11de9f8d-efdf-46c9-84b1-9d474a5a35dc';
const authorizationRef = '6a191a66-8cc3-4e65-89eb-5af25cb898a6';
const accountRef = 'f1c90208-010c-48b0-90e3-ef28f825efdd';
const secondAccountRef = 'd82046e2-3c09-4bfe-b7de-99c7a8c7ca72';
const pageRef = 'fb5941a7-3220-4d8a-bbdd-21581a714833';
const credentialRef = '38cdb87d-b1f8-4702-bbd2-095f44a0f478';
const secondCredentialRef = '9f4e2a7b-4c68-4aa1-87dd-8e5d2a4a8731';
const subscriptionRef = 'f3831bb3-05b1-4a2d-8a60-a717c706963d';
const correlationId = '8c4a3a46-0230-4dc8-9570-c0c34cbaacbb';
const idempotencyKey = 'm4-09-synthetic-idempotency-key';
const syntheticCode = 'synthetic-instagram-code-never-a-real-credential';

function context(variant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN' = 'INSTAGRAM_VIA_FACEBOOK_LOGIN'): InstagramOnboardingContext {
  return Object.freeze({
    tenantId,
    onboardingId,
    flowVariant: variant,
    authVariant: variant,
    configurationRef: 'synthetic-instagram-config-v1',
    principalId: 'synthetic-principal',
    portalSessionId: 'synthetic-session',
    correlationId,
    graphApiVersion: 'v99.0',
    capabilityManifestVersion: 'synthetic-capabilities-v1',
  });
}

function account(input: Partial<InstagramDiscoveredAccount> = {}): InstagramDiscoveredAccount {
  return Object.freeze({
    providerAccountId: 'synthetic-instagram-asset-1',
    kind: 'INSTAGRAM_BUSINESS_ACCOUNT',
    name: 'Synthetic Business',
    credentialRef,
    pageAssetRef: pageRef,
    ...input,
  });
}

class MemoryProvider implements InstagramProvider {
  exchangeCalls = 0;
  discoveryCalls = 0;
  reconcileCalls = 0;
  lastContext?: InstagramOnboardingContext;
  discovery: InstagramDiscoveryResult = Object.freeze({ outcome: 'SUCCEEDED', accounts: Object.freeze([account()]) });
  async exchangeAndStoreAuthorization(input: InstagramOnboardingContext & { readonly code: string }) {
    this.exchangeCalls += 1;
    this.lastContext = input;
    assert.equal(input.code, syntheticCode);
    const grantedScopes = input.authVariant === 'INSTAGRAM_LOGIN' ? ['instagram_business_basic'] : ['instagram_basic'];
    return Object.freeze({ authorizationRef, grantedScopes: Object.freeze(grantedScopes), observedAt: '2026-11-10T12:00:00.000Z' });
  }
  async discoverProfessionalAccounts(input: InstagramOnboardingContext): Promise<InstagramDiscoveryResult> {
    this.discoveryCalls += 1;
    this.lastContext = input;
    return this.discovery;
  }
  async reconcile(input: InstagramOnboardingContext & { readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection' }) {
    this.reconcileCalls += 1;
    this.lastContext = input;
    return Object.freeze({ disposition: 'UNKNOWN' as const });
  }
}

class MemoryAccountStore implements InstagramAccountStore {
  calls = 0;
  result: readonly { readonly providerAccountId: string; readonly assetRef: string }[] = Object.freeze([
    Object.freeze({ providerAccountId: 'synthetic-instagram-asset-1', assetRef: accountRef }),
  ]);
  lastInput?: Parameters<InstagramAccountStore['persistCompleteAccountSet']>[0];
  async persistCompleteAccountSet(input: Parameters<InstagramAccountStore['persistCompleteAccountSet']>[0]) {
    this.calls += 1;
    this.lastInput = input;
    return this.result;
  }
}

class MemorySubscriptions implements InstagramSubscriptionPort {
  calls = 0;
  result: Awaited<ReturnType<InstagramSubscriptionPort['ensureSelectedAccounts']>> = Object.freeze({
    outcome: 'ACTIVE', subscriptionRef, assetRefs: Object.freeze([accountRef]),
  });
  async ensureSelectedAccounts() { this.calls += 1; return this.result; }
}

class MemoryProjection implements InstagramProjectionPort {
  calls = 0;
  async publish() { this.calls += 1; }
}

function adapter(provider = new MemoryProvider(), store = new MemoryAccountStore(),
  subscriptions = new MemorySubscriptions(), projection = new MemoryProjection()) {
  return { adapter: new InstagramOnboardingAdapter(provider, store, subscriptions, projection,
    () => '2026-11-10T12:00:01.000Z'), provider, store, subscriptions, projection };
}

test('each onboarding callback variant maps to its own persisted authorization family', () => {
  assert.equal(isInstagramOnboardingContext(context('INSTAGRAM_VIA_FACEBOOK_LOGIN')), true);
  assert.equal(isInstagramOnboardingContext(context('INSTAGRAM_LOGIN')), true);
  assert.equal(persistedInstagramAuthorizationVariant('INSTAGRAM_VIA_FACEBOOK_LOGIN'), 'FACEBOOK_LOGIN_FOR_BUSINESS');
  assert.equal(persistedInstagramAuthorizationVariant('INSTAGRAM_LOGIN'), 'INSTAGRAM_LOGIN');
  assert.equal(instagramPageLinkRequired('INSTAGRAM_VIA_FACEBOOK_LOGIN'), true);
  assert.equal(instagramPageLinkRequired('INSTAGRAM_LOGIN'), false);

  const invalid = { ...context(), authVariant: 'INSTAGRAM_LOGIN' } as unknown as OnboardingSagaContext;
  assert.equal(isInstagramOnboardingContext(invalid), false);
});

test('adapter rejects a callback/auth mismatch before calling the provider', async () => {
  const state = adapter();
  const mismatch = { ...context(), authVariant: 'INSTAGRAM_LOGIN' } as unknown as OnboardingSagaContext & {
    readonly code: string; readonly idempotencyKey: string; readonly signal: AbortSignal;
  };
  await assert.rejects(state.adapter.exchangeAuthorizationCode({ ...mismatch, code: syntheticCode,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.equal(state.provider.exchangeCalls, 0);
});

test('authorization exchange forwards only the exact Instagram context and returns an opaque ref', async () => {
  const state = adapter();
  const result = await state.adapter.exchangeAuthorizationCode({ ...context('INSTAGRAM_LOGIN'),
    code: syntheticCode, idempotencyKey, signal: new AbortController().signal });
  assert.deepEqual(result, { authorizationRef });
  assert.equal(state.provider.exchangeCalls, 1);
  assert.equal(state.provider.lastContext?.authVariant, 'INSTAGRAM_LOGIN');
  assert.equal(JSON.stringify(result).includes(syntheticCode), false);
});

test('authorization result rejects known scope names from the other variant', async () => {
  const provider = new MemoryProvider();
  provider.exchangeAndStoreAuthorization = async () => Object.freeze({ authorizationRef,
    grantedScopes: Object.freeze(['instagram_business_basic']), observedAt: '2026-11-10T12:00:00.000Z' });
  const state = adapter(provider);
  await assert.rejects(state.adapter.exchangeAuthorizationCode({ ...context(), code: syntheticCode,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);

  const directProvider = new MemoryProvider();
  directProvider.exchangeAndStoreAuthorization = async () => Object.freeze({ authorizationRef,
    grantedScopes: Object.freeze(['pages_show_list', 'instagram_basic']), observedAt: '2026-11-10T12:00:00.000Z' });
  const directState = adapter(directProvider);
  await assert.rejects(directState.adapter.exchangeAuthorizationCode({ ...context('INSTAGRAM_LOGIN'), code: syntheticCode,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
});

test('zero eligible accounts stays empty and does not write a connection asset', async () => {
  const provider = new MemoryProvider();
  provider.discovery = Object.freeze({ outcome: 'SUCCEEDED', accounts: Object.freeze([]) });
  const state = adapter(provider);
  const result = await state.adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey, signal: new AbortController().signal });
  assert.deepEqual(result.assetRefs, []);
  assert.equal(state.store.calls, 0);
});

test('incomplete discovery is retryable and never persists a partial account set', async () => {
  const provider = new MemoryProvider();
  provider.discovery = Object.freeze({ outcome: 'PARTIAL', accounts: Object.freeze([account()]) });
  const state = adapter(provider);
  await assert.rejects(state.adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.equal(state.store.calls, 0);
});

test('Facebook Login requires an internal Page relation and direct Instagram Login rejects one', async () => {
  const missingPage = new MemoryProvider();
  missingPage.discovery = Object.freeze({ outcome: 'SUCCEEDED', accounts: Object.freeze([account({ pageAssetRef: undefined })]) });
  const fbState = adapter(missingPage);
  await assert.rejects(fbState.adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.equal(fbState.store.calls, 0);

  const direct = new MemoryProvider();
  direct.discovery = Object.freeze({ outcome: 'SUCCEEDED', accounts: Object.freeze([account({ pageAssetRef: pageRef })]) });
  const directState = adapter(direct);
  await assert.rejects(directState.adapter.discoverAndPersistAssets({ ...context('INSTAGRAM_LOGIN'), authorizationRef,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.equal(directState.store.calls, 0);
});

test('duplicate provider accounts are rejected before persistence', async () => {
  const provider = new MemoryProvider();
  provider.discovery = Object.freeze({ outcome: 'SUCCEEDED', accounts: Object.freeze([
    account(), account({ credentialRef: secondCredentialRef }),
  ]) });
  const state = adapter(provider);
  await assert.rejects(state.adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.equal(state.store.calls, 0);
});

test('complete Facebook Login result persists atomically and returns internal account refs only', async () => {
  const provider = new MemoryProvider();
  provider.discovery = Object.freeze({ outcome: 'SUCCEEDED', accounts: Object.freeze([
    account(), account({ providerAccountId: 'synthetic-instagram-asset-2', credentialRef: secondCredentialRef,
      pageAssetRef: '31f0af06-e33d-4c48-a0c1-6a0cbad1acc0', kind: 'INSTAGRAM_CREATOR_ACCOUNT' }),
  ]) });
  const store = new MemoryAccountStore();
  store.result = Object.freeze([
    Object.freeze({ providerAccountId: 'synthetic-instagram-asset-1', assetRef: accountRef }),
    Object.freeze({ providerAccountId: 'synthetic-instagram-asset-2', assetRef: secondAccountRef }),
  ]);
  const state = adapter(provider, store);
  const result = await state.adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey, signal: new AbortController().signal });
  assert.deepEqual(result.assetRefs, [accountRef, secondAccountRef]);
  assert.equal(store.calls, 1);
  assert.equal(store.lastInput?.accounts[0]?.pageAssetRef, pageRef);
  assert.equal(JSON.stringify(result).includes('synthetic-instagram-asset'), false);
  assert.equal(JSON.stringify(result).includes(credentialRef), false);
});

test('malformed persistence receipt remains UNKNOWN instead of claiming success', async () => {
  const provider = new MemoryProvider();
  const store = new MemoryAccountStore();
  store.result = Object.freeze([{ providerAccountId: 'different-provider-id', assetRef: accountRef }]);
  const state = adapter(provider, store);
  await assert.rejects(state.adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
});

test('subscription must be observed active for the complete persisted set before projection', async () => {
  const subscriptions = new MemorySubscriptions();
  subscriptions.result = Object.freeze({ outcome: 'PARTIAL', subscriptionRef, assetRefs: Object.freeze([accountRef]) });
  const state = adapter(undefined, undefined, subscriptions);
  await assert.rejects(state.adapter.ensureSubscriptions({ ...context(), authorizationRef,
    assetRefs: [accountRef], idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.equal(state.projection.calls, 0);

  subscriptions.result = Object.freeze({ outcome: 'ACTIVE', subscriptionRef, assetRefs: Object.freeze([accountRef, secondAccountRef]) });
  await assert.rejects(state.adapter.ensureSubscriptions({ ...context(), authorizationRef,
    assetRefs: [accountRef], idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
});

test('exact active subscription permits projection for the same internal assets', async () => {
  const state = adapter();
  await state.adapter.ensureSubscriptions({ ...context('INSTAGRAM_LOGIN'), authorizationRef,
    assetRefs: [accountRef], idempotencyKey, signal: new AbortController().signal });
  await state.adapter.publishProjection({ ...context('INSTAGRAM_LOGIN'), authorizationRef,
    assetRefs: [accountRef], subscriptionRef, idempotencyKey, signal: new AbortController().signal });
  assert.equal(state.projection.calls, 1);
});

test('reconciliation is read-only and never exchanges or rediscovers a code', async () => {
  const state = adapter();
  const result = await state.adapter.reconcileStage({ ...context(), stage: 'authorization', evidence: {},
    idempotencyKey, signal: new AbortController().signal });
  assert.deepEqual(result, { disposition: 'UNKNOWN' });
  assert.equal(state.provider.reconcileCalls, 1);
  assert.equal(state.provider.exchangeCalls, 0);
  assert.equal(state.provider.discoveryCalls, 0);
});

test('unconfigured provider, asset store and subscription port fail closed', async () => {
  const adapter = new InstagramOnboardingAdapter(new InstagramProviderNotConfigured(),
    new InstagramAccountStoreNotConfigured(), new InstagramSubscriptionsNotConfigured(), new MemoryProjection());
  await assert.rejects(adapter.exchangeAuthorizationCode({ ...context(), code: syntheticCode,
    idempotencyKey, signal: new AbortController().signal }), OnboardingSagaEffectError);
  const result = await new InstagramProviderNotConfigured().discoverProfessionalAccounts({ ...context(),
    authorizationRef, idempotencyKey, signal: new AbortController().signal });
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.safeErrorCode, 'INSTAGRAM_PROVIDER_NOT_CONFIGURED');
});
