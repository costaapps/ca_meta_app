import assert from 'node:assert/strict';
import test from 'node:test';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { ServiceTenantAuthorizationService } from '../src/identity/identity.service.js';
import { ServiceCredentialVerifier } from '../src/identity/identity.trust.js';
import type { ServiceTenantGrant } from '../src/identity/identity.types.js';
import type { VerifiedServiceCredential } from '../src/identity/identity.trust.js';
import type { CredentialResolutionContext, CredentialResolutionHandle } from '../src/credentials/credential-resolver.types.js';
import type { MetaGraphCallResult, MetaGraphCollectionResult, MetaGraphInput } from '../src/meta-graph/meta-graph.types.js';
import type { MetaSubscriptionActor, MetaSubscriptionClaim, MetaSubscriptionCatalog, MetaSubscriptionProvider,
  MetaSubscriptionProviderResult, MetaSubscriptionRequest, MetaSubscriptionSelectedAssetQuery, MetaSubscriptionStore, MetaSubscriptionTargetContext,
  MetaSubscriptionTargetSnapshot } from '../src/meta-subscriptions/meta-subscriptions.types.js';
import { MetaSubscriptionService } from '../src/meta-subscriptions/meta-subscription.service.js';
import { MetaGraphSubscriptionProvider } from '../src/meta-subscriptions/meta-graph-subscription.provider.js';
import type { MetaAppConfigRegistry } from '../src/meta-config/meta-app-config.registry.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const APP = '10000000-0000-4000-8000-000000000002';
const CORRELATION = '10000000-0000-4000-8000-000000000003';
const PRINCIPAL = '10000000-0000-4000-8000-000000000004';
const TARGET = '10000000-0000-4000-8000-000000000010';
const PAGE_ASSET = '10000000-0000-4000-8000-000000000099';
const PROVIDER_OBJECT_ID = '554433221100';
const PROVIDER_APP_ID = '9988776655';
const CONFIG_REF = 'synthetic-whatsapp-config';
const id = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

async function actor(): Promise<MetaSubscriptionActor> {
  class SyntheticCredential extends ServiceCredentialVerifier {
    override async verifyCredential(_credential: string | undefined): Promise<VerifiedServiceCredential> {
      return this.issueVerifiedServiceCredential(PRINCIPAL, TENANT);
    }
  }
  const grant: ServiceTenantGrant = { tenantId: TENANT, principalId: PRINCIPAL, principalKind: 'SERVICE', principalStatus: 'ACTIVE',
    tenantStatus: 'ACTIVE', scopes: ['META_CONNECTION_EXECUTE', 'CREDENTIAL_USE'] };
  const repository = { findServiceTenantGrant: async () => grant } as unknown as IdentityRepository;
  const credential = await new SyntheticCredential().verifyCredential('synthetic-only');
  assert.ok(credential);
  const serviceScope = await new ServiceTenantAuthorizationService(repository).resolveScope(credential);
  return Object.freeze({ serviceScope, correlationId: CORRELATION });
}

function context(assetId: string, authorizationId = id(5)): MetaSubscriptionTargetContext {
  return Object.freeze({ tenantId: TENANT, appConfigurationId: APP, environment: 'test', authorizationId,
    targetAssetId: TARGET, sourceAssetId: assetId, providerObjectId: PROVIDER_OBJECT_ID,
    flowVariant: 'WHATSAPP_COEXISTENCE', authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    kind: 'WHATSAPP_BUSINESS_ACCOUNT', authorizationVersion: 2, targetAssetVersion: 4, sourceAssetVersion: 3 });
}

function facebookPageContext(assetId: string, authorizationId = id(5)): MetaSubscriptionTargetContext {
  return Object.freeze({ tenantId: TENANT, appConfigurationId: APP, environment: 'test', authorizationId,
    targetAssetId: assetId, sourceAssetId: assetId, providerObjectId: PROVIDER_OBJECT_ID,
    flowVariant: 'FACEBOOK', authVariant: 'FACEBOOK_LOGIN_FOR_BUSINESS', kind: 'FACEBOOK_PAGE',
    authorizationVersion: 2, targetAssetVersion: 4, sourceAssetVersion: 4 });
}

