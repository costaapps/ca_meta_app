import { isAuthorizedTenantScope, isVerifiedServiceTenantScope, TenantAuthorizationService } from '../identity/identity.service.js';
import type { AuthorizedTenantScope } from '../identity/identity.types.js';
import type { MetaSubscriptionActor, MetaSubscriptionCatalog, MetaSubscriptionProvider,
  MetaSubscriptionProviderResult, MetaSubscriptionReconcileResult, MetaSubscriptionRequest, MetaSubscriptionStore,
  MetaFacebookPageSelectionActor, MetaSubscriptionSelectedAsset,
  MetaSubscriptionSelectedAssetQuery, MetaSubscriptionTargetContext,
  MetaSubscriptionTargetSnapshot } from './meta-subscriptions.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REQUEST_KEYS = new Set(['tenantId', 'appConfigurationId', 'environment', 'assetId', 'authorizationId', 'desiredFields', 'correlationId']);
const LEASE_MS = 120_000;
const MAX_BACKOFF_SECONDS = 3_600;

export class MetaFacebookPageSelectionInvalidError extends Error {
  constructor() { super('Facebook Page selection is invalid or unavailable.'); this.name = 'MetaFacebookPageSelectionInvalidError'; }
}

export class MetaFacebookPageSelectionDependencyError extends Error {
  constructor() { super('Facebook Page selection dependencies are unavailable.'); this.name = 'MetaFacebookPageSelectionDependencyError'; }
}

