import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { CredentialResolutionActor, CredentialResolutionHandle } from '../credentials/credential-resolver.types.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaGraphClient } from '../meta-graph/meta-graph.client.js';
import type { MetaGraphCollectionResult, MetaGraphExecutionContext, MetaGraphInput } from '../meta-graph/meta-graph.types.js';
import type { MetaSubscriptionActor, MetaSubscriptionProvider, MetaSubscriptionProviderResult,
  MetaSubscriptionTargetContext } from './meta-subscriptions.types.js';

interface ReadResult { readonly subscribed: boolean; readonly result: MetaGraphCollectionResult }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** WABA-only adapter using M4.02's one-use credential handle and server-owned object ID. */
export class MetaGraphSubscriptionProvider implements MetaSubscriptionProvider {
  constructor(private readonly configs: MetaAppConfigRegistry,
    private readonly credentials: Pick<CredentialResolverService, 'resolve'>,
    private readonly graph: Pick<MetaGraphClient, 'collect' | 'execute'>) {}

  async ensureWhatsAppSubscribed(input: MetaSubscriptionTargetContext & { readonly actor: MetaSubscriptionActor }): Promise<MetaSubscriptionProviderResult> {
    if (input.kind !== 'WHATSAPP_BUSINESS_ACCOUNT' || input.providerObjectId.length === 0 ||
        !((input.flowVariant === 'WHATSAPP_EXCLUSIVE' && input.authVariant === 'WHATSAPP_EMBEDDED_SIGNUP') ||
          (input.flowVariant === 'WHATSAPP_COEXISTENCE' && input.authVariant === 'WHATSAPP_BUSINESS_APP_ONBOARDING'))) {
      return { state: 'PARTIAL', reasonCode: 'SUBSCRIPTION_VARIANT_NOT_CONFIRMED', retryable: false };
    }
    const profile = this.configs.resolve(input.flowVariant, input.authVariant, input.environment);
    if (!profile || profile.versions.graphApi.status !== 'VERIFIED') {
      return { state: 'PARTIAL', reasonCode: 'APP_GRAPH_CONFIGURATION_NOT_CONFIRMED', retryable: false };
    }

    const first = await this.read(input, input.actor);
    if (first.result.outcome !== 'SUCCEEDED') return this.fromReadFailure(first.result);
    if (first.subscribed) return { state: 'SUBSCRIBED', observedFields: Object.freeze([]) };

    const post = await this.write(input, input.actor);
    if (post.outcome === 'FAILED') {
      return { state: 'PARTIAL', reasonCode: `GRAPH_${post.error?.category ?? 'POST_FAILED'}`, retryable: post.retryable };
    }

    // An ambiguous POST is resolved by a fresh read. No write retry occurs in this invocation.
    const verify = await this.read(input, input.actor);
    if (verify.result.outcome !== 'SUCCEEDED') return this.fromReadFailure(verify.result);
    if (verify.subscribed) return { state: 'SUBSCRIBED', observedFields: Object.freeze([]) };
    return { state: post.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'PARTIAL',
      reasonCode: post.outcome === 'UNKNOWN' ? 'AMBIGUOUS_POST_NOT_OBSERVED' : 'POST_NOT_OBSERVED', retryable: true };
  }

  /** No Page Graph request is enabled until M4.01 evidence confirms the exact permission, field set and endpoint behavior. */
  async ensureFacebookPageSubscribed(input: MetaSubscriptionTargetContext & { readonly actor: MetaSubscriptionActor }): Promise<MetaSubscriptionProviderResult> {
    if (input.kind !== 'FACEBOOK_PAGE' || input.flowVariant !== 'FACEBOOK' ||
        input.authVariant !== 'FACEBOOK_LOGIN_FOR_BUSINESS' || input.sourceAssetId !== input.targetAssetId) {
      return { state: 'PARTIAL', reasonCode: 'SUBSCRIPTION_VARIANT_NOT_CONFIRMED', retryable: false };
    }
    return Object.freeze({ state: 'PARTIAL', reasonCode: 'PAGE_SUBSCRIPTION_NOT_CONFIRMED', retryable: false });
  }