function request(assetId: string, desiredFields: readonly string[] = [], authorizationId?: string): MetaSubscriptionRequest {
  return Object.freeze({ tenantId: TENANT, appConfigurationId: APP, environment: 'test', assetId,
    ...(authorizationId ? { authorizationId } : {}), desiredFields, correlationId: CORRELATION });
}

class FakeCatalog implements MetaSubscriptionCatalog {
  calls = 0;
  allowActive = true;
  readonly authorizationByAsset = new Map<string, string>();
  readonly eligibleAuthorizationsByAsset = new Map<string, ReadonlySet<string>>();
  async resolveByAsset(input: Pick<MetaSubscriptionRequest, 'tenantId' | 'appConfigurationId' | 'environment' | 'assetId' | 'authorizationId'>) {
    this.calls += 1;
    const eligible = this.eligibleAuthorizationsByAsset.get(input.assetId);
    const fallback = this.authorizationByAsset.get(input.assetId) ?? id(5);
    if (!this.allowActive || input.tenantId !== TENANT || input.appConfigurationId !== APP) return undefined;
    if (eligible) {
      const authorizationId = input.authorizationId ?? (eligible.size === 1 ? [...eligible][0] : undefined);
      return authorizationId && eligible.has(authorizationId) ? context(input.assetId, authorizationId) : undefined;
    }
    if (input.authorizationId && input.authorizationId !== fallback) return undefined;
    return context(input.assetId, input.authorizationId ?? fallback);
  }
  async resolveTarget() { return undefined; }
}

class FakeStore implements MetaSubscriptionStore {
  readonly bindings = new Map<string, { assetId: string; authorizationId: string; fields: readonly string[]; state: 'ACTIVE' | 'REMOVED'; version: number }>();
  targetVersion = 1;
  desiredState: 'SUBSCRIBED' | 'UNSUBSCRIBED' = 'UNSUBSCRIBED';
  observedState: 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'UNKNOWN' = 'UNKNOWN';
  state: 'PENDING' | 'ACTIVE' | 'PARTIAL' | 'UNKNOWN' | 'MANUAL_ACTION_REQUIRED' = 'PENDING';
  attemptCount = 0;
  lastAttemptAt: string | null = null;
  lastVerifiedAt: string | null = null;
  lastErrorCode: string | null = null;
  nextAttemptAt?: string;
  locked = false;
  lockToken?: string;
  lockContext?: MetaSubscriptionTargetContext;
  claimAttempts = 0;
  inactiveCleanupCalls = 0;
  readonly inactiveAuthorizationIds = new Set<string>();
  private resolveFour!: () => void;
  readonly fourBindings = new Promise<void>((resolve) => { this.resolveFour = resolve; });

