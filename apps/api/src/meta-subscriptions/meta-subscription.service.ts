import { isVerifiedServiceTenantScope } from '../identity/identity.service.js';
import type { MetaSubscriptionActor, MetaSubscriptionCatalog, MetaSubscriptionProvider,
  MetaSubscriptionProviderResult, MetaSubscriptionReconcileResult, MetaSubscriptionRequest, MetaSubscriptionStore,
  MetaSubscriptionTargetContext, MetaSubscriptionTargetSnapshot } from './meta-subscriptions.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REQUEST_KEYS = new Set(['tenantId', 'appConfigurationId', 'environment', 'assetId', 'desiredFields', 'correlationId']);
const LEASE_MS = 120_000;
const MAX_BACKOFF_SECONDS = 3_600;

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
    private readonly provider: MetaSubscriptionProvider, private readonly now: () => Date = () => new Date()) {}

  async connect(input: MetaSubscriptionRequest, actor: MetaSubscriptionActor): Promise<MetaSubscriptionReconcileResult> {
    this.validate(input, actor);
    const fields = normalizedFields(input.desiredFields);
    if (!fields) return this.blocked('INVALID_DESIRED_FIELDS');
    let context: MetaSubscriptionTargetContext | undefined;
    try { context = await this.catalog.resolveByAsset(input); } catch { return this.blocked('CATALOG_UNAVAILABLE'); }
    if (!context || context.sourceAssetId !== input.assetId) return this.blocked('ASSET_NOT_ELIGIBLE');
    if (!this.isWhatsAppContext(context)) return this.blocked('SUBSCRIPTION_VARIANT_NOT_CONFIRMED');
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
    if (!this.isWhatsAppContext(context)) return this.blocked('SUBSCRIPTION_VARIANT_NOT_CONFIRMED');
    return await this.reconcileContext(context, actor);
  }

  async disconnect(input: Omit<MetaSubscriptionRequest, 'desiredFields'>, actor: MetaSubscriptionActor): Promise<MetaSubscriptionReconcileResult> {
    this.validate({ ...input, desiredFields: [] }, actor);
    let context: MetaSubscriptionTargetContext | undefined;
    try { context = await this.catalog.resolveByAsset(input); } catch { context = undefined; }
    if (context && context.sourceAssetId === input.assetId) {
      if (!this.isWhatsAppContext(context)) return this.blocked('SUBSCRIPTION_VARIANT_NOT_CONFIRMED');
      try {
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

  private async reconcileContext(context: MetaSubscriptionTargetContext, actor: MetaSubscriptionActor, version = 0): Promise<MetaSubscriptionReconcileResult> {
    let claim: Awaited<ReturnType<MetaSubscriptionStore['claim']>>;
    try { claim = await this.store.claim(context, LEASE_MS); } catch { return this.blocked('SUBSCRIPTION_STATE_UNAVAILABLE', version); }
    if (!claim) return Object.freeze({ state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version,
      reasonCode: 'TARGET_BUSY_OR_BACKOFF' });
    if (claim.target.desiredFields.length > 0) {
      return await this.persistFailure(claim, actor, 'ASSET_SUBSCRIPTION_FIELDS_NOT_CONFIRMED', true);
    }
    let result: MetaSubscriptionProviderResult;
    try { result = await this.provider.ensureWhatsAppSubscribed({ ...context, actor }); }
    catch { return await this.persistFailure(claim, actor, 'PROVIDER_DEPENDENCY_UNAVAILABLE', true); }
    if (result.state === 'SUBSCRIBED') {
      try {
        const saved = await this.store.complete(claim, { state: 'ACTIVE', observedState: 'SUBSCRIBED', observedFields: result.observedFields,
          actorRef: actor.serviceScope.principalId, correlationId: actor.correlationId });
        return Object.freeze({ state: 'ACTIVE', desiredState: saved.desiredState, observedState: saved.observedState, version: saved.version });
      } catch { return this.blocked('SUBSCRIPTION_OUTCOME_PERSISTENCE_FAILED', claim.claimedVersion); }
    }
    return await this.persistFailure(claim, actor, result.reasonCode, result.retryable);
  }

  private async persistFailure(claim: NonNullable<Awaited<ReturnType<MetaSubscriptionStore['claim']>>>, actor: MetaSubscriptionActor,
    reasonCode: string, retryable: boolean, observedState: 'UNKNOWN' | 'SUBSCRIBED' = 'UNKNOWN'): Promise<MetaSubscriptionReconcileResult> {
    const retryAt = retryable ? retryTime(claim.target.attemptCount, this.now()) : undefined;
    const state = retryable ? 'PARTIAL' : 'UNKNOWN';
    try {
      const saved = await this.store.complete(claim, { state, observedState, observedFields: claim.target.observedFields,
        reasonCode, ...(retryAt ? { retryAt } : {}), actorRef: actor.serviceScope.principalId, correlationId: actor.correlationId });
      return Object.freeze({ state, desiredState: saved.desiredState, observedState: saved.observedState, version: saved.version,
        reasonCode, ...(retryAt ? { retryAt } : {}) });
    } catch { return this.blocked('SUBSCRIPTION_OUTCOME_PERSISTENCE_FAILED', claim.claimedVersion); }
  }

  private validate(input: MetaSubscriptionRequest, actor: MetaSubscriptionActor): void {
    if (!input || typeof input !== 'object' || Object.keys(input as unknown as Record<string, unknown>).some((key) => !REQUEST_KEYS.has(key)) ||
        !UUID.test(input.tenantId) || !UUID.test(input.appConfigurationId) || !UUID.test(input.assetId) ||
        !this.isEnvironment(input.environment) || !UUID.test(input.correlationId)) throw new Error('Subscription request is invalid.');
    this.validateActor(input.tenantId, input.correlationId, actor);
  }

  private validateActor(tenantId: string, correlationId: string, actor: MetaSubscriptionActor): void {
    if (!actor || !isVerifiedServiceTenantScope(actor.serviceScope) || actor.serviceScope.tenantId !== tenantId ||
        !actor.serviceScope.scopes.includes('META_CONNECTION_EXECUTE') || actor.correlationId !== correlationId || !UUID.test(actor.correlationId)) {
      throw new Error('Subscription actor is not authorized.');
    }
  }

  private isWhatsAppContext(context: MetaSubscriptionTargetContext): boolean {
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
