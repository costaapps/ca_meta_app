import type { MetaSubscriptionActor } from '../meta-subscriptions/meta-subscriptions.types.js';
import type { MetaSubscriptionService } from '../meta-subscriptions/meta-subscription.service.js';
import { isFacebookPageSelectionContext, isUuid, type FacebookPageSelectionContext } from './facebook-pages.types.js';

export interface FacebookPageSelectionResult {
  readonly readiness: 'READY' | 'PARTIAL';
  readonly selectedAssetRefs: readonly string[];
  readonly outcomes: readonly { readonly assetRef: string; readonly state: string; readonly reasonCode?: string }[];
}

/** Persists the user's Page selection through M4.11 bindings and reconciles only those Page assets. */
export class FacebookPageSelectionService {
  constructor(private readonly subscriptions: Pick<MetaSubscriptionService,
    'connect' | 'disconnect' | 'listSelectedAssets'>) {}

  async replaceSelection(input: FacebookPageSelectionContext & { readonly selectedAssetRefs: readonly string[] },
    actor: MetaSubscriptionActor): Promise<FacebookPageSelectionResult> {
    if (!input || typeof input !== 'object') throw new Error('Facebook Page selection is invalid.');
    const allowedKeys = new Set(['tenantId', 'authorizationRef', 'appConfigurationRef', 'environment', 'correlationId', 'selectedAssetRefs']);
    const context: FacebookPageSelectionContext = Object.freeze({ tenantId: input.tenantId,
      authorizationRef: input.authorizationRef, appConfigurationRef: input.appConfigurationRef,
      environment: input.environment, correlationId: input.correlationId });
    if (Object.keys(input as unknown as Record<string, unknown>).some((key) => !allowedKeys.has(key)) ||
        !isFacebookPageSelectionContext(context) || !Array.isArray(input.selectedAssetRefs) ||
        input.selectedAssetRefs.length > 500 || input.selectedAssetRefs.some((assetRef) => typeof assetRef !== 'string' || !isUuid(assetRef)) ||
        new Set(input.selectedAssetRefs).size !== input.selectedAssetRefs.length) {
      throw new Error('Facebook Page selection is invalid.');
    }
    const requestContext = { tenantId: context.tenantId, appConfigurationId: context.appConfigurationRef,
      environment: context.environment, authorizationId: context.authorizationRef, correlationId: context.correlationId };
    const desired = new Set(input.selectedAssetRefs);
    const outcomes: Array<{ assetRef: string; state: string; reasonCode?: string }> = [];
    const selectedOutcomes: Array<{ assetRef: string; state: string; reasonCode?: string }> = [];
    for (const assetRef of input.selectedAssetRefs) {
      const request = { ...requestContext, assetId: assetRef, desiredFields: Object.freeze([]) };
      const result = await this.subscriptions.connect(request, actor);
      const outcome = Object.freeze({ assetRef, state: result.state, ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}) });
      outcomes.push(outcome);
      selectedOutcomes.push(outcome);
    }
    const persisted = await this.subscriptions.listSelectedAssets({ ...requestContext, assetKind: 'FACEBOOK_PAGE' }, actor);
    if (input.selectedAssetRefs.some((assetRef) => !persisted.some((asset) => asset.assetId === assetRef))) {
      return Object.freeze({ readiness: 'PARTIAL', selectedAssetRefs: Object.freeze([...input.selectedAssetRefs]),
        outcomes: Object.freeze(outcomes) });
    }
    for (const asset of persisted) {
      if (desired.has(asset.assetId)) continue;
      const result = await this.subscriptions.disconnect({ ...requestContext, assetId: asset.assetId }, actor);
      outcomes.push(Object.freeze({ assetRef: asset.assetId, state: result.state,
        ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}) }));
    }
    const ready = selectedOutcomes.length > 0 && selectedOutcomes.every((outcome) => outcome.state === 'ACTIVE');
    return Object.freeze({ readiness: ready ? 'READY' : 'PARTIAL',
      selectedAssetRefs: Object.freeze([...input.selectedAssetRefs]), outcomes: Object.freeze(outcomes) });
  }
}