  async ensureBinding(input: MetaSubscriptionTargetContext & { readonly desiredFields: readonly string[] }): Promise<MetaSubscriptionTargetSnapshot> {
    const beforeFields = this.currentDesiredFields().join('\0');
    const key = this.bindingKey(input.sourceAssetId, input.authorizationId);
    const existing = this.bindings.get(key);
    this.bindings.set(key, { assetId: input.sourceAssetId, authorizationId: input.authorizationId, fields: input.desiredFields,
      state: 'ACTIVE', version: (existing?.version ?? 0) + 1 });
    const desiredChanged = this.desiredState !== 'SUBSCRIBED' || beforeFields !== this.currentDesiredFields().join('\0');
    this.desiredState = 'SUBSCRIBED';
    if (desiredChanged) this.targetVersion += 1;
    if ([...this.bindings.values()].filter((binding) => binding.state === 'ACTIVE').length === 4) this.resolveFour();
    return this.snapshot(input);
  }
  async removeBinding(input: MetaSubscriptionTargetContext): Promise<MetaSubscriptionTargetSnapshot> {
    const beforeFields = this.currentDesiredFields().join('\0');
    const key = this.bindingKey(input.sourceAssetId, input.authorizationId);
    const existing = this.bindings.get(key);
    if (existing) this.bindings.set(key, { ...existing, state: 'REMOVED', version: existing.version + 1 });
    const active = [...this.bindings.values()].filter((binding) => binding.state === 'ACTIVE');
    const beforeDesired = this.desiredState;
    this.desiredState = active.length ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
    this.state = active.length ? this.observedState === 'SUBSCRIBED' ? 'ACTIVE' : 'PENDING' : 'MANUAL_ACTION_REQUIRED';
    if (beforeDesired !== this.desiredState || beforeFields !== this.currentDesiredFields().join('\0')) this.targetVersion += 1;
    return this.snapshot(input);
  }
  async removeInactiveBindings(input: { readonly assetId: string }) {
    this.inactiveCleanupCalls += 1;
    const stale = [...this.bindings.entries()].filter(([, binding]) => binding.assetId === input.assetId &&
      binding.state === 'ACTIVE' && this.inactiveAuthorizationIds.has(binding.authorizationId));
    if (stale.length === 0) return Object.freeze({ removedBindingCount: 0, targets: Object.freeze([]) });
    for (const [key, binding] of stale) this.bindings.set(key, { ...binding, state: 'REMOVED', version: binding.version + 1 });
    const active = [...this.bindings.values()].filter((binding) => binding.state === 'ACTIVE');
    this.desiredState = active.length > 0 ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
    this.state = active.length > 0 ? this.observedState === 'SUBSCRIBED' ? 'ACTIVE' : 'PENDING' : 'MANUAL_ACTION_REQUIRED';
    this.targetVersion += 1;
    return Object.freeze({ removedBindingCount: stale.length, targets: Object.freeze([Object.freeze({ targetId: `subscription-${TARGET}`,
      desiredState: this.desiredState, observedState: this.observedState, state: this.state,
      version: this.targetVersion, remainingBindingCount: active.length })]) });
  }
  async listSelectedAssets(input: MetaSubscriptionSelectedAssetQuery) {
    return Object.freeze([...this.bindings.values()].filter((binding) => binding.state === 'ACTIVE' &&
      binding.authorizationId === input.authorizationId).map((binding) => Object.freeze({ assetId: binding.assetId,
        targetAssetId: TARGET, authorizationId: binding.authorizationId, desiredFields: binding.fields })));
  }
  async claim(input: MetaSubscriptionTargetContext, _leaseMilliseconds: number): Promise<MetaSubscriptionClaim | undefined> {
    this.claimAttempts += 1;
    if (this.locked || this.desiredState !== 'SUBSCRIBED' || (this.nextAttemptAt && Date.parse(this.nextAttemptAt) > Date.now())) return undefined;
    this.locked = true; this.lockToken = `lease-${this.claimAttempts}`; this.lockContext = input; this.attemptCount += 1; this.targetVersion += 1;
    this.lastAttemptAt = new Date().toISOString();
    const target = this.snapshot(input);
    return Object.freeze({ target, leaseToken: this.lockToken, claimedVersion: this.targetVersion });
  }
  async complete(claim: MetaSubscriptionClaim, input: { readonly state: MetaSubscriptionTargetSnapshot['state'];
    readonly observedState: MetaSubscriptionTargetSnapshot['observedState']; readonly observedFields: readonly string[];
    readonly reasonCode?: string; readonly retryAt?: string }): Promise<MetaSubscriptionTargetSnapshot> {
    assert.equal(claim.leaseToken, this.lockToken);
    assert.equal(claim.claimedVersion, this.targetVersion);
    this.observedState = input.observedState; this.state = input.state; this.nextAttemptAt = input.retryAt;
    if (input.observedState !== 'UNKNOWN') this.lastVerifiedAt = new Date().toISOString();
    this.lastErrorCode = input.state === 'ACTIVE' ? null : input.reasonCode ?? null;
    this.targetVersion += 1;
    if (input.state === 'ACTIVE') this.attemptCount = 0;
    this.locked = false; this.lockToken = undefined;
    return this.snapshot(claim.target);
  }
  async saveAppWebhookDesired(input: { readonly desiredFields: readonly string[] }) {
    return Object.freeze({ desiredFields: input.desiredFields, observedFields: Object.freeze([]), state: 'NOT_CONFIRMED' as const, version: 1 });
  }
  private currentDesiredFields(): string[] {
    return [...new Set([...this.bindings.values()].filter((binding) => binding.state === 'ACTIVE').flatMap((binding) => binding.fields))].sort();
  }
  private bindingKey(assetId: string, authorizationId: string): string { return `${assetId}:${authorizationId}`; }
  private snapshot(input: MetaSubscriptionTargetContext): MetaSubscriptionTargetSnapshot {
    const active = [...this.bindings.entries()].filter(([, value]) => value.state === 'ACTIVE');
    const desiredFields = [...new Set(active.flatMap(([, value]) => value.fields))].sort();
    return Object.freeze({ ...input, targetId: `subscription-${TARGET}`, desiredState: this.desiredState,
      desiredFields: Object.freeze(desiredFields), observedState: this.observedState, observedFields: Object.freeze([]),
      state: this.state, version: this.targetVersion, attemptCount: this.attemptCount,
      lastAttemptAt: this.lastAttemptAt, lastVerifiedAt: this.lastVerifiedAt, lastErrorCode: this.lastErrorCode,
      nextAttemptAt: this.nextAttemptAt ?? null,
      bindings: Object.freeze([...this.bindings.values()].map((value) => Object.freeze({ assetId: value.assetId,
        authorizationId: value.authorizationId, desiredFields: value.fields, state: value.state, version: value.version }))) });
  }
}

