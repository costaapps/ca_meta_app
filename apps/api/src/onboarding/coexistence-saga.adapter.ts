import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import { isVerifiedServiceTenantScope } from '../identity/identity.service.js';
import type { MetaSubscriptionActor, MetaSubscriptionReconcileResult } from '../meta-subscriptions/meta-subscriptions.types.js';
import type { MetaSubscriptionService } from '../meta-subscriptions/meta-subscription.service.js';
import { OnboardingSagaEffectError, type OnboardingSagaAdapter, type OnboardingSagaContext,
  type OnboardingSagaEvidence, type OnboardingSagaReconciliation } from './onboarding-saga.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CoexistenceAuthorizationExchangeInput extends OnboardingSagaContext {
  readonly code: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

/** The implementation exchanges once and stores any returned secret in CredentialVaultService. */
export interface CoexistenceAuthorizationExchangePort {
  exchangeAndStore(input: CoexistenceAuthorizationExchangeInput): Promise<{ readonly authorizationRef: string }>;
  reconcile(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation>;
}

export interface CoexistenceAssetVerificationInput extends OnboardingSagaContext {
  readonly authorizationRef: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export type CoexistenceAssetVerificationResult =
  | { readonly state: 'VERIFIED'; readonly phoneAssetRef: string; readonly businessAccountAssetRef: string }
  | { readonly state: 'NO_ELIGIBLE_PHONE' | 'SELECTION_REQUIRED' | 'GRANT_NOT_CONFIRMED' };

/** Discovers only within the server-owned authorization, verifies PHONE_TO_ACCOUNT and applies an internal selection. */
export interface CoexistenceAssetVerificationPort {
  verifyAndPersist(input: CoexistenceAssetVerificationInput): Promise<CoexistenceAssetVerificationResult>;
  reconcile(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation>;
}

export interface CoexistenceSubscriptionInput extends OnboardingSagaContext {
  readonly authorizationRef: string;
  readonly phoneAssetRef: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

/** Implementations delegate to M4.11 MetaSubscriptionService with a verified worker service scope. */
export interface CoexistenceSubscriptionPort {
  connect(input: CoexistenceSubscriptionInput): Promise<MetaSubscriptionReconcileResult>;
  reconcile(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation>;
}

export interface CoexistenceSubscriptionContextResolver {
  /** Resolves the pinned app environment and worker service scope, never from the onboarding request. */
  resolve(input: OnboardingSagaContext): Promise<{ readonly appConfigurationId: string; readonly environment: MetaEnvironment;
    readonly actor: MetaSubscriptionActor }>;
}

export interface CoexistenceSubscriptionObservationPort {
  /** Read-only check for an ambiguous subscription effect; must not enqueue or issue a provider write. */
  read(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation>;
}

/** Routes the coexistence phone binding through M4.11; reconciliation is delegated to a read-only observer. */
export class M4_11CoexistenceSubscriptionPort implements CoexistenceSubscriptionPort {
  constructor(private readonly service: MetaSubscriptionService, private readonly contexts: CoexistenceSubscriptionContextResolver,
    private readonly observation: CoexistenceSubscriptionObservationPort) {}

  async connect(input: CoexistenceSubscriptionInput): Promise<MetaSubscriptionReconcileResult> {
    if (input.signal.aborted || input.flowVariant !== 'WHATSAPP_COEXISTENCE' ||
        input.authVariant !== 'WHATSAPP_BUSINESS_APP_ONBOARDING' || !UUID.test(input.phoneAssetRef) ||
        !UUID.test(input.authorizationRef)) throw new OnboardingSagaEffectError('NO_EFFECT');
    const resolved = await this.contexts.resolve(input);
    if (!resolved || !isVerifiedServiceTenantScope(resolved.actor?.serviceScope) ||
        resolved.actor.serviceScope.tenantId !== input.tenantId ||
        !resolved.actor.serviceScope.scopes.includes('META_CONNECTION_EXECUTE') ||
        resolved.actor.correlationId !== input.correlationId) throw new OnboardingSagaEffectError('NO_EFFECT');
    const request = coexistenceSubscriptionRequest(input, input.phoneAssetRef, resolved.appConfigurationId, resolved.environment);
    return await this.service.connect(request, resolved.actor);
  }

