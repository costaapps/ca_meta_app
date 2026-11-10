import { OnboardingSagaEffectError, type OnboardingSagaAdapter, type OnboardingSagaContext,
  type OnboardingSagaEvidence, type OnboardingSagaReconciliation } from '../onboarding/onboarding-saga.types.js';

export const INSTAGRAM_PROVIDER = Symbol('INSTAGRAM_PROVIDER');
export const INSTAGRAM_ACCOUNT_STORE = Symbol('INSTAGRAM_ACCOUNT_STORE');
export const INSTAGRAM_SUBSCRIPTION_PORT = Symbol('INSTAGRAM_SUBSCRIPTION_PORT');
export const INSTAGRAM_PROJECTION_PORT = Symbol('INSTAGRAM_PROJECTION_PORT');

export type InstagramOnboardingVariant = 'INSTAGRAM_VIA_FACEBOOK_LOGIN' | 'INSTAGRAM_LOGIN';
export type InstagramAccountKind = 'INSTAGRAM_BUSINESS_ACCOUNT' | 'INSTAGRAM_CREATOR_ACCOUNT';
export type InstagramPersistedAuthorizationVariant = 'FACEBOOK_LOGIN_FOR_BUSINESS' | 'INSTAGRAM_LOGIN';

/**
 * M4.03's callback variant and the persisted credential authorization tuple are separate names.
 * Do not substitute one for the other at a provider or credential boundary.
 */
export interface InstagramOnboardingContext extends OnboardingSagaContext {
  readonly flowVariant: InstagramOnboardingVariant;
  readonly authVariant: InstagramOnboardingVariant;
}

/** Provider-side account data after discovery. This type intentionally has no token field. */
export interface InstagramDiscoveredAccount {
  readonly providerAccountId: string;
  readonly kind: InstagramAccountKind;
  readonly name: string | null;
  /** Opaque credential metadata UUID; it must already be stored in the backend vault. */
  readonly credentialRef: string;
  /** Internal Facebook Page asset UUID for Facebook Login only. */
  readonly pageAssetRef?: string;
}

export interface InstagramDiscoveryResult {
  readonly outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly accounts: readonly InstagramDiscoveredAccount[];
  readonly safeErrorCode?: string;
}