class FakeProvider implements MetaSubscriptionProvider {
  remoteSubscribed = false;
  writeCount = 0;
  private releaseWrite!: () => void;
  private startedWrite!: () => void;
  readonly writeStarted = new Promise<void>((resolve) => { this.startedWrite = resolve; });
  readonly release = new Promise<void>((resolve) => { this.releaseWrite = resolve; });
  holdFirstWrite = false;
  calls = 0;
  async ensureWhatsAppSubscribed(): Promise<MetaSubscriptionProviderResult> {
    this.calls += 1;
    if (!this.remoteSubscribed) {
      this.writeCount += 1;
      this.startedWrite();
      if (this.holdFirstWrite) await this.release;
      this.remoteSubscribed = true;
    }
    return { state: 'SUBSCRIBED', observedFields: Object.freeze([]) };
  }
  releaseFirstWrite(): void { this.releaseWrite(); }
}

test('four phone assets sharing one WABA serialize to one idempotent subscribe and disconnect preserves remaining consumers', async () => {
  const store = new FakeStore(); const catalog = new FakeCatalog(); const provider = new FakeProvider();
  provider.holdFirstWrite = true;
  const service = new MetaSubscriptionService(store, catalog, provider);
  const trustedActor = await actor();
  const phones = [id(11), id(12), id(13), id(14)];
  const requests = phones.map((assetId) => service.connect(request(assetId), trustedActor));
  await provider.writeStarted;
  await store.fourBindings;
  provider.releaseFirstWrite();
  const outcomes = await Promise.all(requests);
  assert.equal(store.bindings.size, 4);
  assert.ok([...store.bindings.values()].every((binding) => binding.state === 'ACTIVE'));
  assert.equal(provider.writeCount, 1, 'a single WABA target row serializes concurrent number onboarding');
  assert.equal(provider.remoteSubscribed, true);
  assert.ok(outcomes.some((outcome) => outcome.state === 'ACTIVE'));
  assert.ok(store.lastAttemptAt);
  assert.ok(store.lastVerifiedAt);
  assert.equal(store.lastErrorCode, null);

  await service.reconcile(request(phones[1]!), trustedActor);
  assert.equal(provider.writeCount, 1, 'read-before-write reconciliation does not repeat an already observed subscription');
  const { desiredFields: _desiredFields, ...disconnectRequest } = request(phones[0]!);
  const disconnected = await service.disconnect(disconnectRequest, trustedActor);
  assert.equal(disconnected.state, 'ACTIVE');
  assert.equal(disconnected.reasonCode, 'SHARED_CONSUMER_REMAINS');
  assert.equal([...store.bindings.values()].filter((binding) => binding.state === 'ACTIVE').length, 3);
  assert.equal(provider.remoteSubscribed, true, 'disconnect never removes a WABA subscription while another number remains');
});

