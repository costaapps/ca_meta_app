import { OnboardingSagaEffectError, type OnboardingSagaAdapter, type OnboardingSagaContext,
  type OnboardingSagaEvidence, type OnboardingSagaReconciliation } from '../onboarding/onboarding-saga.types.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { MetaSubscriptionActor, MetaSubscriptionRequest, MetaSubscriptionSelectedAsset } from '../meta-subscriptions/meta-subscriptions.types.js';
import type { MetaSubscriptionService } from '../meta-subscriptions/meta-subscription.service.js';
import { FACEBOOK_LOGIN_FOR_BUSINESS, isFacebookPagesContext, isIsoUtc, isUuid,
  type FacebookManagedPage, type FacebookPageAssetStore, type FacebookPageProjectionPort, type FacebookPagesContext,
  type FacebookPagesProvider } from './facebook-pages.types.js';

const MAX_DISCOVERED_PAGES = 500;
const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export class FacebookPagesOnboardingAdapter implements OnboardingSagaAdapter {
  constructor(
    private readonly provider: FacebookPagesProvider,
    private readonly assets: FacebookPageAssetStore,
    private readonly subscriptions: Pick<MetaSubscriptionService, 'reconcile' | 'listSelectedAssets'>,
    private readonly subscriptionActorForTenant: (tenantId: string, correlationId: string) => Promise<MetaSubscriptionActor | undefined>,
    private readonly projection: FacebookPageProjectionPort,
    private readonly environmentForConfiguration: (configurationRef: string) => MetaEnvironment | undefined,
  ) {}

  async exchangeAuthorizationCode(input: OnboardingSagaContext & {
    readonly code: string; readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<{ readonly authorizationRef: string }> {
    const context = facebookContext(input);
    try {
      const result = await this.provider.exchangeAndStoreAuthorization({ ...context, code: input.code,
        idempotencyKey: input.idempotencyKey, signal: input.signal });
      if (!isUuid(result.authorizationRef) || !isIsoUtc(result.observedAt) || !safeNames(result.grantedScopes, SCOPE_NAME)) {
        throw new OnboardingSagaEffectError('UNKNOWN');
      }
      return Object.freeze({ authorizationRef: result.authorizationRef });
    } catch (error) {
      if (error instanceof OnboardingSagaEffectError) throw error;
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
  }

  async discoverAndPersistAssets(input: OnboardingSagaContext & {
    readonly authorizationRef: string; readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<{ readonly assetRefs: readonly string[] }> {
    const context = facebookContext(input);
    if (!isUuid(input.authorizationRef)) throw new OnboardingSagaEffectError('UNKNOWN');
    const pages = await collectCompletePageSet(this.provider, context, input.authorizationRef, input.idempotencyKey, input.signal);
    // Empty is intentionally returned as empty. M4.03 records PARTIAL and never emits auth_success/READY.
    if (pages.length === 0) return Object.freeze({ assetRefs: Object.freeze([]) });
    if (input.signal.aborted) throw new OnboardingSagaEffectError('NO_EFFECT');
    try {
      const persisted = await this.assets.persistCompletePageSet({ ...context, authorizationRef: input.authorizationRef,
        pages, idempotencyKey: input.idempotencyKey, observedAt: new Date().toISOString() });
      const persistedIds = persisted.map((asset) => asset.providerPageId);
      const expectedIds = pages.map((page) => page.id);
      if (persisted.length !== pages.length || new Set(persistedIds).size !== persistedIds.length ||
          expectedIds.some((id) => !persistedIds.includes(id)) || persisted.some((asset) => !isUuid(asset.assetRef))) {
        throw new OnboardingSagaEffectError('UNKNOWN');
      }
      return Object.freeze({ assetRefs: Object.freeze(persisted.map((asset) => asset.assetRef)) });
    } catch (error) {
      if (error instanceof OnboardingSagaEffectError) throw error;
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
  }

  async ensureSubscriptions(input: OnboardingSagaContext & {
    readonly authorizationRef: string; readonly assetRefs: readonly string[];
    readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<void> {
    const context = facebookContext(input);
    if (!isUuid(input.authorizationRef) || input.assetRefs.length === 0 || input.assetRefs.some((ref) => !isUuid(ref))) {
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
    const selectionContext = selectionContextFor(context, input.authorizationRef, this.environmentForConfiguration);
    const actor = await this.subscriptionActorForTenant(context.tenantId, context.correlationId);
    if (!actor) throw new OnboardingSagaEffectError('NO_EFFECT');
    let selected: readonly MetaSubscriptionSelectedAsset[];
    try { selected = await this.subscriptions.listSelectedAssets({ ...subscriptionRequest(selectionContext), assetKind: 'FACEBOOK_PAGE' }, actor); }
    catch { throw new OnboardingSagaEffectError('UNKNOWN'); }
    if (selected.length === 0 || selected.some((page) => !input.assetRefs.includes(page.assetId))) {
      // Selection is an explicit recovery step; discovering or finding Pages never opts a Page in implicitly.
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    for (const page of selected) {
      const request = { ...subscriptionRequest(selectionContext), assetId: page.assetId, authorizationId: input.authorizationRef,
        desiredFields: Object.freeze([]) } satisfies MetaSubscriptionRequest;
      const result = await this.subscriptions.reconcile(request, actor);
      if (result.state !== 'ACTIVE') throw new OnboardingSagaEffectError(result.state === 'UNKNOWN' ? 'UNKNOWN' : 'NO_EFFECT');
    }
  }

  async publishProjection(input: OnboardingSagaContext & {
    readonly authorizationRef: string; readonly assetRefs: readonly string[]; readonly subscriptionRef: string;
    readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<void> {
    const context = facebookContext(input);
    if (!isUuid(input.authorizationRef) || !isUuid(input.subscriptionRef) || input.assetRefs.length === 0 ||
        input.assetRefs.some((ref) => !isUuid(ref))) throw new OnboardingSagaEffectError('UNKNOWN');
    const selectionContext = selectionContextFor(context, input.authorizationRef, this.environmentForConfiguration);
    const actor = await this.subscriptionActorForTenant(context.tenantId, context.correlationId);
    if (!actor) throw new OnboardingSagaEffectError('NO_EFFECT');
    let selected: readonly MetaSubscriptionSelectedAsset[];
    try { selected = await this.subscriptions.listSelectedAssets({ ...subscriptionRequest(selectionContext), assetKind: 'FACEBOOK_PAGE' }, actor); }
    catch { throw new OnboardingSagaEffectError('UNKNOWN'); }
    if (selected.length === 0 || selected.some((page) => !input.assetRefs.includes(page.assetId))) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    try {
      await this.projection.publish({ ...selectionContext, selectedAssetRefs: Object.freeze(selected.map((page) => page.assetId)),
        idempotencyKey: input.idempotencyKey, signal: input.signal });
    } catch (error) {
      if (error instanceof OnboardingSagaEffectError) throw error;
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
  }

  async reconcileStage(input: OnboardingSagaContext & {
    readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
    readonly evidence: OnboardingSagaEvidence;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<OnboardingSagaReconciliation> {
    const context = facebookContext(input);
    if (!this.provider.reconcile) return Object.freeze({ disposition: 'UNKNOWN' });
    try {
      return await this.provider.reconcile({ ...context, stage: input.stage, evidence: input.evidence, signal: input.signal });
    } catch {
      return Object.freeze({ disposition: 'UNKNOWN' });
    }
  }
}

export async function collectCompletePageSet(
  provider: Pick<FacebookPagesProvider, 'listManagedPages'>,
  context: FacebookPagesContext,
  authorizationRef: string,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<readonly FacebookManagedPage[]> {
  if (signal.aborted || !isUuid(authorizationRef) || typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new OnboardingSagaEffectError('NO_EFFECT');
  let response: Awaited<ReturnType<FacebookPagesProvider['listManagedPages']>>;
  try { response = await provider.listManagedPages({ ...context, authorizationRef, idempotencyKey, signal }); }
  catch { throw new OnboardingSagaEffectError('NO_EFFECT'); }
  if (!response || typeof response !== 'object' || response.outcome !== 'SUCCEEDED' || !Array.isArray(response.pages) ||
      response.pages.length > MAX_DISCOVERED_PAGES) throw new OnboardingSagaEffectError('NO_EFFECT');
  const pageIds = new Set<string>();
  const credentialRefs = new Set<string>();
  const output: FacebookManagedPage[] = [];
  for (const page of response.pages) {
    if (!validPage(page) || pageIds.has(page.id) || credentialRefs.has(page.credentialRef)) throw new OnboardingSagaEffectError('NO_EFFECT');
    pageIds.add(page.id);
    credentialRefs.add(page.credentialRef);
    output.push(Object.freeze({ id: page.id, name: page.name, credentialRef: page.credentialRef,
      tasks: Object.freeze([...page.tasks]) }));
  }
  if (signal.aborted) throw new OnboardingSagaEffectError('NO_EFFECT');
  return Object.freeze(output);
}

function facebookContext(input: OnboardingSagaContext): FacebookPagesContext {
  if (!isFacebookPagesContext(input) || input.authVariant !== FACEBOOK_LOGIN_FOR_BUSINESS) {
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
  return input;
}

function selectionContextFor(context: FacebookPagesContext, authorizationRef: string,
  environmentForConfiguration: (configurationRef: string) => MetaEnvironment | undefined) {
  const environment = environmentForConfiguration(context.configurationRef);
  if (!environment) throw new OnboardingSagaEffectError('UNKNOWN');
  return Object.freeze({ tenantId: context.tenantId, authorizationRef,
    appConfigurationRef: context.configurationRef, environment,
    correlationId: context.correlationId });
}

function subscriptionRequest(context: ReturnType<typeof selectionContextFor>): Omit<MetaSubscriptionRequest, 'assetId' | 'desiredFields'> {
  return Object.freeze({ tenantId: context.tenantId, appConfigurationId: context.appConfigurationRef,
    environment: context.environment, authorizationId: context.authorizationRef, correlationId: context.correlationId });
}

function validPage(page: FacebookManagedPage): boolean {
  return !!page && typeof page.id === 'string' && PAGE_ID.test(page.id) &&
    (page.name === null || (typeof page.name === 'string' && page.name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(page.name))) &&
    isUuid(page.credentialRef) && safeNames(page.tasks, TASK_NAME, 64);
}

function safeNames(values: readonly string[], pattern: RegExp, maxItems = 256): boolean {
  return Array.isArray(values) && values.length <= maxItems && values.every((value) =>
    typeof value === 'string' && value.length <= 128 && pattern.test(value)) && new Set(values).size === values.length;
}
