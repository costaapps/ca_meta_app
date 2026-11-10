import type { MetaEnvironment } from '../meta-assets/meta-assets.types.js';
import type { MetaAuthVariant, MetaFlowVariant } from '../credentials/credential-resolver.types.js';
import type { VerifiedServiceTenantScope } from '../identity/identity.types.js';

export type MetaSubscriptionState = 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'UNKNOWN';
export type MetaSubscriptionReconcileState = 'PENDING' | 'ACTIVE' | 'PARTIAL' | 'UNKNOWN' | 'MANUAL_ACTION_REQUIRED';
export type MetaSubscriptionBindingState = 'ACTIVE' | 'REMOVED';
export type MetaSubscriptionTargetKind = 'WHATSAPP_BUSINESS_ACCOUNT';

export interface MetaSubscriptionRequest {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  /** Internal catalog UUID. Provider IDs are resolved on the server and are never accepted here. */
  readonly assetId: string;
  /** Optional internal disambiguator only; the service scope grants authority, and the catalog must prove this grant owns the scoped asset and target. */
  readonly authorizationId?: string;
  readonly desiredFields: readonly string[];
  readonly correlationId: string;
}

export interface MetaSubscriptionActor {
  readonly serviceScope: VerifiedServiceTenantScope;
  readonly correlationId: string;
}

export interface MetaSubscriptionTargetContext {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly authorizationId: string;
  readonly targetAssetId: string;
  readonly sourceAssetId: string;
  readonly providerObjectId: string;
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
  readonly kind: MetaSubscriptionTargetKind;
  readonly authorizationVersion: number;
  readonly targetAssetVersion: number;
  readonly sourceAssetVersion: number;
}

export interface MetaSubscriptionBindingSnapshot {
  readonly assetId: string;
  /** The authorization/grant that owns this connection's need for the physical target. */
  readonly authorizationId: string;
  readonly desiredFields: readonly string[];
  readonly state: MetaSubscriptionBindingState;
  readonly version: number;
}

export interface MetaSubscriptionTargetSnapshot extends MetaSubscriptionTargetContext {
  readonly targetId: string;
  readonly desiredState: MetaSubscriptionState;
  readonly desiredFields: readonly string[];
  readonly observedState: MetaSubscriptionState;
  readonly observedFields: readonly string[];
  readonly state: MetaSubscriptionReconcileState;
  readonly version: number;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly bindings: readonly MetaSubscriptionBindingSnapshot[];
}

export interface MetaSubscriptionClaim {
  readonly target: MetaSubscriptionTargetSnapshot;
  readonly leaseToken: string;
  readonly claimedVersion: number;
}

export interface MetaSubscriptionReconcileResult {
  readonly state: MetaSubscriptionReconcileState;
  readonly desiredState: MetaSubscriptionState;
  readonly observedState: MetaSubscriptionState;
  readonly version: number;
  readonly reasonCode?: string;
  readonly retryAt?: string;
}

export interface MetaSubscriptionInactiveCleanupTarget {
  readonly targetId: string;
  readonly desiredState: MetaSubscriptionState;
  readonly observedState: MetaSubscriptionState;
  readonly state: MetaSubscriptionReconcileState;
  readonly version: number;
  readonly remainingBindingCount: number;
}

export interface MetaSubscriptionInactiveCleanupResult {
  readonly removedBindingCount: number;
  readonly targets: readonly MetaSubscriptionInactiveCleanupTarget[];
}

export type MetaSubscriptionProviderResult =
  | { readonly state: 'SUBSCRIBED'; readonly observedFields: readonly string[] }
  | { readonly state: 'UNKNOWN' | 'PARTIAL'; readonly reasonCode: string; readonly retryable: boolean };

export interface MetaSubscriptionCatalog {
  resolveByAsset(input: Pick<MetaSubscriptionRequest, 'tenantId' | 'appConfigurationId' | 'environment' | 'assetId' | 'authorizationId'>): Promise<MetaSubscriptionTargetContext | undefined>;
  resolveTarget(input: Pick<MetaSubscriptionTargetContext, 'tenantId' | 'appConfigurationId' | 'environment' | 'targetAssetId'> &
    Pick<MetaSubscriptionRequest, 'authorizationId'>): Promise<MetaSubscriptionTargetContext | undefined>;
}

export interface MetaSubscriptionStore {
  ensureBinding(input: MetaSubscriptionTargetContext & {
    readonly desiredFields: readonly string[];
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<MetaSubscriptionTargetSnapshot>;
  removeBinding(input: MetaSubscriptionTargetContext & {
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<MetaSubscriptionTargetSnapshot>;
  /** Removes only stored bindings whose server-side grant is inactive and credential is no longer resolver-eligible. */
  removeInactiveBindings(input: {
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly environment: MetaEnvironment;
    readonly assetId: string;
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<MetaSubscriptionInactiveCleanupResult>;
  claim(input: MetaSubscriptionTargetContext, leaseMilliseconds: number): Promise<MetaSubscriptionClaim | undefined>;
  complete(claim: MetaSubscriptionClaim, input: {
    readonly state: MetaSubscriptionReconcileState;
    readonly observedState: MetaSubscriptionState;
    readonly observedFields: readonly string[];
    readonly reasonCode?: string;
    readonly retryAt?: string;
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<MetaSubscriptionTargetSnapshot>;
  saveAppWebhookDesired(input: {
    readonly tenantId: string;
    readonly appConfigurationId: string;
    readonly environment: MetaEnvironment;
    readonly desiredFields: readonly string[];
    readonly actorRef: string;
    readonly correlationId: string;
  }): Promise<{ readonly desiredFields: readonly string[]; readonly observedFields: readonly string[]; readonly state: 'NOT_CONFIRMED'; readonly version: number }>;
}

export interface MetaSubscriptionProvider {
  ensureWhatsAppSubscribed(input: MetaSubscriptionTargetContext & { readonly actor: MetaSubscriptionActor }): Promise<MetaSubscriptionProviderResult>;
}

export interface MetaSubscriptionAuditEvent {
  readonly tenantId: string;
  readonly appConfigurationId: string;
  readonly targetId?: string;
  readonly assetId?: string;
  readonly action: 'DESIRED_STATE_CHANGED' | 'RECONCILE_SUCCEEDED' | 'RECONCILE_PARTIAL' | 'BINDING_REMOVED' | 'APP_WEBHOOK_DESIRED_CHANGED';
  readonly reasonCode: string;
  readonly beforeVersion?: number;
  readonly afterVersion?: number;
  readonly correlationId: string;
  readonly actorRef: string;
}

export const META_SUBSCRIPTION_STORE = Symbol('META_SUBSCRIPTION_STORE');
export const META_SUBSCRIPTION_CATALOG = Symbol('META_SUBSCRIPTION_CATALOG');
export const META_SUBSCRIPTION_PROVIDER = Symbol('META_SUBSCRIPTION_PROVIDER');