test('bindings retain independent authorization grants for the same asset and disconnect only removes the selected grant', async () => {
  const store = new FakeStore(); const catalog = new FakeCatalog(); const provider = new FakeProvider();
  const service = new MetaSubscriptionService(store, catalog, provider);
  const trustedActor = await actor();
  const sharedAsset = id(15);
  const firstGrant = id(25); const secondGrant = id(26);
  catalog.eligibleAuthorizationsByAsset.set(sharedAsset, new Set([firstGrant, secondGrant]));
  catalog.authorizationByAsset.set(sharedAsset, firstGrant);
  const ambiguous = await service.connect(request(sharedAsset), trustedActor);
  assert.equal(ambiguous.reasonCode, 'ASSET_NOT_ELIGIBLE', 'the production-style catalog rejects an unselected ambiguous grant');
  assert.equal(store.bindings.size, 0);
  await service.connect(request(sharedAsset, [], firstGrant), trustedActor);
  catalog.authorizationByAsset.set(sharedAsset, secondGrant);
  await service.connect(request(sharedAsset, [], secondGrant), trustedActor);
  assert.equal(store.bindings.size, 2);
  assert.deepEqual(new Set([...store.bindings.values()].map((binding) => binding.authorizationId)), new Set([firstGrant, secondGrant]));

  catalog.authorizationByAsset.set(sharedAsset, firstGrant);
  const { desiredFields: _desiredFields, ...disconnectRequest } = request(sharedAsset, [], firstGrant);
  const disconnected = await service.disconnect(disconnectRequest, trustedActor);
  assert.equal(disconnected.state, 'ACTIVE');
  assert.equal([...store.bindings.values()].filter((binding) => binding.state === 'ACTIVE').length, 1);
  assert.equal([...store.bindings.values()].find((binding) => binding.authorizationId === secondGrant)?.state, 'ACTIVE');
  assert.equal(provider.remoteSubscribed, true);
});

test('disconnect retires inactive grant binding locally and preserves the still eligible grant without Meta calls', async () => {
  const store = new FakeStore(); const catalog = new FakeCatalog(); const provider = new FakeProvider();
  const service = new MetaSubscriptionService(store, catalog, provider);
  const trustedActor = await actor();
  const sharedAsset = id(16); const inactiveGrant = id(27); const activeGrant = id(28);
  catalog.authorizationByAsset.set(sharedAsset, inactiveGrant);
  await service.connect(request(sharedAsset), trustedActor);
  catalog.authorizationByAsset.set(sharedAsset, activeGrant);
  await service.connect(request(sharedAsset), trustedActor);
  store.observedState = 'SUBSCRIBED';
  store.state = 'ACTIVE';
  store.inactiveAuthorizationIds.add(inactiveGrant);
  catalog.allowActive = false;
  const providerCallsBeforeDisconnect = provider.calls;

  const { desiredFields: _desiredFields, ...disconnectRequest } = request(sharedAsset);
  const disconnected = await service.disconnect(disconnectRequest, trustedActor);
  assert.equal(store.inactiveCleanupCalls, 1);
  assert.equal(store.bindings.get(`${sharedAsset}:${inactiveGrant}`)?.state, 'REMOVED');
  assert.equal(store.bindings.get(`${sharedAsset}:${activeGrant}`)?.state, 'ACTIVE');
  assert.equal(disconnected.state, 'ACTIVE');
  assert.equal(disconnected.reasonCode, 'INACTIVE_GRANT_REMOVED_SHARED_CONSUMER_REMAINS');
  assert.equal(provider.calls, providerCallsBeforeDisconnect, 'grant cleanup is local and does not use an inactive credential');
});