  async reconcile(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation> {
    if (input.stage !== 'subscription') return { disposition: 'UNKNOWN' };
    return await this.observation.read(input);
  }
}

export interface CoexistenceProjectionInput extends OnboardingSagaContext {
  readonly authorizationRef: string;
  readonly phoneAssetRef: string;
  readonly businessAccountAssetRef: string;
  readonly subscriptionRef: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface CoexistenceProjectionPort {
  publish(input: CoexistenceProjectionInput): Promise<void>;
  reconcile(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation>;
}

export interface CoexistenceReconciliationInput extends OnboardingSagaContext {
  readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
  readonly evidence: OnboardingSagaEvidence;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface CoexistenceSagaPorts {
  readonly authorization: CoexistenceAuthorizationExchangePort;
  readonly assets: CoexistenceAssetVerificationPort;
  readonly subscriptions: CoexistenceSubscriptionPort;
  readonly projection: CoexistenceProjectionPort;
}

/**
 * Flow-specific saga adapter. It has no phone registration, deregistration, or deletion capability.
 * Code exchange and credential storage are one port operation; only an internal authorization ref
 * can cross back into the generic saga checkpoint.
 */
export class CoexistenceOnboardingSagaAdapter implements OnboardingSagaAdapter {
  constructor(private readonly ports: CoexistenceSagaPorts) {}

  async exchangeAuthorizationCode(input: CoexistenceAuthorizationExchangeInput): Promise<{ readonly authorizationRef: string }> {
    this.assertContext(input);
    this.assertOperation(input);
    let result: { readonly authorizationRef: string };
    try { result = await this.ports.authorization.exchangeAndStore(input); }
    catch (error) { throw safeEffectError(error); }
    if (!UUID.test(result?.authorizationRef ?? '')) throw new OnboardingSagaEffectError('UNKNOWN');
    return Object.freeze({ authorizationRef: result.authorizationRef });
  }

  async discoverAndPersistAssets(input: CoexistenceAssetVerificationInput): Promise<{ readonly assetRefs: readonly string[] }> {
    this.assertContext(input);
    this.assertOperation(input);
    if (!UUID.test(input.authorizationRef)) throw new OnboardingSagaEffectError('NO_EFFECT');
    let result: CoexistenceAssetVerificationResult;
    try { result = await this.ports.assets.verifyAndPersist(input); }
    catch (error) { throw safeEffectError(error); }
    if (result.state !== 'VERIFIED') {
      // Ambiguity, missing grants and zero eligible phone assets never reach a success checkpoint.
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    const refs = [result.phoneAssetRef, result.businessAccountAssetRef];
    if (!refs.every((ref) => UUID.test(ref)) || new Set(refs).size !== refs.length) {
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
    return Object.freeze({ assetRefs: Object.freeze(refs) });
  }

  async ensureSubscriptions(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly assetRefs: readonly string[];
    readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<void> {
    this.assertContext(input);
    this.assertOperation(input);
    const phoneAssetRef = input.assetRefs[0];
    if (!UUID.test(input.authorizationRef) || !phoneAssetRef || !validAssetPair(input.assetRefs, phoneAssetRef)) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    let result: MetaSubscriptionReconcileResult;
    try { result = await this.ports.subscriptions.connect({ ...input, phoneAssetRef }); }
    catch (error) { throw safeEffectError(error); }
    if (result.state === 'ACTIVE' && result.desiredState === 'SUBSCRIBED' && result.observedState === 'SUBSCRIBED') return;
    if (result.reasonCode === 'SUBSCRIPTION_VARIANT_NOT_CONFIRMED' || result.reasonCode === 'ASSET_SUBSCRIPTION_FIELDS_NOT_CONFIRMED' ||
        result.reasonCode === 'ASSET_NOT_ELIGIBLE') throw new OnboardingSagaEffectError('NO_EFFECT');
    throw new OnboardingSagaEffectError(result.observedState === 'UNKNOWN' ? 'UNKNOWN' : 'NO_EFFECT');
  }

  async publishProjection(input: OnboardingSagaContext & { readonly authorizationRef: string; readonly assetRefs: readonly string[];
    readonly subscriptionRef: string; readonly idempotencyKey: string; readonly signal: AbortSignal }): Promise<void> {
    this.assertContext(input);
    this.assertOperation(input);
    const phoneAssetRef = input.assetRefs[0];
    const businessAccountAssetRef = input.assetRefs[1];
    if (!UUID.test(input.authorizationRef) || !phoneAssetRef || !businessAccountAssetRef ||
        !validAssetPair(input.assetRefs, phoneAssetRef, businessAccountAssetRef) ||
        !/^internal:subscription:[a-f0-9]{64}$/.test(input.subscriptionRef)) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    try { await this.ports.projection.publish({ ...input, phoneAssetRef, businessAccountAssetRef }); }
    catch (error) { throw safeEffectError(error); }
  }

  async reconcileStage(input: CoexistenceReconciliationInput): Promise<OnboardingSagaReconciliation> {
    this.assertContext(input);
    this.assertOperation(input);
    if (input.stage === 'authorization') return await this.ports.authorization.reconcile(input);
    if (input.stage === 'asset-verification') return await this.ports.assets.reconcile(input);
    if (input.stage === 'subscription') return await this.ports.subscriptions.reconcile(input);
    return await this.ports.projection.reconcile(input);
  }

  private assertContext(input: OnboardingSagaContext): void {
    if (input.flowVariant !== 'WHATSAPP_COEXISTENCE' || input.authVariant !== 'WHATSAPP_BUSINESS_APP_ONBOARDING' ||
        !UUID.test(input.tenantId) || !UUID.test(input.onboardingId) || !UUID.test(input.principalId) ||
        !UUID.test(input.portalSessionId) || !UUID.test(input.correlationId) || !input.configurationRef ||
        input.configurationRef.length > 128 || !input.capabilityManifestVersion || input.capabilityManifestVersion.length > 128 ||
        !input.graphApiVersion || input.graphApiVersion.length > 32) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
  }

  private assertOperation(input: { readonly signal: AbortSignal; readonly idempotencyKey: string }): void {
    if (input.signal.aborted || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 16 ||
        input.idempotencyKey.length > 256 || /[\r\n]/.test(input.idempotencyKey)) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
  }
}

/** Default runtime stays disabled until exact first-party Coexistence exchange/grant evidence is reviewed. */
export class UnavailableCoexistenceSagaPorts implements CoexistenceSagaPorts {
  readonly authorization: CoexistenceAuthorizationExchangePort = {
    exchangeAndStore: async () => { throw new OnboardingSagaEffectError('NO_EFFECT'); },
    reconcile: async () => ({ disposition: 'UNKNOWN' }),
  };
  readonly assets: CoexistenceAssetVerificationPort = {
    verifyAndPersist: async () => ({ state: 'GRANT_NOT_CONFIRMED' }),
    reconcile: async () => ({ disposition: 'UNKNOWN' }),
  };
  readonly subscriptions: CoexistenceSubscriptionPort = {
    connect: async () => ({ state: 'PARTIAL', desiredState: 'SUBSCRIBED', observedState: 'UNKNOWN', version: 0,
      reasonCode: 'SUBSCRIPTION_VARIANT_NOT_CONFIRMED' }),
    reconcile: async () => ({ disposition: 'UNKNOWN' }),
  };
  readonly projection: CoexistenceProjectionPort = {
    publish: async () => { throw new OnboardingSagaEffectError('NO_EFFECT'); },
    reconcile: async () => ({ disposition: 'UNKNOWN' }),
  };
}

/** The safe field set is intentionally internal. Provider account/phone identifiers never appear here. */
export function coexistenceSubscriptionRequest(input: CoexistenceSubscriptionInput, phoneAssetRef: string,
  appConfigurationId: string, environment: MetaEnvironment): Readonly<{ tenantId: string; appConfigurationId: string; environment: MetaEnvironment;
    assetId: string; authorizationId: string; desiredFields: readonly string[]; correlationId: string }> {
  if (!UUID.test(input.tenantId) || !UUID.test(appConfigurationId) || !UUID.test(input.authorizationRef) ||
      !UUID.test(phoneAssetRef) || input.flowVariant !== 'WHATSAPP_COEXISTENCE' ||
      input.authVariant !== 'WHATSAPP_BUSINESS_APP_ONBOARDING' ||
      !['development', 'test', 'staging', 'production'].includes(environment)) throw new OnboardingSagaEffectError('NO_EFFECT');
  return Object.freeze({ tenantId: input.tenantId, appConfigurationId, environment,
    assetId: phoneAssetRef, authorizationId: input.authorizationRef, desiredFields: Object.freeze([]),
    correlationId: input.correlationId });
}

function validAssetPair(assetRefs: readonly string[], phoneAssetRef: string, businessAccountAssetRef?: string): boolean {
  if (!Array.isArray(assetRefs) || assetRefs.length !== 2 || assetRefs.some((ref) => !UUID.test(ref)) ||
      new Set(assetRefs).size !== 2 || !assetRefs.includes(phoneAssetRef)) return false;
  return businessAccountAssetRef === undefined || assetRefs.includes(businessAccountAssetRef);
}

function safeEffectError(error: unknown): OnboardingSagaEffectError {
  return error instanceof OnboardingSagaEffectError ? error : new OnboardingSagaEffectError('UNKNOWN');
}
