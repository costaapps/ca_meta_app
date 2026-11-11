import { OnboardingSagaEffectError, type OnboardingSagaContext, type OnboardingSagaEvidence, type OnboardingSagaReconciliation } from '../onboarding/onboarding-saga.types.js';
import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';

export const FACEBOOK_LOGIN_FOR_BUSINESS = 'FACEBOOK_LOGIN_FOR_BUSINESS' as const;
export const FACEBOOK_MANAGED_PAGES_PATH = '/me/accounts' as const;
export const FACEBOOK_MANAGED_PAGES_FIELDS = Object.freeze(['name', 'access_token', 'tasks'] as const);
export const FACEBOOK_PAGES_PROVIDER = Symbol('FACEBOOK_PAGES_PROVIDER');
export const FACEBOOK_PAGE_ASSET_STORE = Symbol('FACEBOOK_PAGE_ASSET_STORE');
export const FACEBOOK_PAGE_PROJECTION_PORT = Symbol('FACEBOOK_PAGE_PROJECTION_PORT');

export interface FacebookPagesContext extends OnboardingSagaContext {
  readonly flowVariant: 'FACEBOOK_LOGIN';
  readonly authVariant: typeof FACEBOOK_LOGIN_FOR_BUSINESS;
}

export interface FacebookManagedPage {
  /** Provider page ID, kept server-side and never accepted from a browser selection request. */
  readonly id: string;
  readonly name: string | null;
  /** Opaque credential metadata UUID returned by the vault-owned batch enrollment callback. */
  readonly credentialRef: string;
  /** Observed Page tasks are role context; they are not Graph permissions or capability grants. */
  readonly tasks: readonly string[];
}

export interface FacebookPageListPage {
  readonly outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly pages: readonly FacebookManagedPage[];
  readonly safeErrorCode?: string;
}

/** Provider edge port. Implementations use only the Facebook Login for Business user authorization. */
export interface FacebookPagesProvider {
  exchangeAndStoreAuthorization(input: FacebookPagesContext & {
    readonly code: string;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly authorizationRef: string; readonly grantedScopes: readonly string[]; readonly observedAt: string }>;
  /** Use the typed /me/accounts Graph operation; Page tokens never enter this provider result. */
  listManagedPages(input: FacebookPagesContext & {
    readonly authorizationRef: string;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<FacebookPageListPage>;
  reconcile?(input: FacebookPagesContext & {
    readonly stage: 'authorization' | 'asset-verification' | 'subscription' | 'projection';
    readonly evidence: OnboardingSagaEvidence;
    readonly signal: AbortSignal;
  }): Promise<OnboardingSagaReconciliation>;
}

export class FacebookPagesProviderNotConfigured implements FacebookPagesProvider {
  async exchangeAndStoreAuthorization(): Promise<never> {
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
  async listManagedPages(): Promise<FacebookPageListPage> {
    return Object.freeze({ outcome: 'FAILED', pages: Object.freeze([]), safeErrorCode: 'FACEBOOK_PROVIDER_NOT_CONFIGURED' });
  }
}

export interface FacebookPageAssetStore {
  /**
   * Persists the complete page set, creating one credential metadata/vault binding per Page token.
   * Implementations must be idempotent by tenant/config/authorization/Page ID and must not persist
   * Page tasks as permission grants. Expiry stays UNKNOWN unless a provider observation proves it.
   */
  persistCompletePageSet(input: FacebookPagesContext & {
    readonly authorizationRef: string;
    readonly pages: readonly FacebookManagedPage[];
    readonly idempotencyKey: string;
    readonly observedAt: string;
  }): Promise<readonly { readonly providerPageId: string; readonly assetRef: string }[]>;
}

export class FacebookPageAssetEnrollmentNotConfigured implements FacebookPageAssetStore {
  async persistCompletePageSet(): Promise<never> {
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
}

export interface FacebookPageSelectionContext {
  readonly tenantId: string;
  readonly authorizationRef: string;
  readonly appConfigurationRef: string;
  readonly environment: MetaEnvironment;
  readonly correlationId: string;
}

export interface FacebookPageProjectionPort {
  publish(input: FacebookPageSelectionContext & {
    readonly selectedAssetRefs: readonly string[];
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface FacebookPageCapabilitySnapshot {
  readonly pageAssetRef: string;
  readonly tasksObserved: readonly string[];
  readonly readPageStatus: false;
  readonly readMessages: false;
  readonly replyToComments: false;
  readonly sendMessages: false;
  readonly reasonCode: 'PERMISSION_MAPPING_NOT_CONFIRMED';
}

export function facebookPageCapabilitySnapshot(pageAssetRef: string, tasksObserved: readonly string[]): FacebookPageCapabilitySnapshot {
  if (!isUuid(pageAssetRef)) throw new Error('Facebook Page reference is invalid.');
  const safeTasks = tasksObserved.filter((task) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(task)).slice(0, 64);
  return Object.freeze({
    pageAssetRef,
    tasksObserved: Object.freeze([...new Set(safeTasks)]),
    readPageStatus: false,
    readMessages: false,
    replyToComments: false,
    sendMessages: false,
    reasonCode: 'PERMISSION_MAPPING_NOT_CONFIRMED',
  });
}

export class FacebookPageProjectionNotConfigured implements FacebookPageProjectionPort {
  async publish(): Promise<void> {
    throw new OnboardingSagaEffectError('NO_EFFECT');
  }
}

export function isFacebookPagesContext(value: OnboardingSagaContext): value is FacebookPagesContext {
  return !!value && typeof value === 'object' && value.flowVariant === 'FACEBOOK_LOGIN' &&
    value.authVariant === FACEBOOK_LOGIN_FOR_BUSINESS;
}

export function isFacebookPageSelectionContext(value: FacebookPageSelectionContext): boolean {
  const allowed = new Set(['tenantId', 'authorizationRef', 'appConfigurationRef', 'environment', 'correlationId']);
  return !!value && typeof value === 'object' && Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    isUuid(value.tenantId) && isUuid(value.authorizationRef) && isUuid(value.appConfigurationRef) &&
    ['development', 'test', 'staging', 'production'].includes(value.environment) &&
    typeof value.correlationId === 'string' && value.correlationId.trim().length > 0 && value.correlationId.length <= 128;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isIsoUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