/** Provider implementation owns OAuth exchange and keeps all raw credentials inside the vault boundary. */
export interface InstagramProvider {
  exchangeAndStoreAuthorization(input: InstagramOnboardingContext & {
    readonly code: string;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly authorizationRef: string; readonly grantedScopes: readonly string[]; readonly observedAt: string }>;
  discoverProfessionalAccounts(input: InstagramOnboardingContext & {
    readonly authorizationRef: string;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<InstagramDiscoveryResult>;
  reconcile?(input: InstagramOnboardingContext & {
    readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
    readonly evidence: OnboardingSagaEvidence;
    readonly signal: AbortSignal;
  }): Promise<OnboardingSagaReconciliation>;
}

/** Atomically persists a complete result set and its exact Instagram→Page relation, when applicable. */
export interface InstagramAccountStore {
  persistCompleteAccountSet(input: InstagramOnboardingContext & {
    readonly authorizationRef: string;
    readonly accounts: readonly InstagramDiscoveredAccount[];
    readonly idempotencyKey: string;
    readonly observedAt: string;
  }): Promise<readonly { readonly providerAccountId: string; readonly assetRef: string }[]>;
}

export interface InstagramSubscriptionPort {
  /**
   * Reconcile only the onboarding's explicitly selected assets. A successful result must contain
   * an observed active subscription for every asset reference passed by the saga.
   */
  ensureSelectedAccounts(input: InstagramOnboardingContext & {
    readonly authorizationRef: string;
    readonly assetRefs: readonly string[];
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly outcome: 'ACTIVE' | 'PARTIAL' | 'UNKNOWN'; readonly subscriptionRef?: string;
    readonly assetRefs?: readonly string[] }>;
}

export interface InstagramProjectionPort {
  publish(input: InstagramOnboardingContext & {
    readonly authorizationRef: string;
    readonly assetRefs: readonly string[];
    readonly subscriptionRef: string;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPE = /^[a-z][a-z0-9_]{1,63}$/;
const FACEBOOK_LOGIN_SCOPE_EXAMPLES = new Set([
  'pages_show_list', 'pages_read_engagement', 'instagram_basic',
  'instagram_content_publish', 'instagram_manage_comments',
]);
const STAGE_NAMES = ['authorization', 'asset-verification', 'subscription', 'projection'] as const;
const MAX_ACCOUNTS = 500;

export class InstagramProviderNotConfigured implements InstagramProvider {
  async exchangeAndStoreAuthorization(): Promise<never> {
    // No initial authorization-handle/vault enrollment path is currently configured.
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
  async discoverProfessionalAccounts(): Promise<InstagramDiscoveryResult> {
    return Object.freeze({ outcome: 'FAILED', accounts: Object.freeze([]), safeErrorCode: 'INSTAGRAM_PROVIDER_NOT_CONFIGURED' });
  }
}

export class InstagramAccountStoreNotConfigured implements InstagramAccountStore {
  async persistCompleteAccountSet(): Promise<never> {
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
}

export class InstagramSubscriptionsNotConfigured implements InstagramSubscriptionPort {
  async ensureSelectedAccounts(): Promise<{ readonly outcome: 'PARTIAL' }> {
    return Object.freeze({ outcome: 'PARTIAL' });
  }
}

export class InstagramProjectionNotConfigured implements InstagramProjectionPort {
  async publish(): Promise<never> { throw new OnboardingSagaEffectError('NO_EFFECT'); }
}

/**
 * Flow-specific saga adapter boundary. It is intentionally not registered by default: the
 * authorization exchange, initial credential handle, selected-account subscriptions and app
 * grants still require first-party/app-specific evidence and the shared vault enrollment port.
 */
export class InstagramOnboardingAdapter implements OnboardingSagaAdapter {
  constructor(
    private readonly provider: InstagramProvider,
    private readonly accounts: InstagramAccountStore,
    private readonly subscriptions: InstagramSubscriptionPort,
    private readonly projection: InstagramProjectionPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async exchangeAuthorizationCode(input: OnboardingSagaContext & {
    readonly code: string; readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<{ readonly authorizationRef: string }> {
    const context = requireInstagramContext(input);
    if (!validCode(input.code) || !validIdempotencyKey(input.idempotencyKey) || input.signal.aborted) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    try {
      const result = await this.provider.exchangeAndStoreAuthorization({ ...context, code: input.code,
        idempotencyKey: input.idempotencyKey, signal: input.signal });
      if (!isUuid(result.authorizationRef) || !isIsoUtc(result.observedAt) || !safeScopes(result.grantedScopes) ||
          !scopesMatchVariant(context.flowVariant, result.grantedScopes)) {
        // The provider may already have consumed the code; do not allow the saga to replay it.
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
    const context = requireInstagramContext(input);
    if (!isUuid(input.authorizationRef) || !validIdempotencyKey(input.idempotencyKey) || input.signal.aborted) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }

    let discovery: InstagramDiscoveryResult;
    try {
      discovery = await this.provider.discoverProfessionalAccounts({ ...context, authorizationRef: input.authorizationRef,
        idempotencyKey: input.idempotencyKey, signal: input.signal });
    } catch {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    if (!discovery || discovery.outcome !== 'SUCCEEDED' || !Array.isArray(discovery.accounts) ||
        discovery.accounts.length > MAX_ACCOUNTS || !validAccountSet(context, discovery.accounts)) {
      // Discovery is read-only. Never persist an incomplete or ambiguous account set.
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    if (discovery.accounts.length === 0) return Object.freeze({ assetRefs: Object.freeze([]) });
    if (input.signal.aborted) throw new OnboardingSagaEffectError('NO_EFFECT');

    try {
      const persisted = await this.accounts.persistCompleteAccountSet({ ...context, authorizationRef: input.authorizationRef,
        accounts: Object.freeze(discovery.accounts.map((account) => Object.freeze({ ...account }))),
        idempotencyKey: input.idempotencyKey, observedAt: this.now() });
      const providerIds = discovery.accounts.map((account) => account.providerAccountId);
      if (!Array.isArray(persisted) || persisted.length !== providerIds.length ||
          new Set(persisted.map((account) => account.providerAccountId)).size !== persisted.length ||
          new Set(persisted.map((account) => account.assetRef)).size !== persisted.length ||
          persisted.some((account) => !isUuid(account.assetRef) || !providerIds.includes(account.providerAccountId)) ||
          providerIds.some((id) => !persisted.some((account) => account.providerAccountId === id))) {
        // A malformed store receipt can follow a committed batch; require reconciliation.
        throw new OnboardingSagaEffectError('UNKNOWN');
      }
      return Object.freeze({ assetRefs: Object.freeze(persisted.map((account) => account.assetRef)) });
    } catch (error) {
      if (error instanceof OnboardingSagaEffectError) throw error;
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
  }

  async ensureSubscriptions(input: OnboardingSagaContext & {
    readonly authorizationRef: string; readonly assetRefs: readonly string[];
    readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<void> {
    const context = requireInstagramContext(input);
    if (!isUuid(input.authorizationRef) || !validIdempotencyKey(input.idempotencyKey) ||
        !validUuidSet(input.assetRefs) || input.assetRefs.length === 0 || input.signal.aborted) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    try {
      const result = await this.subscriptions.ensureSelectedAccounts({ ...context, authorizationRef: input.authorizationRef,
        assetRefs: Object.freeze([...input.assetRefs]), idempotencyKey: input.idempotencyKey, signal: input.signal });
      if (result.outcome !== 'ACTIVE' || !isUuid(result.subscriptionRef ?? '') || !validUuidSet(result.assetRefs) ||
          !sameSet(result.assetRefs, input.assetRefs)) {
        throw new OnboardingSagaEffectError(result.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'NO_EFFECT');
      }
    } catch (error) {
      if (error instanceof OnboardingSagaEffectError) throw error;
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
  }

  async publishProjection(input: OnboardingSagaContext & {
    readonly authorizationRef: string; readonly assetRefs: readonly string[]; readonly subscriptionRef: string;
    readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<void> {
    const context = requireInstagramContext(input);
    if (!isUuid(input.authorizationRef) || !isUuid(input.subscriptionRef) || !validIdempotencyKey(input.idempotencyKey) ||
        !validUuidSet(input.assetRefs) || input.assetRefs.length === 0 || input.signal.aborted) {
      throw new OnboardingSagaEffectError('NO_EFFECT');
    }
    try {
      await this.projection.publish({ ...context, authorizationRef: input.authorizationRef,
        assetRefs: Object.freeze([...input.assetRefs]), subscriptionRef: input.subscriptionRef,
        idempotencyKey: input.idempotencyKey, signal: input.signal });
    } catch (error) {
      if (error instanceof OnboardingSagaEffectError) throw error;
      throw new OnboardingSagaEffectError('UNKNOWN');
    }
  }

  async reconcileStage(input: OnboardingSagaContext & {
    readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
    readonly evidence: OnboardingSagaEvidence; readonly idempotencyKey: string; readonly signal: AbortSignal;
  }): Promise<OnboardingSagaReconciliation> {
    const context = requireInstagramContext(input);
    if (!validIdempotencyKey(input.idempotencyKey) || input.signal.aborted ||
        !STAGE_NAMES.includes(input.stage)) return Object.freeze({ disposition: 'UNKNOWN' });
    if (!this.provider.reconcile) return Object.freeze({ disposition: 'UNKNOWN' });
    try {
      // Reconciliation is read-only and never re-submits an authorization code or mutation.
      return await this.provider.reconcile({ ...context, stage: input.stage, evidence: input.evidence, signal: input.signal });
    } catch {
      return Object.freeze({ disposition: 'UNKNOWN' });
    }
  }
}

export function isInstagramOnboardingContext(value: OnboardingSagaContext): value is InstagramOnboardingContext {
  return !!value && typeof value === 'object' &&
    ((value.flowVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN' && value.authVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN') ||
     (value.flowVariant === 'INSTAGRAM_LOGIN' && value.authVariant === 'INSTAGRAM_LOGIN'));
}

/** Maps the callback variant to the M3.06 authorization tuple used by the credential catalog. */
export function persistedInstagramAuthorizationVariant(
  variant: InstagramOnboardingVariant,
): InstagramPersistedAuthorizationVariant {
  return variant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN' ? 'FACEBOOK_LOGIN_FOR_BUSINESS' : 'INSTAGRAM_LOGIN';
}

export function instagramPageLinkRequired(variant: InstagramOnboardingVariant): boolean {
  return variant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN';
}

function requireInstagramContext(value: OnboardingSagaContext): InstagramOnboardingContext {
  if (!isInstagramOnboardingContext(value)) throw new OnboardingSagaEffectError('NO_EFFECT');
  return value;
}

function validAccountSet(context: InstagramOnboardingContext, accounts: readonly InstagramDiscoveredAccount[]): boolean {
  if (!accounts.every((account) => !!account && typeof account === 'object' &&
      Object.keys(account).every((key) => ['providerAccountId', 'kind', 'name', 'credentialRef', 'pageAssetRef'].includes(key)) &&
      PROVIDER_ID.test(account.providerAccountId) &&
      (account.kind === 'INSTAGRAM_BUSINESS_ACCOUNT' || account.kind === 'INSTAGRAM_CREATOR_ACCOUNT') &&
      (account.name === null || (typeof account.name === 'string' && account.name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(account.name))) &&
      isUuid(account.credentialRef) && (account.pageAssetRef === undefined || isUuid(account.pageAssetRef)) &&
      (instagramPageLinkRequired(context.flowVariant) ? isUuid(account.pageAssetRef ?? '') : account.pageAssetRef === undefined))) return false;
  return new Set(accounts.map((account) => account.providerAccountId)).size === accounts.length;
}

function safeScopes(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length <= 256 && values.every((value) =>
    typeof value === 'string' && value.length <= 64 && SCOPE.test(value)) && new Set(values).size === values.length;
}

function scopesMatchVariant(variant: InstagramOnboardingVariant, scopes: readonly string[]): boolean {
  // These are variant markers observed in the Meta-maintained collection, not a grant policy.
  // Reject known cross-variant names without claiming that any scope is required or approved.
  return variant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN'
    ? scopes.every((scope) => !scope.startsWith('instagram_business_'))
    : scopes.every((scope) => !FACEBOOK_LOGIN_SCOPE_EXAMPLES.has(scope) && !scope.startsWith('pages_'));
}

function validCode(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validIdempotencyKey(value: string): boolean {
  return typeof value === 'string' && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validUuidSet(values: readonly string[] | undefined): values is readonly string[] {
  return Array.isArray(values) && values.length <= MAX_ACCOUNTS && values.every(isUuid) && new Set(values).size === values.length;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isUuid(value: string): boolean {
  return typeof value === 'string' && UUID.test(value);
}

function isIsoUtc(value: string): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