  private async read(target: MetaSubscriptionTargetContext, actor: MetaSubscriptionActor): Promise<ReadResult> {
    const input = await this.graphInput(target, actor, 'SUBSCRIBED_APPS_LIST');
    if (!input) return { subscribed: false, result: this.syntheticReadFailure() };
    const result = await this.graph.collect(input);
    if (result.outcome !== 'SUCCEEDED') return { subscribed: false, result };
    const config = this.configs.resolve(target.flowVariant, target.authVariant, target.environment);
    if (!config) return { subscribed: false, result: this.syntheticReadFailure() };
    let subscribed = false;
    for (const item of result.data) {
      // Official examples do not confirm nested item shapes; unknown shapes must fail closed before a write.
      const id = typeof item === 'string' ? item : record(item) && typeof item['id'] === 'string' ? item['id'] : undefined;
      if (!id || !/^\d{1,32}$/.test(id)) return { subscribed: false, result: this.syntheticReadFailure() };
      if (id === config.providerAppId) subscribed = true;
    }
    return { subscribed, result };
  }

  private async write(target: MetaSubscriptionTargetContext, actor: MetaSubscriptionActor) {
    const input = await this.graphInput(target, actor, 'SUBSCRIBE_APP');
    if (!input) return { outcome: 'FAILED' as const, retryable: false, error: { category: 'CREDENTIAL_UNAVAILABLE' as const } };
    return await this.graph.execute(input);
  }

  private async graphInput(target: MetaSubscriptionTargetContext, actor: MetaSubscriptionActor,
    endpoint: 'SUBSCRIBED_APPS_LIST' | 'SUBSCRIBE_APP'): Promise<MetaGraphInput | undefined> {
    try {
      const operation = 'SUBSCRIBE_WEBHOOKS' as const;
      const contextForResolver = { tenantId: target.tenantId, provider: 'META' as const,
        appConfigurationId: target.appConfigurationId, environment: target.environment,
        assetId: target.targetAssetId, operation };
      const result = await this.credentials.resolve(contextForResolver, {
        serviceScope: actor.serviceScope, correlationId: actor.correlationId,
      } satisfies CredentialResolutionActor);
      const context: MetaGraphExecutionContext = Object.freeze({ ...contextForResolver,
        flowVariant: target.flowVariant, authVariant: target.authVariant,
        configurationRef: this.configs.resolve(target.flowVariant, target.authVariant, target.environment)!.configurationRef,
        providerObjectId: target.providerObjectId });
      const base = { context, credentialHandle: result.handle as CredentialResolutionHandle,
        credentialCapability: operation, operation, correlationId: actor.correlationId,
        resourceId: target.providerObjectId };
      return endpoint === 'SUBSCRIBED_APPS_LIST'
        ? Object.freeze({ ...base, endpoint })
        : Object.freeze({ ...base, endpoint, body: Object.freeze({}) });
    } catch { return undefined; }
  }

  private fromReadFailure(result: MetaGraphCollectionResult): MetaSubscriptionProviderResult {
    return { state: result.outcome === 'FAILED' ? 'PARTIAL' : 'UNKNOWN',
      reasonCode: `GRAPH_READ_${result.error?.category ?? result.outcome}`, retryable: result.retryable };
  }

  private syntheticReadFailure(): MetaGraphCollectionResult {
    return Object.freeze({ outcome: 'FAILED', data: Object.freeze([]), error: Object.freeze({ category: 'RESPONSE_INVALID', retryable: false, ambiguous: false }),
      attempts: 0, retries: 0, retryable: false, ambiguous: false });
  }
}

/** Placeholder for deployments that have not registered a confirmed WABA subscription adapter. */
export class FailClosedMetaSubscriptionProvider implements MetaSubscriptionProvider {
  async ensureWhatsAppSubscribed(): Promise<MetaSubscriptionProviderResult> {
    return Object.freeze({ state: 'PARTIAL', reasonCode: 'PROVIDER_ADAPTER_NOT_CONFIRMED', retryable: false });
  }
  async ensureFacebookPageSubscribed(): Promise<MetaSubscriptionProviderResult> {
    return Object.freeze({ state: 'PARTIAL', reasonCode: 'PAGE_SUBSCRIPTION_NOT_CONFIRMED', retryable: false });
  }
}