test('disconnect cleans a stale grant alongside the selected active grant and preserves another WABA consumer', async () => {
  const store = new FakeStore(); const catalog = new FakeCatalog(); const provider = new FakeProvider();
  const service = new MetaSubscriptionService(store, catalog, provider);
  const trustedActor = await actor();
  const sharedAsset = id(17); const staleGrant = id(29); const selectedGrant = id(30); const remainingGrant = id(31);

  catalog.authorizationByAsset.set(sharedAsset, staleGrant);
  await service.connect(request(sharedAsset), trustedActor);
  catalog.authorizationByAsset.set(sharedAsset, selectedGrant);
  await service.connect(request(sharedAsset), trustedActor);
  catalog.authorizationByAsset.set(sharedAsset, remainingGrant);
  await service.connect(request(sharedAsset), trustedActor);
  store.observedState = 'SUBSCRIBED';
  store.state = 'ACTIVE';
  store.inactiveAuthorizationIds.add(staleGrant);
  catalog.authorizationByAsset.set(sharedAsset, selectedGrant);
  const providerCallsBeforeDisconnect = provider.calls;

  const { desiredFields: _desiredFields, ...disconnectRequest } = request(sharedAsset);
  const disconnected = await service.disconnect(disconnectRequest, trustedActor);

  assert.equal(store.inactiveCleanupCalls, 1, 'stale grant cleanup runs even when another grant resolves for the asset');
  assert.equal(store.bindings.get(`${sharedAsset}:${staleGrant}`)?.state, 'REMOVED');
  assert.equal(store.bindings.get(`${sharedAsset}:${selectedGrant}`)?.state, 'REMOVED');
  assert.equal(store.bindings.get(`${sharedAsset}:${remainingGrant}`)?.state, 'ACTIVE');
  assert.equal([...store.bindings.values()].filter((binding) => binding.state === 'ACTIVE').length, 1);
  assert.equal(disconnected.state, 'ACTIVE');
  assert.equal(disconnected.reasonCode, 'SHARED_CONSUMER_REMAINS');
  assert.equal(disconnected.desiredState, 'SUBSCRIBED');
  assert.equal(provider.calls, providerCallsBeforeDisconnect, 'both disconnect removals are local and never call Meta');
  assert.equal(provider.remoteSubscribed, true, 'the remaining consumer keeps the shared WABA subscription desired');
});

test('a browser supplied provider object ID is rejected before catalog or provider use', async () => {
  const store = new FakeStore(); const catalog = new FakeCatalog(); const provider = new FakeProvider();
  const service = new MetaSubscriptionService(store, catalog, provider);
  const forged = { ...request(id(11)), providerObjectId: 'attacker-selected-id' } as unknown as MetaSubscriptionRequest;
  await assert.rejects(service.connect(forged, await actor()), /Subscription request is invalid/);
  assert.equal(catalog.calls, 0);
  assert.equal(provider.calls, 0);
});

test('Facebook Page binding is persisted as desired state but subscription stays partial without confirmed Page semantics', async () => {
  const store = new FakeStore();
  const catalog: MetaSubscriptionCatalog = {
    resolveByAsset: async (input) => input.assetId === PAGE_ASSET && input.authorizationId === id(5)
      ? facebookPageContext(PAGE_ASSET, id(5)) : undefined,
    resolveTarget: async () => undefined,
  };
  let whatsappCalls = 0;
  const provider: MetaSubscriptionProvider = { ensureWhatsAppSubscribed: async () => {
    whatsappCalls += 1;
    throw new Error('WhatsApp provider must not be called for a Facebook Page.');
  } };
  const service = new MetaSubscriptionService(store, catalog, provider);
  const result = await service.connect(request(PAGE_ASSET, [], id(5)), await actor());
  assert.equal(result.state, 'PARTIAL');
  assert.equal(result.reasonCode, 'PAGE_SUBSCRIPTION_NOT_CONFIRMED');
  assert.equal(store.desiredState, 'SUBSCRIBED', 'the selected Page remains durably desired in the existing target/binding tables');
  assert.equal(store.bindings.get(`${PAGE_ASSET}:${id(5)}`)?.state, 'ACTIVE');
  assert.equal(whatsappCalls, 0);
});

