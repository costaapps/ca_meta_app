import type { VerifiedServiceTenantScope } from '../identity/identity.types.js';
import type { MetaEnvironment, MetaAssetKind, AssetRelationType, AuthorizationState } from '../meta-assets/meta-assets.types.js';
import type { CredentialBinding, CredentialVaultActor } from './credential-vault.types.js';

export type CredentialResolverOperation =
  | 'ASSET_DISCOVERY'
  | 'READ_STATUS'
  | 'SUBSCRIBE_WEBHOOKS'
  | 'SEND_MESSAGE'
  | 'MANAGE_TEMPLATES'
  | 'PHONE_REGISTRATION_CONVENTIONAL';

export type MetaFlowVariant = 'FACEBOOK' | 'INSTAGRAM' | 'WHATSAPP_EXCLUSIVE' | 'WHATSAPP_COEXISTENCE';
export type MetaAuthVariant = 'FACEBOOK_LOGIN_FOR_BUSINESS' | 'INSTAGRAM_LOGIN' |
  'WHATSAPP_EMBEDDED_SIGNUP' | 'WHATSAPP_BUSINESS_APP_ONBOARDING';
export type CredentialPurpose = 'APP_INSPECTION' | 'CUSTOMER_OPERATION';
export type CredentialHealth = 'HEALTHY' | 'EXPIRING' | 'EXPIRED' | 'REVOKED' | 'ACTION_REQUIRED' | 'UNKNOWN' | 'STALE';
export type CredentialHealthObservation =
  | { readonly state: 'HEALTHY' | 'EXPIRING' | 'EXPIRED' | 'REVOKED' | 'ACTION_REQUIRED'; readonly observedAt: string; readonly source: 'META_API' | 'SIGNED_WEBHOOK' }
  | { readonly state: 'UNKNOWN' | 'STALE' };
export type CredentialExpiry =
  | { readonly state: 'KNOWN'; readonly expiresAt: string; readonly observedAt: string; readonly source: 'META_API' | 'SIGNED_WEBHOOK' }
  | { readonly state: 'PROVIDER_NO_EXPIRY'; readonly observedAt: string; readonly source: 'META_API' | 'SIGNED_WEBHOOK' }
  | { readonly state: 'UNKNOWN' | 'STALE' };

export interface CredentialResolutionContext {
  readonly tenantId: string;
  readonly provider: 'META';
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly assetId: string;
  readonly operation: CredentialResolverOperation;
}

export interface CredentialOperationPolicyContext extends CredentialResolutionContext {}

export interface CredentialAncestryRule {
  readonly relationType: AssetRelationType;
  readonly childKind: MetaAssetKind;
  readonly parentKind: MetaAssetKind;
}

/** Server-owned operation policy. Provider scope names and token families are never client input. */
export interface CredentialOperationPolicy {
  readonly tenantId: string;
  readonly provider: 'META';
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly operation: CredentialResolverOperation;
  readonly version: number;
  readonly flowVariant: MetaFlowVariant;
  readonly authVariant: MetaAuthVariant;
  readonly capability: CredentialResolverOperation;
  readonly purpose: CredentialPurpose;
  readonly assetKinds: readonly MetaAssetKind[];
  readonly allowedFamilies: readonly string[];
  readonly preferredFamilies: readonly string[];
  readonly requiredAssetGrants: readonly string[];
  readonly requiredAuthorizationScopes: readonly string[];
  readonly ancestryRules: readonly CredentialAncestryRule[];
  readonly allowExpiring: boolean;
  readonly maxHealthObservationAgeSeconds: number;
}

export interface CredentialResolutionActor {
  readonly serviceScope: VerifiedServiceTenantScope;
  readonly correlationId: string;
}

export interface CredentialResolutionAsset {
  readonly assetId: string;
  readonly kind: MetaAssetKind;
  readonly verified: boolean;
  readonly version: number;
}

export interface CredentialLineageStep {
  readonly childAssetId: string;
  readonly childKind: MetaAssetKind;
  readonly relationType: AssetRelationType;
  readonly parentAssetId: string;
  readonly parentKind: MetaAssetKind;
  readonly verified: boolean;
}

