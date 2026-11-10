import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClaimedJob } from '../src/jobs/job-store.js';
import { OnboardingCodeProtector } from '../src/onboarding/onboarding-code-crypto.js';
import { callbackVariantMatchesProfile } from '../src/onboarding/onboarding-code-submission.service.js';
import type { OnboardingCodeConsumer } from '../src/onboarding/onboarding-code-submission.store.js';
import { createOnboardingSagaHandler, type OnboardingSagaCheckpointInput, type OnboardingSagaCheckpointPort,
  type OnboardingSagaSnapshot, type SagaCheckpoint, type SagaRow } from '../src/onboarding/onboarding-saga.worker.js';
import { OnboardingSagaEffectError, type OnboardingSagaAdapter } from '../src/onboarding/onboarding-saga.types.js';
import type { OnboardingStep } from '../src/onboarding/onboarding-session.types.js';
import type { DurableWorkDatabase } from '../src/jobs/durable-work-database.js';
import { assertSafeOnboardingSagaEvidence, onboardingSagaStageReceipt } from '../src/onboarding/onboarding-saga-evidence.js';

const signingKey = Buffer.alloc(32, 0x4c).toString('base64url');
const code = 'synthetic-authorization-code-never-persist';
const tenantId = 'a406aaf4-837a-45d7-9f93-4db17920668d';
const onboardingId = '11de9f8d-efdf-46c9-84b1-9d474a5a35dc';
const assetRef = 'f1c90208-010c-48b0-90e3-ef28f825efdd';
const authorizationRef = '6a191a66-8cc3-4e65-89eb-5af25cb898a6';
const evidenceContext = { tenantId, onboardingId, configurationRef: 'synthetic-config-v1',
  providerAppId: 'synthetic-meta-app', providerEnvironment: 'test',
  flowVariant: 'WHATSAPP_CLOUD_API' as const, authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' };

test('callback route slugs match one exact flow and auth variant', () => {
  const profiles = [
    ['facebook-login', 'FACEBOOK_LOGIN', 'FACEBOOK_LOGIN_FOR_BUSINESS'],
    ['instagram-via-facebook-login', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'],
    ['instagram-login', 'INSTAGRAM_LOGIN', 'INSTAGRAM_LOGIN'],
    ['whatsapp-cloud-api', 'WHATSAPP_CLOUD_API', 'WHATSAPP_EMBEDDED_SIGNUP'],
    ['whatsapp-coexistence', 'WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING'],
  ] as const;
  for (const [route, flow, auth] of profiles) assert.equal(callbackVariantMatchesProfile(route, flow, auth), true);
  assert.equal(callbackVariantMatchesProfile('instagram-login', 'INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN'), false);
  assert.equal(callbackVariantMatchesProfile('instagram-via-facebook-login', 'INSTAGRAM_LOGIN', 'INSTAGRAM_LOGIN'), false);
  assert.equal(callbackVariantMatchesProfile('whatsapp-cloud-api', 'WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING'), false);
  assert.equal(callbackVariantMatchesProfile('whatsapp-coexistence', 'WHATSAPP_CLOUD_API', 'WHATSAPP_EMBEDDED_SIGNUP'), false);
});

test('one-use code is encrypted with onboarding-bound AAD and wrong config cannot open it', () => {
  const protector = new OnboardingCodeProtector(signingKey);
  const context = { tenantId, onboardingId, flowVariant: 'WHATSAPP_CLOUD_API' as const,
    authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', configurationRef: 'synthetic-config-v1' };
  const sealed = protector.seal(context, code);
  assert.notEqual(sealed.ciphertext.toString('utf8'), code);
  assert.doesNotMatch(JSON.stringify(sealed), /synthetic-authorization-code-never-persist/);
  assert.equal(protector.open(context, sealed), code);
  assert.throws(() => protector.open({ ...context, configurationRef: 'other-config-v1' }, sealed));
});

class MemorySagaCheckpointPort implements OnboardingSagaCheckpointPort {
  private steps: OnboardingStep[];
  private evidence: SagaCheckpoint;
  private status: string;
  allowed = true;
  readonly checkpoints: OnboardingSagaCheckpointInput[] = [];

  constructor(input: { readonly steps?: OnboardingStep[]; readonly evidence?: SagaCheckpoint; readonly status?: string } = {}) {
    this.steps = input.steps ?? [
      { name: 'authorization', status: 'PENDING' }, { name: 'asset-verification', status: 'PENDING' },
      { name: 'subscription', status: 'PENDING' }, { name: 'projection', status: 'PENDING' },
    ];
    this.evidence = input.evidence ?? {};
    this.status = input.status ?? 'CODE_RECEIVED';
  }

  async read(): Promise<OnboardingSagaSnapshot> {
    const row: SagaRow = {
      id: onboardingId, tenant_id: tenantId, principal_id: '112c8fc8-6284-419a-92f3-0a2584b4ecf0',
      portal_session_id: 'ab4ab85c-40d7-432f-b79c-7c2a5f14e7de', flow_variant: 'WHATSAPP_CLOUD_API',
      auth_variant: 'WHATSAPP_EMBEDDED_SIGNUP', configuration_ref: 'synthetic-config-v1',
      provider_app_id: 'synthetic-meta-app', provider_environment: 'test',
      capability_manifest_version: 'meta-capability-manifest-v1', graph_api_version: 'v27.0',
      expires_at: new Date(Date.now() + 60_000), status: this.status, steps_json: this.steps,
      saga_checkpoint_json: JSON.stringify(this.evidence),
    };
    return { row, steps: [...this.steps], evidence: { ...this.evidence } };
  }

  async checkpoint(input: OnboardingSagaCheckpointInput): Promise<void> {
    assertSafeOnboardingSagaEvidence({ ...this.evidence, ...input.evidence }, evidenceContext);
    this.checkpoints.push(input);
    this.status = input.status;
    this.steps = this.steps.map((step) => step.name === input.stage ? { name: step.name, status: input.stepStatus } : step);
    this.evidence = { ...this.evidence, ...input.evidence };
  }

  async startExchange(): Promise<boolean> {
    const auth = this.steps.find((step) => step.name === 'authorization');
    if (!['PENDING', 'RETRY_PENDING'].includes(auth?.status ?? '')) return false;
    this.status = 'EXCHANGING';
    this.steps = this.steps.map((step) => step.name === 'authorization' ? { name: step.name, status: 'RUNNING' } : step);
    return true;
  }

  async canContinue(): Promise<boolean> { return this.allowed; }
}

test('worker checkpoints reject credential-shaped values and accept context-bound internal references', async () => {
  const checkpoints = new MemorySagaCheckpointPort();
  await assert.rejects(checkpoints.checkpoint({ tenantId, onboardingId, status: 'PARTIAL', readiness: 'PARTIAL',
    nextAction: 'REAUTHORIZE', stage: 'authorization', stepStatus: 'FAILED', evidence: { authorizationRef: 'EAAGsynthetic-provider-token' } }));
  await checkpoints.checkpoint({ tenantId, onboardingId, status: 'EXCHANGING', readiness: 'UNKNOWN',
    nextAction: 'WAIT', stage: 'authorization', stepStatus: 'SUCCEEDED', evidence: { authorizationRef } });
  const subscriptionRef = onboardingSagaStageReceipt('subscription', evidenceContext, authorizationRef, [assetRef]);
  assert.match(subscriptionRef, /^internal:subscription:[a-f0-9]{64}$/);
  assertSafeOnboardingSagaEvidence({ authorizationRef, verifiedAssetRefs: [assetRef], subscriptionRef }, evidenceContext);
  const otherTenantReceipt = onboardingSagaStageReceipt('subscription',
    { ...evidenceContext, tenantId: 'c406aaf4-837a-45d7-9f93-4db17920668d' }, authorizationRef, [assetRef]);
  assert.throws(() => assertSafeOnboardingSagaEvidence({ authorizationRef, verifiedAssetRefs: [assetRef],
    subscriptionRef: otherTenantReceipt }, evidenceContext));
  assert.throws(() => assertSafeOnboardingSagaEvidence({ authorizationRef, subscriptionRef }, evidenceContext),
    /Unsafe subscription evidence reference/);
});

test('WhatsApp phone readiness accepts only safe states tied to internal verified phone refs', () => {
  const readiness = [{ assetRef, state: 'ACTION_REQUIRED' as const, reasonCode: 'TOKEN_ELIGIBILITY_NOT_CONFIRMED' as const,
    observedAt: '2026-11-10T12:00:00.000Z' }];
  assert.doesNotThrow(() => assertSafeOnboardingSagaEvidence({ authorizationRef, verifiedAssetRefs: [assetRef], phoneReadiness: readiness }, evidenceContext));
  assert.throws(() => assertSafeOnboardingSagaEvidence({ authorizationRef, verifiedAssetRefs: [assetRef],
    phoneReadiness: [{ ...readiness[0]!, assetRef: '554433221100' }] }, evidenceContext), /Unsafe WhatsApp phone readiness/);
  assert.throws(() => assertSafeOnboardingSagaEvidence({ authorizationRef, verifiedAssetRefs: [assetRef],
    phoneReadiness: [{ ...readiness[0]!, state: 'READY', reasonCode: 'PIN_NOT_AVAILABLE' }] }, evidenceContext), /Unsafe WhatsApp phone readiness/);
  assert.throws(() => assertSafeOnboardingSagaEvidence({ authorizationRef, verifiedAssetRefs: [assetRef], phoneReadiness: readiness },
    { ...evidenceContext, flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING' }), /Unsafe WhatsApp phone readiness/);
});

function makeJob(): ClaimedJob {
  return {
    id: 'ba4b2240-a9df-47f4-b7a8-94e2f4c88930', tenantId, resourceScopeRef: onboardingId,
    type: 'ONBOARDING_STEP', lane: 'ONBOARDING', effectMode: 'AMBIGUOUS',
    payload: { kind: 'ONBOARDING_STEP', onboardingRef: onboardingId, stepRef: 'authorization',
      codeRef: 'd81a4a69-2a56-49a4-911e-5148ad916a80' },
    idempotencyKey: 'synthetic-onboarding-code', correlationId: 'request-m4-03', causationId: onboardingId,
    attempt: 1, maxAttempts: 2, claimToken: 'synthetic-claim-token', workerRef: 'test-worker',
    budgetStartedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  };
}

test('a proven no-effect subscription failure retries only that pending stage; code exchange runs once', async () => {
  const checkpoints = new MemorySagaCheckpointPort();
  const codeConsumer: OnboardingCodeConsumer & { calls: number } = {
    calls: 0,
    async consumeOnce() {
      this.calls += 1;
      return { context: { tenantId, onboardingId, flowVariant: 'WHATSAPP_CLOUD_API',
        authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', configurationRef: 'synthetic-config-v1',
        principalId: '112c8fc8-6284-419a-92f3-0a2584b4ecf0', portalSessionId: 'ab4ab85c-40d7-432f-b79c-7c2a5f14e7de',
        capabilityManifestVersion: 'meta-capability-manifest-v1', graphApiVersion: 'v27.0' }, code };
    },
  };
  let exchangeCalls = 0;
  let assetCalls = 0;
  let subscriptionCalls = 0;
  let projectionCalls = 0;
  const adapter: OnboardingSagaAdapter = {
    async exchangeAuthorizationCode() { exchangeCalls += 1; return { authorizationRef }; },
    async discoverAndPersistAssets() { assetCalls += 1; return { assetRefs: [assetRef] }; },
    async ensureSubscriptions() {
      subscriptionCalls += 1;
      if (subscriptionCalls === 1) throw new OnboardingSagaEffectError('NO_EFFECT');
      return;
    },
    async publishProjection() { projectionCalls += 1; },
  };
  const handler = createOnboardingSagaHandler({} as DurableWorkDatabase, codeConsumer, adapter, checkpoints);
  const job = makeJob();
  const first = await handler(job, new AbortController().signal, {} as never);
  assert.deepEqual(first, { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(checkpoints.checkpoints.at(-1)?.stepStatus, 'RETRY_PENDING');

  const second = await handler({ ...job, attempt: 2 }, new AbortController().signal, {} as never);
  assert.deepEqual(second, { kind: 'SUCCEEDED' });
  assert.equal(exchangeCalls, 1);
  assert.equal(codeConsumer.calls, 1);
  assert.equal(assetCalls, 1);
  assert.equal(subscriptionCalls, 2);
  assert.equal(projectionCalls, 1);
  assert.equal((await checkpoints.read()).row.status, 'READY');
});

test('revoked portal session or membership blocks provider effects after enqueue', async () => {
  const checkpoints = new MemorySagaCheckpointPort();
  checkpoints.allowed = false;
  let codeReads = 0;
  let providerEffects = 0;
  const codeConsumer: OnboardingCodeConsumer = { async consumeOnce() { codeReads += 1; return undefined; } };
  const adapter = {
    async exchangeAuthorizationCode() { providerEffects += 1; return { authorizationRef }; },
    async discoverAndPersistAssets() { providerEffects += 1; return { assetRefs: [assetRef] }; },
    async ensureSubscriptions() { providerEffects += 1; },
    async publishProjection() { providerEffects += 1; },
  } as OnboardingSagaAdapter;
  const handler = createOnboardingSagaHandler({} as DurableWorkDatabase, codeConsumer, adapter, checkpoints);
  const outcome = await handler(makeJob(), new AbortController().signal, {} as never);
  assert.deepEqual(outcome, { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' });
  assert.equal(codeReads, 0);
  assert.equal(providerEffects, 0);
});

test('empty asset discovery ends PARTIAL and never attempts subscriptions or READY', async () => {
  const checkpoints = new MemorySagaCheckpointPort();
  const codeConsumer: OnboardingCodeConsumer = {
    async consumeOnce() {
      return { context: { tenantId, onboardingId, flowVariant: 'WHATSAPP_CLOUD_API',
        authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', configurationRef: 'synthetic-config-v1',
        principalId: '112c8fc8-6284-419a-92f3-0a2584b4ecf0', portalSessionId: 'ab4ab85c-40d7-432f-b79c-7c2a5f14e7de',
        capabilityManifestVersion: 'meta-capability-manifest-v1', graphApiVersion: 'v27.0' }, code };
    },
  };
  let subscriptions = 0;
  const adapter: OnboardingSagaAdapter = {
    async exchangeAuthorizationCode() { return { authorizationRef }; },
    async discoverAndPersistAssets() { return { assetRefs: [] }; },
    async ensureSubscriptions() { subscriptions += 1; },
    async publishProjection() {},
  };
  const handler = createOnboardingSagaHandler({} as DurableWorkDatabase, codeConsumer, adapter, checkpoints);
  const outcome = await handler(makeJob(), new AbortController().signal, {} as never);
  assert.deepEqual(outcome, { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' });
  const final = await checkpoints.read();
  assert.equal(final?.row.status, 'PARTIAL');
  assert.equal(final?.steps.find((step) => step.name === 'asset-verification')?.status, 'FAILED');
  assert.equal(subscriptions, 0);
});

test('exclusive WhatsApp with a number requiring action checkpoints per-number readiness and pauses before subscription', async () => {
  const checkpoints = new MemorySagaCheckpointPort();
  const codeConsumer: OnboardingCodeConsumer = {
    async consumeOnce() {
      return { context: { tenantId, onboardingId, flowVariant: 'WHATSAPP_CLOUD_API',
        authVariant: 'WHATSAPP_EMBEDDED_SIGNUP', configurationRef: 'synthetic-config-v1',
        principalId: '112c8fc8-6284-419a-92f3-0a2584b4ecf0', portalSessionId: 'ab4ab85c-40d7-432f-b79c-7c2a5f14e7de',
        capabilityManifestVersion: 'meta-capability-manifest-v1', graphApiVersion: 'v27.0' }, code };
    },
  };
  let subscriptionCalls = 0;
  const adapter: OnboardingSagaAdapter = {
    async exchangeAuthorizationCode() { return { authorizationRef }; },
    async discoverAndPersistAssets() { return { assetRefs: [assetRef], phoneReadiness: [{ assetRef, state: 'ACTION_REQUIRED',
      reasonCode: 'TOKEN_ELIGIBILITY_NOT_CONFIRMED', observedAt: '2026-11-10T12:00:00.000Z' }] }; },
    async ensureSubscriptions() { subscriptionCalls += 1; },
    async publishProjection() {},
  };
  const handler = createOnboardingSagaHandler({} as DurableWorkDatabase, codeConsumer, adapter, checkpoints);
  const result = await handler(makeJob(), new AbortController().signal);
  const snapshot = await checkpoints.read(tenantId, onboardingId);
  assert.equal(result.kind, 'SUCCEEDED');
  assert.equal(snapshot?.row.status, 'PARTIAL');
  assert.equal(snapshot?.row.steps_json.find((step) => step.name === 'asset-verification')?.status, 'RETRY_PENDING');
  assert.deepEqual(snapshot?.evidence.phoneReadiness?.[0], { assetRef, state: 'ACTION_REQUIRED',
    reasonCode: 'TOKEN_ELIGIBILITY_NOT_CONFIRMED', observedAt: '2026-11-10T12:00:00.000Z' });
  assert.equal(subscriptionCalls, 0);
});

test('reconcile no-effect exposes RESUME and an explicit resume never repeats authorization exchange', async () => {
  const checkpoints = new MemorySagaCheckpointPort({
    status: 'PROVISIONING',
    steps: [
      { name: 'authorization', status: 'SUCCEEDED' }, { name: 'asset-verification', status: 'SUCCEEDED' },
      { name: 'subscription', status: 'UNKNOWN' }, { name: 'projection', status: 'PENDING' },
    ],
    evidence: { authorizationRef, verifiedAssetRefs: [assetRef] },
  });
  let exchangeCalls = 0;
  let subscriptionCalls = 0;
  let projectionCalls = 0;
  const adapter: OnboardingSagaAdapter = {
    async exchangeAuthorizationCode() { exchangeCalls += 1; return { authorizationRef }; },
    async discoverAndPersistAssets() { throw new Error('existing assets must not be rediscovered'); },
    async ensureSubscriptions() { subscriptionCalls += 1; },
    async publishProjection() { projectionCalls += 1; },
    async reconcileStage(input) {
      assert.equal(input.stage, 'subscription');
      assert.equal(input.evidence.authorizationRef, authorizationRef);
      return { disposition: 'NO_EFFECT' };
    },
  };
  const neverConsumeCode: OnboardingCodeConsumer = { async consumeOnce() { throw new Error('no authorization code may be replayed'); } };
  const handler = createOnboardingSagaHandler({} as DurableWorkDatabase, neverConsumeCode, adapter, checkpoints);
  const reconciliation = await handler({ ...makeJob(), payload: { kind: 'ONBOARDING_STEP', onboardingRef: onboardingId,
    stepRef: 'subscription', operation: 'RECONCILE' } }, new AbortController().signal, {} as never);
  assert.deepEqual(reconciliation, { kind: 'SUCCEEDED' });
  assert.equal(checkpoints.checkpoints.at(-1)?.stepStatus, 'RETRY_PENDING');
  assert.equal(checkpoints.checkpoints.at(-1)?.nextAction, 'RESUME');
  assert.equal(exchangeCalls, 0);
  assert.equal(subscriptionCalls, 0);

  const resumed = await handler({ ...makeJob(), payload: { kind: 'ONBOARDING_STEP', onboardingRef: onboardingId,
    stepRef: 'subscription' } }, new AbortController().signal, {} as never);
  assert.deepEqual(resumed, { kind: 'SUCCEEDED' });
  assert.equal(exchangeCalls, 0);
  assert.equal(subscriptionCalls, 1);
  assert.equal(projectionCalls, 1);
  assert.equal((await checkpoints.read()).row.status, 'READY');
});