test('an internal grant selector must be a UUID and cannot replace the verified service scope', async () => {
  const service = new MetaSubscriptionService(new FakeStore(), new FakeCatalog(), new FakeProvider());
  const malformed = { ...request(id(12)), authorizationId: 'browser-chosen-grant' } as unknown as MetaSubscriptionRequest;
  const { desiredFields: _desiredFields, ...disconnectInput } = malformed;
  await assert.rejects(service.disconnect(disconnectInput, await actor()), /Subscription request is invalid/);
});

test('retry backoff blocks immediate reconciliation and a later due attempt remains recoverable', async () => {
  const store = new FakeStore(); const catalog = new FakeCatalog();
  const provider: MetaSubscriptionProvider = { ensureWhatsAppSubscribed: async () => ({ state: 'PARTIAL', reasonCode: 'SYNTHETIC_TRANSIENT', retryable: true }) };
  const service = new MetaSubscriptionService(store, catalog, provider);
  const trustedActor = await actor();
  const first = await service.connect(request(id(21)), trustedActor);
  assert.equal(first.state, 'PARTIAL');
  assert.ok(first.retryAt);
  const second = await service.reconcile(request(id(21)), trustedActor);
  assert.equal(second.reasonCode, 'TARGET_BUSY_OR_BACKOFF');
  assert.equal(store.attemptCount, 1);
  store.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
  const third = await service.reconcile(request(id(21)), trustedActor);
  assert.equal(third.state, 'PARTIAL');
  assert.equal(store.attemptCount, 2);
});

test('app-level webhook desired fields stay separate from asset WABA state', async () => {
  const store = new FakeStore(); const provider = new FakeProvider();
  const service = new MetaSubscriptionService(store, new FakeCatalog(), provider);
  const saved = await service.setAppWebhookDesired({ tenantId: TENANT, appConfigurationId: APP, environment: 'test',
    desiredFields: ['messages', 'message_template_status_update'], correlationId: CORRELATION }, await actor());
  assert.equal(saved.state, 'NOT_CONFIRMED');
  assert.deepEqual(saved.desiredFields, ['message_template_status_update', 'messages']);
  assert.deepEqual(saved.observedFields, []);
  assert.equal(provider.calls, 0, 'app-level Webhooks configuration has no confirmed adapter and is never inferred from WABA state');
});

test('asset-level fields remain fail closed while their contract is not confirmed', async () => {
  const store = new FakeStore(); const provider = new FakeProvider();
  const service = new MetaSubscriptionService(store, new FakeCatalog(), provider);
  const outcome = await service.connect(request(id(22), ['messages']), await actor());
  assert.equal(outcome.state, 'PARTIAL');
  assert.equal(outcome.reasonCode, 'ASSET_SUBSCRIPTION_FIELDS_NOT_CONFIRMED');
  assert.equal(provider.calls, 0);
});

