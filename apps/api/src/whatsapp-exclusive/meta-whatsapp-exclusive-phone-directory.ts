import type { CredentialResolverService } from '../credentials/credential-resolver.service.js';
import type { CredentialResolutionActor, CredentialResolutionHandle } from '../credentials/credential-resolver.types.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';
import type { MetaGraphClient } from '../meta-graph/meta-graph.client.js';
import type { MetaGraphExecutionContext, MetaGraphInput } from '../meta-graph/meta-graph.types.js';
import { OnboardingSagaEffectError } from '../onboarding/onboarding-saga.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^\d{1,32}$/;

/** Internal target assembled by an authorized tenant catalog; its provider WABA ID is never browser input. */
export interface WhatsAppExclusiveWabaTarget {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly authorizationRef: string;
  readonly assetRef: string;
  readonly providerWabaId: string;
  readonly configurationRef: string;
  readonly correlationId: string;
  readonly actor: CredentialResolutionActor;
}

/** Server-only provider identifiers returned for verified asset upsert; never project this type to portal status. */
export interface WhatsAppExclusivePhoneObservation {
  readonly providerPhoneId: string;
  readonly verifiedName: string | null;
  readonly displayPhoneNumber: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Lists all pages of phone_numbers using a resolver-selected credential on the exact internal WABA asset. */
export class MetaWhatsAppExclusivePhoneDirectory {
  constructor(
    private readonly configs: MetaAppConfigRegistry,
    private readonly credentials: Pick<CredentialResolverService, 'resolve'>,
    private readonly graph: Pick<MetaGraphClient, 'collect'>,
  ) {}

  async list(target: WhatsAppExclusiveWabaTarget, signal?: AbortSignal): Promise<readonly WhatsAppExclusivePhoneObservation[]> {
    if (!target || !UUID.test(target.tenantId) || !UUID.test(target.appConfigurationId) || !UUID.test(target.authorizationRef) ||
        !UUID.test(target.assetRef) || !UUID.test(target.correlationId) || !PROVIDER_ID.test(target.providerWabaId) ||
        !['development', 'test', 'staging', 'production'].includes(target.environment) || !target.actor ||
        target.actor.correlationId !== target.correlationId || target.actor.serviceScope?.tenantId !== target.tenantId || signal?.aborted) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    const profile = this.configs.resolve('WHATSAPP_EXCLUSIVE', 'WHATSAPP_EMBEDDED_SIGNUP', target.environment);
    if (!profile || profile.configurationRef !== target.configurationRef || profile.versions.graphApi.status !== 'VERIFIED') {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }

    let credential;
    try {
      credential = await this.credentials.resolve({ tenantId: target.tenantId, provider: 'META',
        appConfigurationId: target.appConfigurationId, environment: target.environment,
        assetId: target.assetRef, operation: 'ASSET_DISCOVERY' }, target.actor);
    } catch { throw new OnboardingSagaEffectError('NO_EFFECT'); }
    if (credential.status !== 'READY' || credential.capability !== 'ASSET_DISCOVERY') throw new OnboardingSagaEffectError('NO_EFFECT');

    const operation = 'ASSET_DISCOVERY' as const;
    const graphContext: MetaGraphExecutionContext = Object.freeze({ tenantId: target.tenantId, provider: 'META',
      appConfigurationId: target.appConfigurationId, environment: target.environment, assetId: target.assetRef, operation,
      flowVariant: 'WHATSAPP_EXCLUSIVE', authVariant: 'WHATSAPP_EMBEDDED_SIGNUP',
      configurationRef: profile.configurationRef, providerObjectId: target.providerWabaId });
    const input: MetaGraphInput = Object.freeze({ endpoint: 'ASSET_EDGE_LIST', edge: 'phone_numbers', context: graphContext,
      credentialHandle: credential.handle as CredentialResolutionHandle, credentialCapability: operation, operation,
      correlationId: target.correlationId, resourceId: target.providerWabaId,
      query: Object.freeze({ fields: 'id,verified_name,display_phone_number,quality_rating', limit: 100 }) });
    const result = await this.graph.collect(input, { maxPages: 100, maxItems: 100 });
    if (result.outcome !== 'SUCCEEDED') throw new OnboardingSagaEffectError('NO_EFFECT');

    const phones: WhatsAppExclusivePhoneObservation[] = [];
    const seen = new Set<string>();
    for (const item of result.data) {
      if (!record(item) || typeof item['id'] !== 'string' || !PROVIDER_ID.test(item['id']) || seen.has(item['id'])) {
        throw new OnboardingSagaEffectError('NO_EFFECT');
      }
      const verifiedName = safeText(item['verified_name'], 512);
      const displayPhoneNumber = safeText(item['display_phone_number'], 64);
      if (verifiedName === undefined || displayPhoneNumber === undefined) throw new OnboardingSagaEffectError('NO_EFFECT');
      seen.add(item['id']);
      phones.push(Object.freeze({ providerPhoneId: item['id'], verifiedName, displayPhoneNumber }));
    }
    if (phones.length === 0) throw new OnboardingSagaEffectError('NO_EFFECT');
    return Object.freeze(phones.sort((left, right) => left.providerPhoneId.localeCompare(right.providerPhoneId)));
  }
}
