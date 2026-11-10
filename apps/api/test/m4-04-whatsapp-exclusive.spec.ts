import assert from 'node:assert/strict';
import test from 'node:test';
import { OnboardingSagaEffectError, type OnboardingSagaContext } from '../src/onboarding/onboarding-saga.types.js';
import { WhatsAppExclusiveOnboardingAdapter, type WhatsAppExclusiveOperations } from '../src/whatsapp-exclusive/whatsapp-exclusive-onboarding.adapter.js';

const tenantId = 'a406aaf4-837a-45d7-9f93-4db17920668d';
const onboardingId = '11de9f8d-efdf-46c9-84b1-9d474a5a35dc';
const principalId = '112c8fc8-6284-419a-92f3-0a2584b4ecf0';
const portalSessionId = 'ab4ab85c-40d7-432f-b79c-7c2a5f14e7de';
const authorizationRef = '6a191a66-8cc3-4e65-89eb-5af25cb898a6';
const accountRef = 'f1c90208-010c-48b0-90e3-ef28f825efdd';
const phoneRef = 'c1c90208-010c-48b0-90e3-ef28f825efde';

function context(flowVariant: OnboardingSagaContext['flowVariant'] = 'WHATSAPP_CLOUD_API'): OnboardingSagaContext {
  return Object.freeze({ tenantId, onboardingId, flowVariant,
    authVariant: flowVariant === 'WHATSAPP_CLOUD_API' ? 'WHATSAPP_EMBEDDED_SIGNUP' : 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    configurationRef: 'synthetic-exclusive-config-v1', principalId, portalSessionId,
    correlationId: 'a406aaf4-837a-45d7-9f93-4db17920668e', graphApiVersion: 'v27.0',
    capabilityManifestVersion: 'm4.04-2026-11-10.1' });
}

function operations(overrides: Partial<WhatsAppExclusiveOperations> = {}): WhatsAppExclusiveOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exchangeAuthorizationCode() { calls.push('exchange'); return { authorizationRef }; },
    async discoverAndPersistAssets() {
      calls.push('discover');
      return { assetRefs: [accountRef, phoneRef], phoneAssetRefs: [phoneRef], phoneReadiness: [{
        assetRef: phoneRef, state: 'ACTION_REQUIRED', reasonCode: 'TOKEN_ELIGIBILITY_NOT_CONFIRMED', observedAt: '2026-11-10T12:00:00.000Z',
      }] };
    },
    async ensureSubscriptions() { calls.push('subscriptions'); },
    async publishProjection() { calls.push('projection'); },
    async reconcileStage() { calls.push('reconcile'); return { disposition: 'UNKNOWN' }; },
    ...overrides,
  };
}

test('exclusive adapter binds the exact Cloud API flow and returns only safe per-number readiness', async () => {
  const provider = operations();
  const adapter = new WhatsAppExclusiveOnboardingAdapter(provider);
  const discovery = await adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey: `${onboardingId}:asset-verification`, signal: new AbortController().signal });
  assert.deepEqual(discovery.assetRefs, [accountRef, phoneRef]);
  assert.deepEqual(discovery.phoneReadiness, [{ assetRef: phoneRef, state: 'ACTION_REQUIRED',
    reasonCode: 'TOKEN_ELIGIBILITY_NOT_CONFIRMED', observedAt: '2026-11-10T12:00:00.000Z' }]);
  assert.equal(JSON.stringify(discovery).includes('providerObjectId'), false);
  assert.equal(JSON.stringify(discovery).includes('access_token'), false);
  assert.deepEqual(provider.calls, ['discover']);
});

test('Coexistence context is rejected before any exclusive provider operation', async () => {
  const provider = operations();
  const adapter = new WhatsAppExclusiveOnboardingAdapter(provider);
  await assert.rejects(adapter.exchangeAuthorizationCode({ ...context('WHATSAPP_COEXISTENCE'), code: 'synthetic-code',
    idempotencyKey: `${onboardingId}:authorization`, signal: new AbortController().signal }), OnboardingSagaEffectError);
  assert.deepEqual(provider.calls, []);
});

test('readiness must cover selected internal phone refs exactly and reject unsafe provider claims', async () => {
  const provider = operations({
    async discoverAndPersistAssets() {
      return { assetRefs: [accountRef, phoneRef], phoneAssetRefs: [phoneRef], phoneReadiness: [{
        assetRef: '554433221100', state: 'READY', reasonCode: 'ALREADY_REGISTERED', observedAt: '2026-11-10T12:00:00.000Z',
      }] };
    },
  });
  const adapter = new WhatsAppExclusiveOnboardingAdapter(provider);
  await assert.rejects(adapter.discoverAndPersistAssets({ ...context(), authorizationRef,
    idempotencyKey: `${onboardingId}:asset-verification`, signal: new AbortController().signal }),
  (error: unknown) => error instanceof OnboardingSagaEffectError && error.disposition === 'NO_EFFECT');
});