test('Graph adapter derives resourceId from the server target and verifies a successful POST by reading again', async () => {
  const trustedActor = await actor();
  const inputs: MetaGraphInput[] = [];
  let reads = 0;
  const graph = {
    collect: async (input: MetaGraphInput): Promise<MetaGraphCollectionResult> => {
      inputs.push(input); reads += 1;
      return { outcome: 'SUCCEEDED', data: reads === 1 ? [] : [{ id: PROVIDER_APP_ID }], attempts: 1, retries: 0, retryable: false, ambiguous: false };
    },
    execute: async (input: MetaGraphInput): Promise<MetaGraphCallResult> => {
      inputs.push(input); return { outcome: 'SUCCEEDED', data: {}, attempts: 1, retries: 0, retryable: false, ambiguous: false };
    },
  };
  const contexts: CredentialResolutionContext[] = [];
  const credentials = { resolve: async (input: CredentialResolutionContext) => {
    contexts.push(input); return { status: 'READY' as const, capability: 'SUBSCRIBE_WEBHOOKS' as const,
      family: 'SYNTHETIC', purpose: 'CUSTOMER_OPERATION' as const, handle: Object.freeze({}) as CredentialResolutionHandle };
  } };
  const config = { resolve: () => ({ configurationRef: CONFIG_REF, providerAppId: PROVIDER_APP_ID,
    versions: { graphApi: { value: 'v27.0', status: 'VERIFIED' } } }) } as unknown as MetaAppConfigRegistry;
  const adapter = new MetaGraphSubscriptionProvider(config, credentials, graph);
  const outcome = await adapter.ensureWhatsAppSubscribed({ ...context(id(30)), actor: trustedActor });
  assert.equal(outcome.state, 'SUBSCRIBED');
  assert.equal(reads, 2);
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every((input) => input.resourceId === PROVIDER_OBJECT_ID && input.context.providerObjectId === PROVIDER_OBJECT_ID));
  assert.ok(contexts.every((item) => item.assetId === TARGET && item.operation === 'SUBSCRIBE_WEBHOOKS'));
  const postInput = inputs[1];
  assert.equal(postInput?.endpoint, 'SUBSCRIBE_APP');
  if (postInput?.endpoint === 'SUBSCRIBE_APP') assert.deepEqual(postInput.body, {});
});

test('unsupported nested subscribed_apps response shapes fail closed before any write', async () => {
  const trustedActor = await actor();
  let writes = 0;
  const graph = {
    collect: async (): Promise<MetaGraphCollectionResult> => ({ outcome: 'SUCCEEDED',
      data: [{ whatsapp_business_api_data: { id: PROVIDER_APP_ID } }], attempts: 1, retries: 0, retryable: false, ambiguous: false }),
    execute: async (): Promise<MetaGraphCallResult> => {
      writes += 1; return { outcome: 'SUCCEEDED', data: {}, attempts: 1, retries: 0, retryable: false, ambiguous: false };
    },
  };
  const credentials = { resolve: async () => ({ status: 'READY' as const, capability: 'SUBSCRIBE_WEBHOOKS' as const,
    family: 'SYNTHETIC', purpose: 'CUSTOMER_OPERATION' as const, handle: Object.freeze({}) as CredentialResolutionHandle }) };
  const config = { resolve: () => ({ configurationRef: CONFIG_REF, providerAppId: PROVIDER_APP_ID,
    versions: { graphApi: { value: 'v27.0', status: 'VERIFIED' } } }) } as unknown as MetaAppConfigRegistry;
  const adapter = new MetaGraphSubscriptionProvider(config, credentials, graph);
  const outcome = await adapter.ensureWhatsAppSubscribed({ ...context(id(32)), actor: trustedActor });
  assert.equal(outcome.state, 'PARTIAL');
  assert.equal(outcome.reasonCode, 'GRAPH_READ_RESPONSE_INVALID');
  assert.equal(writes, 0, 'an unconfirmed nested shape must not trigger a subscription write');
});

test('synthetic service scope cannot be replaced by a raw UUID', async () => {
  const service = new MetaSubscriptionService(new FakeStore(), new FakeCatalog(), new FakeProvider());
  const invalidActor = { serviceScope: { tenantId: TENANT, principalId: PRINCIPAL, scopes: ['META_CONNECTION_EXECUTE'] }, correlationId: CORRELATION } as unknown as MetaSubscriptionActor;
  await assert.rejects(service.connect(request(id(31)), invalidActor), /Subscription actor is not authorized/);
});