function normalizedFields(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64 || value.some((field) => typeof field !== 'string' || !FIELD.test(field))) return undefined;
  return Object.freeze([...new Set(value as string[])].sort());
}
function retryTime(attempt: number, now: Date): string {
  const seconds = Math.min(MAX_BACKOFF_SECONDS, 5 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

/** Service orchestration accepts only internal asset refs and verified service tenant scopes. */
export class MetaSubscriptionService {
  constructor(private readonly store: MetaSubscriptionStore, private readonly catalog: MetaSubscriptionCatalog,
    private readonly provider: MetaSubscriptionProvider, private readonly now: () => Date = () => new Date(),
    private readonly portalAuthorization?: TenantAuthorizationService) {}

  async connect(input: MetaSubscriptionRequest, actor: MetaSubscriptionActor): Promise<MetaSubscriptionReconcileResult> {
    this.validate(input, actor);
    const fields = normalizedFields(input.desiredFields);
    if (!fields) return this.blocked('INVALID_DESIRED_FIELDS');
    let context: MetaSubscriptionTargetContext | undefined;
    try { context = await this.catalog.resolveByAsset(input); } catch { return this.blocked('CATALOG_UNAVAILABLE'); }
    if (!context || context.sourceAssetId !== input.assetId) return this.blocked('ASSET_NOT_ELIGIBLE');
    if (!this.isSupportedContext(context)) return this.blocked('SUBSCRIPTION_VARIANT_NOT_CONFIRMED');
    let snapshot: MetaSubscriptionTargetSnapshot;
    try {
      snapshot = await this.store.ensureBinding({ ...context, desiredFields: fields,
        actorRef: actor.serviceScope.principalId, correlationId: input.correlationId });
    } catch { return this.blocked('SUBSCRIPTION_STATE_UNAVAILABLE'); }
    return await this.reconcileContext(context, actor, snapshot.version);
  }

  async reconcile(input: MetaSubscriptionRequest, actor: MetaSubscriptionActor): Promise<MetaSubscriptionReconcileResult> {
    this.validate(input, actor);
    let context: MetaSubscriptionTargetContext | undefined;
    try { context = await this.catalog.resolveByAsset(input); } catch { return this.blocked('CATALOG_UNAVAILABLE'); }
    if (!context || context.sourceAssetId !== input.assetId) return this.blocked('ASSET_NOT_ELIGIBLE');
    if (!this.isSupportedContext(context)) return this.blocked('SUBSCRIPTION_VARIANT_NOT_CONFIRMED');
    return await this.reconcileContext(context, actor);
  }

  async disconnect(input: Omit<MetaSubscriptionRequest, 'desiredFields'>, actor: MetaSubscriptionActor): Promise<MetaSubscriptionReconcileResult> {
    this.validate({ ...input, desiredFields: [] }, actor);
    let context: MetaSubscriptionTargetContext | undefined;
    try { context = await this.catalog.resolveByAsset(input); } catch { context = undefined; }
    if (context && context.sourceAssetId === input.assetId) {
      if (!this.isSupportedContext(context)) return this.blocked('SUBSCRIPTION_VARIANT_NOT_CONFIRMED');
      try {
        // A currently usable grant can coexist with stale bindings from older grants on the
        // same internal asset. Retire those locally before removing only the caller-selected
        // grant, so the shared target refcount reflects both operations. This cleanup is
        // server-side and never calls Meta.
        await this.store.removeInactiveBindings({ ...input, actorRef: actor.serviceScope.principalId });
        const snapshot = await this.store.removeBinding({ ...context, actorRef: actor.serviceScope.principalId, correlationId: input.correlationId });
        if (snapshot.desiredState === 'UNSUBSCRIBED') return Object.freeze({ state: 'MANUAL_ACTION_REQUIRED', desiredState: snapshot.desiredState,
          observedState: snapshot.observedState, version: snapshot.version, reasonCode: 'REMOTE_UNSUBSCRIBE_NOT_CONFIRMED' });
        return Object.freeze({ state: snapshot.observedState === 'SUBSCRIBED' ? 'ACTIVE' : 'PENDING', desiredState: snapshot.desiredState,
          observedState: snapshot.observedState, version: snapshot.version, reasonCode: 'SHARED_CONSUMER_REMAINS' });
      } catch { return this.blocked('SUBSCRIPTION_STATE_UNAVAILABLE'); }
    }

    // Revoked/inactive grants can no longer resolve to an executable catalog context. Retire only
    // bindings whose current grant and credential metadata prove that Graph use is unavailable.
    // This cleanup is local and deliberately never invokes the Meta provider.
    try {
      const cleanup = await this.store.removeInactiveBindings({ ...input, actorRef: actor.serviceScope.principalId });
      if (cleanup.removedBindingCount === 0 || cleanup.targets.length === 0) return this.blocked('ASSET_NOT_ELIGIBLE');
      const hasConsumers = cleanup.targets.some((target) => target.remainingBindingCount > 0);
      const hasUnownedTarget = cleanup.targets.some((target) => target.remainingBindingCount === 0);
      const hasUnownedObservedSubscription = cleanup.targets.some((target) => target.remainingBindingCount === 0 && target.observedState === 'SUBSCRIBED');
      const desiredState = hasConsumers ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
      const observedState = cleanup.targets.some((target) => target.observedState === 'SUBSCRIBED') ? 'SUBSCRIBED' : 'UNKNOWN';
      const state = hasUnownedTarget
        ? hasConsumers ? 'PARTIAL' : 'MANUAL_ACTION_REQUIRED'
        : hasConsumers ? observedState === 'SUBSCRIBED' ? 'ACTIVE' : 'PENDING' : 'MANUAL_ACTION_REQUIRED';
      return Object.freeze({ state, desiredState, observedState, version: Math.max(...cleanup.targets.map((target) => target.version)),
        reasonCode: hasUnownedTarget ? hasUnownedObservedSubscription ? 'INACTIVE_GRANT_REMOVED_REMOTE_SUBSCRIPTION_REQUIRES_REVIEW' :
          'INACTIVE_GRANT_REMOVED_UNOWNED_TARGET_REQUIRES_REVIEW' :
          hasConsumers ? 'INACTIVE_GRANT_REMOVED_SHARED_CONSUMER_REMAINS' : 'INACTIVE_GRANT_REMOVED_REMOTE_UNSUBSCRIBE_NOT_CONFIRMED' });
    } catch { return this.blocked('SUBSCRIPTION_STATE_UNAVAILABLE'); }
  }

  /** App-level Webhooks subscriptions are stored independently; no app-level mutation is enabled without confirmed semantics. */
  async setAppWebhookDesired(input: { readonly tenantId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionRequest['environment']; readonly desiredFields: readonly string[]; readonly correlationId: string },
    actor: MetaSubscriptionActor): Promise<{ readonly state: 'NOT_CONFIRMED'; readonly desiredFields: readonly string[]; readonly observedFields: readonly string[]; readonly version: number }> {
    this.validateActor(input.tenantId, input.correlationId, actor);
    const fields = normalizedFields(input.desiredFields);
    if (!UUID.test(input.appConfigurationId) || !this.isEnvironment(input.environment) || !fields) throw new Error('App webhook desired state is invalid.');
    return await this.store.saveAppWebhookDesired({ ...input, desiredFields: fields,
      actorRef: actor.serviceScope.principalId });
  }

  /** Returns persisted desired bindings, never browser claims or provider IDs. */
  async listSelectedAssets(input: MetaSubscriptionSelectedAssetQuery, actor: MetaSubscriptionActor): Promise<readonly MetaSubscriptionSelectedAsset[]> {
    const allowedKeys = new Set(['tenantId', 'appConfigurationId', 'environment', 'authorizationId', 'assetKind', 'correlationId']);
    if (!input || Object.keys(input as unknown as Record<string, unknown>).some((key) => !allowedKeys.has(key)) ||
        !UUID.test(input.tenantId) || !UUID.test(input.appConfigurationId) || !UUID.test(input.authorizationId) ||
        !this.isEnvironment(input.environment) || !UUID.test(input.correlationId) || input.assetKind !== 'FACEBOOK_PAGE') {
      throw new Error('Subscription selection query is invalid.');
    }
    this.validateActor(input.tenantId, input.correlationId, actor);
    try {
      const records = await this.store.listSelectedAssets({ tenantId: input.tenantId,
        appConfigurationId: input.appConfigurationId, environment: input.environment,
        authorizationId: input.authorizationId, assetKind: input.assetKind, correlationId: input.correlationId });
      if (!Array.isArray(records) || records.some((record) => !UUID.test(record.assetId) ||
          !UUID.test(record.targetAssetId) || record.targetAssetId !== record.assetId || record.authorizationId !== input.authorizationId ||
          !Array.isArray(record.desiredFields) || !normalizedFields(record.desiredFields))) {
        throw new Error('Subscription selection result is invalid.');
      }
      return Object.freeze(records.map((record) => Object.freeze({ ...record,
        desiredFields: Object.freeze([...record.desiredFields]) })));
    } catch { throw new Error('Subscription selection is unavailable.'); }
  }

  /** Portal status reads require a current, branded tenant scope and RESOURCE_READ authorization. */
  async readFacebookPageSelection(input: { readonly authorizationId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionRequest['environment']; readonly correlationId: string },
    actor: MetaFacebookPageSelectionActor): Promise<readonly MetaSubscriptionSelectedAsset[]> {
    const tenantScope = actor?.tenantScope;
    await this.validatePortalPageSelectionContext(input, tenantScope, 'RESOURCE_READ');
    try {
      const selected = await this.store.listSelectedAssets({ tenantId: tenantScope.tenantId,
        appConfigurationId: input.appConfigurationId, environment: input.environment,
        authorizationId: input.authorizationId, assetKind: 'FACEBOOK_PAGE', correlationId: input.correlationId });
      if (!Array.isArray(selected) || selected.some((asset) => !UUID.test(asset.assetId) ||
          asset.targetAssetId !== asset.assetId || asset.authorizationId !== input.authorizationId ||
          !Array.isArray(asset.desiredFields) || !normalizedFields(asset.desiredFields))) {
        throw new Error('Invalid Page selection state.');
      }
      return Object.freeze(selected.map((asset) => Object.freeze({ ...asset,
        desiredFields: Object.freeze([...asset.desiredFields]) })));
    } catch { throw new MetaFacebookPageSelectionDependencyError(); }
  }

  /**
   * Browser selection is authorized as a user operation, then persisted through the same
   * tenant-scoped M4.11 catalog/store. It never impersonates a service principal.
   */
  async replaceFacebookPageSelection(input: { readonly authorizationId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionRequest['environment']; readonly selectedAssetRefs: readonly string[];
    readonly correlationId: string }, actor: MetaFacebookPageSelectionActor): Promise<{
      readonly selectedAssetRefs: readonly string[];
      readonly outcomes: readonly { readonly assetRef: string; readonly state: MetaSubscriptionReconcileResult['state']; readonly reasonCode?: string }[];
      readonly readiness: 'PARTIAL' | 'ACTION_REQUIRED';
    }> {
    const tenantScope = actor?.tenantScope;
    await this.validatePortalPageSelectionContext(input, tenantScope, 'CONNECT');
    if (!Array.isArray(input.selectedAssetRefs) || input.selectedAssetRefs.length > 500 ||
        input.selectedAssetRefs.some((assetRef) => !UUID.test(assetRef)) ||
        new Set(input.selectedAssetRefs).size !== input.selectedAssetRefs.length) {
      throw new MetaFacebookPageSelectionInvalidError();
    }
    const query = { tenantId: tenantScope.tenantId, appConfigurationId: input.appConfigurationId,
      environment: input.environment, authorizationId: input.authorizationId,
      assetKind: 'FACEBOOK_PAGE' as const, correlationId: input.correlationId };
    let existing: readonly MetaSubscriptionSelectedAsset[];
    try { existing = await this.store.listSelectedAssets(query); }
    catch { throw new MetaFacebookPageSelectionDependencyError(); }
    const selectedPages: MetaSubscriptionTargetContext[] = [];
    for (const assetRef of input.selectedAssetRefs) {
      let page: MetaSubscriptionTargetContext | undefined;
      try { page = await this.catalog.resolveByAsset({ tenantId: tenantScope.tenantId, appConfigurationId: input.appConfigurationId,
        environment: input.environment, assetId: assetRef, authorizationId: input.authorizationId }); }
      catch { throw new MetaFacebookPageSelectionDependencyError(); }
      if (!page || page.kind !== 'FACEBOOK_PAGE' || page.flowVariant !== 'FACEBOOK' ||
          page.authVariant !== 'FACEBOOK_LOGIN_FOR_BUSINESS' || page.authorizationId !== input.authorizationId ||
          page.sourceAssetId !== assetRef || page.targetAssetId !== assetRef) {
        throw new MetaFacebookPageSelectionInvalidError();
      }
      selectedPages.push(page);
    }
    const desired = new Set(input.selectedAssetRefs);
    const outcomes: Array<{ assetRef: string; state: MetaSubscriptionReconcileResult['state']; reasonCode?: string }> = [];
    for (const page of selectedPages) {
      const assetRef = page.sourceAssetId;
      try {
        const saved = await this.store.ensureBinding({ ...page, desiredFields: Object.freeze([]),
          actorRef: tenantScope.principalId, correlationId: input.correlationId });
        const result = await this.reconcileFacebookPageContext(page, tenantScope.principalId, input.correlationId, saved.version);
        outcomes.push(Object.freeze({ assetRef, state: result.state, ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}) }));
      } catch { throw new MetaFacebookPageSelectionDependencyError(); }
    }
    let persisted: readonly MetaSubscriptionSelectedAsset[];
    try { persisted = await this.store.listSelectedAssets(query); }
    catch { throw new MetaFacebookPageSelectionDependencyError(); }
    if (input.selectedAssetRefs.some((assetRef) => !persisted.some((asset) => asset.assetId === assetRef))) {
      return Object.freeze({ readiness: input.selectedAssetRefs.length ? 'PARTIAL' : 'ACTION_REQUIRED',
        selectedAssetRefs: Object.freeze(persisted.map((asset) => asset.assetId)), outcomes: Object.freeze(outcomes) });
    }
    for (const asset of existing) {
      if (desired.has(asset.assetId)) continue;
      let page: MetaSubscriptionTargetContext | undefined;
      try { page = await this.catalog.resolveByAsset({ tenantId: tenantScope.tenantId, appConfigurationId: input.appConfigurationId,
        environment: input.environment,
        assetId: asset.assetId, authorizationId: input.authorizationId }); } catch { page = undefined; }
      if (!page || page.kind !== 'FACEBOOK_PAGE' || page.flowVariant !== 'FACEBOOK' ||
          page.authVariant !== 'FACEBOOK_LOGIN_FOR_BUSINESS' || page.authorizationId !== input.authorizationId ||
          page.sourceAssetId !== asset.assetId || page.targetAssetId !== asset.assetId) {
        outcomes.push(Object.freeze({ assetRef: asset.assetId, state: 'PARTIAL', reasonCode: 'PAGE_BINDING_NOT_CURRENT' }));
        continue;
      }
      try {
        const removed = await this.store.removeBinding({ ...page, actorRef: tenantScope.principalId, correlationId: input.correlationId });
        outcomes.push(Object.freeze({ assetRef: asset.assetId, state: removed.state,
          ...(removed.lastErrorCode ? { reasonCode: removed.lastErrorCode } : {}) }));
      } catch { outcomes.push(Object.freeze({ assetRef: asset.assetId, state: 'PARTIAL', reasonCode: 'PAGE_BINDING_REMOVE_UNAVAILABLE' })); }
    }
    return Object.freeze({ readiness: input.selectedAssetRefs.length ? 'PARTIAL' : 'ACTION_REQUIRED',
      selectedAssetRefs: Object.freeze([...input.selectedAssetRefs]), outcomes: Object.freeze(outcomes) });
  }

  private async validatePortalPageSelectionContext(input: { readonly authorizationId: string; readonly appConfigurationId: string;
    readonly environment: MetaSubscriptionRequest['environment']; readonly correlationId: string },
    tenantScope: AuthorizedTenantScope | undefined, operation: 'RESOURCE_READ' | 'CONNECT'): Promise<void> {
    if (!isAuthorizedTenantScope(tenantScope) || !input || !UUID.test(input.authorizationId) ||
        !UUID.test(input.appConfigurationId) || !UUID.test(input.correlationId) || !this.isEnvironment(input.environment)) {
      throw new MetaFacebookPageSelectionInvalidError();
    }
    if (!this.portalAuthorization) throw new MetaFacebookPageSelectionDependencyError();
    await this.portalAuthorization.authorize(tenantScope, operation, tenantScope.tenantId);
  }

  private async reconcileFacebookPageContext(context: MetaSubscriptionTargetContext, actorRef: string, correlationId: string,
    version = 0, actor?: MetaSubscriptionActor): Promise<MetaSubscriptionReconcileResult> {
    let claim: Awaited<ReturnType<MetaSubscriptionStore['claim']>>;
    try { claim = await this.store.claim(context, LEASE_MS); } catch { return this.blocked('SUBSCRIPTION_STATE_UNAVAILABLE', version); }
    if (!claim) return Object.freeze({ state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version,
      reasonCode: 'TARGET_BUSY_OR_BACKOFF' });
    if (claim.target.desiredFields.length > 0) {
      return await this.persistFailure(claim, actorRef, correlationId, 'ASSET_SUBSCRIPTION_FIELDS_NOT_CONFIRMED', true);
    }
    let result: MetaSubscriptionProviderResult;
    try { result = actor && this.provider.ensureFacebookPageSubscribed
      ? await this.provider.ensureFacebookPageSubscribed({ ...context, actor })
      : { state: 'PARTIAL', reasonCode: 'PAGE_SUBSCRIPTION_NOT_CONFIRMED', retryable: false }; }
    catch { return await this.persistFailure(claim, actorRef, correlationId, 'PROVIDER_DEPENDENCY_UNAVAILABLE', true); }
    if (result.state === 'SUBSCRIBED') {
      try {
        const saved = await this.store.complete(claim, { state: 'ACTIVE', observedState: 'SUBSCRIBED',
          observedFields: result.observedFields, actorRef, correlationId });
        return Object.freeze({ state: 'ACTIVE', desiredState: saved.desiredState, observedState: saved.observedState, version: saved.version });
      } catch { return this.blocked('SUBSCRIPTION_OUTCOME_PERSISTENCE_FAILED', claim.claimedVersion); }
    }
    return await this.persistFailure(claim, actorRef, correlationId, result.reasonCode, result.retryable, 'UNKNOWN',
      result.reasonCode === 'PAGE_SUBSCRIPTION_NOT_CONFIRMED' ? 'PARTIAL' : undefined);
  }

  private async reconcileContext(context: MetaSubscriptionTargetContext, actor: MetaSubscriptionActor, version = 0): Promise<MetaSubscriptionReconcileResult> {
    if (context.kind === 'FACEBOOK_PAGE') {
      return await this.reconcileFacebookPageContext(context, actor.serviceScope.principalId, actor.correlationId, version, actor);
    }
    let claim: Awaited<ReturnType<MetaSubscriptionStore['claim']>>;
    try { claim = await this.store.claim(context, LEASE_MS); } catch { return this.blocked('SUBSCRIPTION_STATE_UNAVAILABLE', version); }
    if (!claim) return Object.freeze({ state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version,
      reasonCode: 'TARGET_BUSY_OR_BACKOFF' });
    if (claim.target.desiredFields.length > 0) {
      return await this.persistFailure(claim, actor.serviceScope.principalId, actor.correlationId,
        'ASSET_SUBSCRIPTION_FIELDS_NOT_CONFIRMED', true);
    }
    let result: MetaSubscriptionProviderResult;
    try {
      result = await this.provider.ensureWhatsAppSubscribed({ ...context, actor });
    }
    catch { return await this.persistFailure(claim, actor.serviceScope.principalId, actor.correlationId,
      'PROVIDER_DEPENDENCY_UNAVAILABLE', true); }
    if (result.state === 'SUBSCRIBED') {
      try {
        const saved = await this.store.complete(claim, { state: 'ACTIVE', observedState: 'SUBSCRIBED', observedFields: result.observedFields,
          actorRef: actor.serviceScope.principalId, correlationId: actor.correlationId });
        return Object.freeze({ state: 'ACTIVE', desiredState: saved.desiredState, observedState: saved.observedState, version: saved.version });
      } catch { return this.blocked('SUBSCRIPTION_OUTCOME_PERSISTENCE_FAILED', claim.claimedVersion); }
    }
    return await this.persistFailure(claim, actor.serviceScope.principalId, actor.correlationId,
      result.reasonCode, result.retryable, 'UNKNOWN');
  }

  private async persistFailure(claim: NonNullable<Awaited<ReturnType<MetaSubscriptionStore['claim']>>>, actorRef: string,
    correlationId: string, reasonCode: string, retryable: boolean, observedState: 'UNKNOWN' | 'SUBSCRIBED' = 'UNKNOWN',
    stateOverride?: 'PARTIAL' | 'UNKNOWN'): Promise<MetaSubscriptionReconcileResult> {
    const retryAt = retryable ? retryTime(claim.target.attemptCount, this.now()) : undefined;
    const state = stateOverride ?? (retryable ? 'PARTIAL' : 'UNKNOWN');
    try {
      const saved = await this.store.complete(claim, { state, observedState, observedFields: claim.target.observedFields,
        reasonCode, ...(retryAt ? { retryAt } : {}), actorRef, correlationId });
      return Object.freeze({ state, desiredState: saved.desiredState, observedState: saved.observedState, version: saved.version,
        reasonCode, ...(retryAt ? { retryAt } : {}) });
    } catch { return this.blocked('SUBSCRIPTION_OUTCOME_PERSISTENCE_FAILED', claim.claimedVersion); }
  }

  private validate(input: MetaSubscriptionRequest, actor: MetaSubscriptionActor): void {
    if (!input || typeof input !== 'object' || Object.keys(input as unknown as Record<string, unknown>).some((key) => !REQUEST_KEYS.has(key)) ||
        !UUID.test(input.tenantId) || !UUID.test(input.appConfigurationId) || !UUID.test(input.assetId) ||
        (input.authorizationId !== undefined && (typeof input.authorizationId !== 'string' || !UUID.test(input.authorizationId))) ||
        !this.isEnvironment(input.environment) || !UUID.test(input.correlationId)) throw new Error('Subscription request is invalid.');
    this.validateActor(input.tenantId, input.correlationId, actor);
  }

  private validateActor(tenantId: string, correlationId: string, actor: MetaSubscriptionActor): void {
    if (!actor || !isVerifiedServiceTenantScope(actor.serviceScope) || actor.serviceScope.tenantId !== tenantId ||
        !actor.serviceScope.scopes.includes('META_CONNECTION_EXECUTE') || actor.correlationId !== correlationId || !UUID.test(actor.correlationId)) {
      throw new Error('Subscription actor is not authorized.');
    }
  }

  private isSupportedContext(context: MetaSubscriptionTargetContext): boolean {
    if (context.kind === 'FACEBOOK_PAGE') {
      return context.flowVariant === 'FACEBOOK' && context.authVariant === 'FACEBOOK_LOGIN_FOR_BUSINESS' &&
        context.sourceAssetId === context.targetAssetId;
    }
    return context.kind === 'WHATSAPP_BUSINESS_ACCOUNT' &&
      ((context.flowVariant === 'WHATSAPP_EXCLUSIVE' && context.authVariant === 'WHATSAPP_EMBEDDED_SIGNUP') ||
       (context.flowVariant === 'WHATSAPP_COEXISTENCE' && context.authVariant === 'WHATSAPP_BUSINESS_APP_ONBOARDING'));
  }

  private isEnvironment(value: string): value is MetaSubscriptionRequest['environment'] {
    return value === 'development' || value === 'test' || value === 'staging' || value === 'production';
  }

  private blocked(reasonCode: string, version = 0): MetaSubscriptionReconcileResult {
    return Object.freeze({ state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version, reasonCode });
  }
}