export interface CredentialResolutionCandidate {
  readonly binding: CredentialBinding;
  readonly authorizationState: AuthorizationState;
  readonly authorizationVersion: number;
  readonly credentialStatus: 'ACTIVE' | 'REVOKED' | 'REAUTH_REQUIRED' | 'UNKNOWN';
  readonly credentialVersion: number;
  readonly assetAuthorizationState: 'ACTIVE' | 'REVOKED' | 'QUARANTINED';
  readonly assetVerificationState: 'VERIFIED' | 'CLAIMED';
  readonly assetAuthorizationVersion: number;
  readonly grantAssetId: string;
  readonly grantAssetKind: MetaAssetKind;
  /** Ordered from the requested leaf toward the granted ancestor. Direct grants use []. */
  readonly lineage: readonly CredentialLineageStep[];
  readonly grantedAssetGrants: readonly string[];
  readonly grantedAuthorizationScopes: readonly string[];
  readonly secretAvailable: boolean;
  readonly secretVersion: number;
  readonly health: CredentialHealthObservation;
  readonly expiry: CredentialExpiry;
  /** Data-access expiry is an independent authorization boundary and must be fresh/known. */
  readonly dataAccessExpiry: CredentialExpiry;
}

export interface CredentialResolutionSnapshot {
  readonly asset?: CredentialResolutionAsset;
  readonly candidates: readonly CredentialResolutionCandidate[];
}

export interface CredentialResolutionRepository {
  inspect(context: CredentialResolutionContext, policy: CredentialOperationPolicy): Promise<CredentialResolutionSnapshot>;
}

export interface CredentialOperationPolicyPort {
  findPolicy(context: CredentialOperationPolicyContext): Promise<CredentialOperationPolicy | undefined>;
}

export interface CredentialResolutionAuthorizationPort {
  authorize(scope: VerifiedServiceTenantScope, tenantId: string): Promise<void>;
}

export type CredentialSelectionReason = 'DIRECT_ASSET_GRANT' | 'VERIFIED_ANCESTOR_GRANT';

/** Safe selection record for the later audit implementation; no secret or ciphertext fields exist here. */
export interface CredentialResolutionAuditEntry {
  readonly tenantId: string;
  readonly actorRef: string;
  readonly appConfigurationId: string;
  readonly environment: MetaEnvironment;
  readonly provider: 'META';
  readonly assetId: string;
  readonly authorizationId: string;
  readonly credentialId: string;
  readonly family: string;
  readonly operation: CredentialResolverOperation;
  readonly purpose: CredentialPurpose;
  readonly reason: CredentialSelectionReason;
  readonly policyVersion: number;
  readonly authorizationVersion: number;
  readonly credentialVersion: number;
  readonly correlationId: string;
}

export interface CredentialResolutionAuditPort {
  recordSelection(entry: CredentialResolutionAuditEntry): Promise<void>;
}

declare const credentialResolutionHandleBrand: unique symbol;

/** Opaque, in-process, one-use reference. It carries no credential IDs or secret material. */
export interface CredentialResolutionHandle {
  readonly [credentialResolutionHandleBrand]: true;
}

export interface CredentialResolutionResult {
  readonly handle: CredentialResolutionHandle;
  readonly status: 'READY';
  readonly capability: CredentialResolverOperation;
  readonly family: string;
  readonly purpose: CredentialPurpose;
}

export interface CredentialSecretExecutor {
  withCredential(
    input: CredentialBinding & CredentialVaultActor & { readonly operation: string },
    execute: (secret: string) => Promise<void>,
  ): Promise<void>;
}

export const CREDENTIAL_RESOLUTION_REPOSITORY = Symbol('CREDENTIAL_RESOLUTION_REPOSITORY');
export const CREDENTIAL_OPERATION_POLICY = Symbol('CREDENTIAL_OPERATION_POLICY');
export const CREDENTIAL_RESOLUTION_AUTHORIZATION = Symbol('CREDENTIAL_RESOLUTION_AUTHORIZATION');
export const CREDENTIAL_RESOLUTION_AUDIT = Symbol('CREDENTIAL_RESOLUTION_AUDIT');
