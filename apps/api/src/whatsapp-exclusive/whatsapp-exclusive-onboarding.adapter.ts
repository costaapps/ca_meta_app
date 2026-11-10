import { isUuid } from '../jobs/event-validation.js';
import type { OnboardingSagaContext, OnboardingSagaAdapter, OnboardingSagaEvidence,
  OnboardingSagaReconciliation } from '../onboarding/onboarding-saga.types.js';
import { OnboardingSagaEffectError } from '../onboarding/onboarding-saga.types.js';
import { hasReadyPhoneReadiness, isSafePhoneReadiness, type OnboardingPhoneReadiness } from '../onboarding/onboarding-phone-readiness.js';

export interface WhatsAppExclusiveAssetDiscovery {
  /** Internal refs of selected, server-verified assets only; provider IDs and browser claims are excluded. */
  readonly assetRefs: readonly string[];
  /** Internal phone asset refs from assetRefs, with one status for each selected number. */
  readonly phoneAssetRefs: readonly string[];
  readonly phoneReadiness: readonly OnboardingPhoneReadiness[];
}

/** Provider operations are separate from Coexistence and are supplied only by reviewed server adapters. */
export interface WhatsAppExclusiveOperations {
  exchangeAuthorizationCode(input: OnboardingSagaContext & { readonly code: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<{
    readonly authorizationRef: string;
  }>;
  discoverAndPersistAssets(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<WhatsAppExclusiveAssetDiscovery>;
  ensureSubscriptions(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly assetRefs: readonly string[]; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<void>;
  publishProjection(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly assetRefs: readonly string[]; readonly subscriptionRef: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<void>;
  reconcileStage(input: OnboardingSagaContext & { readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
    readonly evidence: OnboardingSagaEvidence; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<OnboardingSagaReconciliation>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{16,128}$/;

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY.test(value)) throw new OnboardingSagaEffectError('NO_EFFECT');
}

function assertExclusive(input: OnboardingSagaContext): void {
  if (input.flowVariant !== 'WHATSAPP_CLOUD_API' || input.authVariant !== 'WHATSAPP_EMBEDDED_SIGNUP' ||
      !UUID.test(input.tenantId) || !UUID.test(input.onboardingId) || !UUID.test(input.principalId) ||
      !UUID.test(input.portalSessionId) || !UUID.test(input.correlationId) ||
      !/^[A-Za-z0-9._-]{1,96}$/.test(input.configurationRef) || !/^v\d{1,2}\.\d{1,3}$/.test(input.graphApiVersion) ||
      !/^[A-Za-z0-9._-]{1,96}$/.test(input.capabilityManifestVersion)) {
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
}

function assertAssetRefs(assetRefs: readonly string[]): void {
  if (!Array.isArray(assetRefs) || assetRefs.length < 1 || assetRefs.length > 100 ||
      new Set(assetRefs).size !== assetRefs.length || !assetRefs.every(isUuid)) throw new OnboardingSagaEffectError('NO_EFFECT');
}

/**
 * Exclusive-only adapter for the shared M4.03 saga. Its operations port is deliberately not
 * registered by default. The owner must supply a server-side code exchange, grant-aware catalog,
 * M4.11 subscription adapter and projection adapter; browser IDs are never an input.
 */
export class WhatsAppExclusiveOnboardingAdapter implements OnboardingSagaAdapter {
  constructor(private readonly operations: WhatsAppExclusiveOperations) {}

  async exchangeAuthorizationCode(input: Parameters<OnboardingSagaAdapter['exchangeAuthorizationCode']>[0]): Promise<{ readonly authorizationRef: string }> {
    assertExclusive(input);
    assertIdempotencyKey(input.idempotencyKey);
    if (typeof input.code !== 'string' || input.code.length < 1 || Buffer.byteLength(input.code, 'utf8') > 16_384 || /[\u0000-\u001f\u007f]/.test(input.code)) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    const result = await this.operations.exchangeAuthorizationCode(input);
    if (!result || !UUID.test(result.authorizationRef)) throw new OnboardingSagaEffectError('UNKNOWN');
    return Object.freeze({ authorizationRef: result.authorizationRef });
  }

  async discoverAndPersistAssets(input: Parameters<OnboardingSagaAdapter['discoverAndPersistAssets']>[0]): Promise<{
    readonly assetRefs: readonly string[]; readonly phoneReadiness: readonly OnboardingPhoneReadiness[];
  }> {
    assertExclusive(input);
    assertIdempotencyKey(input.idempotencyKey);
    if (!UUID.test(input.authorizationRef)) throw new OnboardingSagaEffectError('NO_EFFECT');
    const result = await this.operations.discoverAndPersistAssets(input);
    if (!result) throw new OnboardingSagaEffectError('UNKNOWN');
    assertAssetRefs(result.assetRefs);
    assertAssetRefs(result.phoneAssetRefs);
    if (result.phoneAssetRefs.some((ref) => !result.assetRefs.includes(ref)) ||
        !isSafePhoneReadiness(result.phoneReadiness, input.flowVariant, result.assetRefs) ||
        result.phoneReadiness.length !== result.phoneAssetRefs.length ||
        result.phoneAssetRefs.some((ref) => !result.phoneReadiness.some((item) => item.assetRef === ref))) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    // The durable saga store performs the authoritative tenant, authorization and asset-kind ownership query.
    if (!result.phoneReadiness.every((item) => result.phoneAssetRefs.includes(item.assetRef))) throw new OnboardingSagaEffectError('NO_EFFECT');
    return Object.freeze({ assetRefs: Object.freeze([...result.assetRefs]),
      phoneReadiness: Object.freeze(result.phoneReadiness.map((item) => Object.freeze({ ...item }))) });
  }

  async ensureSubscriptions(input: Parameters<OnboardingSagaAdapter['ensureSubscriptions']>[0]): Promise<void> {
    assertExclusive(input);
    assertIdempotencyKey(input.idempotencyKey);
    assertAssetRefs(input.assetRefs);
    if (!UUID.test(input.authorizationRef)) throw new OnboardingSagaEffectError('NO_EFFECT');
    await this.operations.ensureSubscriptions(input);
  }

  async publishProjection(input: Parameters<OnboardingSagaAdapter['publishProjection']>[0]): Promise<void> {
    assertExclusive(input);
    assertIdempotencyKey(input.idempotencyKey);
    assertAssetRefs(input.assetRefs);
    if (!UUID.test(input.authorizationRef) || typeof input.subscriptionRef !== 'string' || !input.subscriptionRef.startsWith('internal:subscription:')) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    await this.operations.publishProjection(input);
  }

  async reconcileStage(input: Parameters<NonNullable<OnboardingSagaAdapter['reconcileStage']>>[0]): Promise<OnboardingSagaReconciliation> {
    assertExclusive(input);
    assertIdempotencyKey(input.idempotencyKey);
    const result = await this.operations.reconcileStage(input);
    if (result.disposition === 'APPLIED') {
      const readiness = result.evidence.phoneReadiness;
      if (input.stage === 'asset-verification' && (!result.evidence.verifiedAssetRefs || !readiness ||
          !isSafePhoneReadiness(readiness, input.flowVariant, result.evidence.verifiedAssetRefs) ||
          !hasReadyPhoneReadiness(readiness))) throw new OnboardingSagaEffectError('UNKNOWN');
    }
    return result;
  }
}
